import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { summarizeGap } from "../../src/goal/gap-summary.js";
import { parseGoal, goalTemplate } from "../../src/goal/goal-file.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { type GapReport, measureGoal } from "../../src/goal/measure.js";
import { PROVENANCE_LIMITS, provenanceLines } from "../../src/goal/provenance.js";
import { buildReconcilerInput } from "../../src/goal/reconcile.js";
import { forbiddenTermsFor } from "../../src/work/seed-lint.js";
import { gitIn } from "../helpers/tmp.js";
import { setupGoal } from "../helpers/goal.js";

async function measured(fx: ReturnType<typeof setupGoal>): Promise<GapReport> {
  return (await measureGoal(fx.location, "g-fast", { runner: "host" })).report;
}

describe("measurement provenance", () => {
  it("names the revision, a clean tree, the directory contract and the limits", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const { provenance: p } = await measured(fx);
    expect(p).toMatchObject({
      revision: gitIn(fx.repo, "rev-parse", "HEAD").trim(),
      tree: "clean",
      changed_paths: 0,
      working_directory: "repository root (host, no isolation)",
      limits: PROVENANCE_LIMITS,
    });
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(p.captured_at))).toBe(false);
  });

  it("reports a dirty tree with a count and a different fingerprint", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const clean = await measured(fx);
    writeFileSync(join(fx.repo, "scratch.txt"), "x\n");
    writeFileSync(join(fx.repo, "scratch2.txt"), "y\n");
    const dirty = await measured(fx);
    expect(dirty.provenance).toMatchObject({ tree: "dirty", changed_paths: 2, revision: clean.provenance.revision });
    expect(dirty.provenance.fingerprint).not.toBe(clean.provenance.fingerprint);
  });

  it("keeps the ledger's input_sha256 equal to the report fingerprint, with the payload keys unchanged", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const report = await measured(fx);
    const events = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "metric.measured");
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.payload.input_sha256).toBe(report.provenance.fingerprint);
      expect(Object.keys(event.payload).sort()).toEqual(
        [
          "goal_id",
          "input_sha256",
          "isolation",
          "lock_sha256",
          "metric_id",
          "needs_reapproval",
          "regime",
          "runner",
          "unit",
          "value",
        ].sort(),
      );
    }
  });

  it("holds no path of the machine", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "scratch.txt"), "x\n");
    const { provenance } = await measured(fx);
    const text = JSON.stringify(provenance) + provenanceLines(provenance).join("\n");
    expect(text).not.toContain(fx.repo);
    expect(text).not.toContain(fx.home);
    expect(text).not.toContain("scratch.txt");
  });

  it("cannot see an edit to a file that was already modified (the stated limit)", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "README.md"), "# first edit\n");
    const before = await measured(fx);
    writeFileSync(join(fx.repo, "README.md"), "# second edit, different content\n");
    const after = await measured(fx);
    expect(after.provenance.fingerprint).toBe(before.provenance.fingerprint);
    expect(provenanceLines(after.provenance).join("\n")).toMatch(/not file contents/);
  });

  it("prints a human block with a short revision, dirty state, directory and limits", () => {
    const lines = provenanceLines({
      revision: "0123456789abcdef0123456789abcdef01234567",
      tree: "dirty",
      changed_paths: 3,
      fingerprint: "f".repeat(64),
      captured_at: "2026-10-19T00:00:00.000Z",
      working_directory: "/work (repository root, read-only mount)",
      limits: PROVENANCE_LIMITS,
    });
    expect(lines[0]).toBe(
      "measured at revision 0123456789ab (dirty, 3 changed paths), observed 2026-10-19T00:00:00.000Z",
    );
    expect(lines[1]).toBe("working directory: /work (repository root, read-only mount)");
    expect(lines[2]).toContain("input_sha256");
    expect(lines.filter((l) => l.startsWith("limit: "))).toHaveLength(PROVENANCE_LIMITS.length);
  });
});

describe("reconciler-visible input does not change with provenance", () => {
  it("builds the same summary and the same input whatever the provenance holds, and never carries it", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "scratch.txt"), "x\n");
    const report = await measured(fx);
    const altered: GapReport = {
      ...report,
      provenance: {
        ...report.provenance,
        revision: "c".repeat(40),
        tree: "clean",
        changed_paths: 0,
        fingerprint: "d".repeat(64),
        captured_at: "2000-01-01T00:00:00.000Z",
      },
    };
    expect(summarizeGap(altered, "build")).toEqual(summarizeGap(report, "build"));
    const { summary } = summarizeGap(report, "build");
    if (summary === null) throw new Error("expected a gap trigger");

    const doc = parseGoal(goalTemplate("g-x").replace(/m-replace-me/g, "m-p95"));
    const build = (s: typeof summary): ReturnType<typeof buildReconcilerInput> =>
      buildReconcilerInput({
        front: doc.front,
        body: doc.body,
        summary: s,
        items: [],
        tracked: ["src/a.ts"],
        watchedGlobs: [],
        terms: forbiddenTermsFor(doc.front),
        cap: 2,
        recent: { success: 0, flawed: 0, blocked: 0, manual: 0 },
      });
    const input = JSON.stringify(build(summary));
    expect(JSON.stringify(build(summarizeGap(altered, "build").summary ?? summary))).toBe(input);
    for (const secret of [
      report.provenance.revision,
      report.provenance.revision.slice(0, 12),
      report.provenance.fingerprint,
      report.provenance.captured_at,
      "provenance",
      "fingerprint",
      "revision",
      "dirty",
    ]) {
      expect(input).not.toContain(secret);
    }
    // Keys of the summary the model can be given: unchanged by this feature.
    expect(Object.keys(summary).sort()).toEqual(["breach", "gap", "trigger"]);
    expect(readFileSync(join(fx.repo, "scratch.txt"), "utf8")).toBe("x\n");
  });
});
