import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { summarizeGap } from "../../src/goal/gap-summary.js";
import { parseGoal, goalTemplate } from "../../src/goal/goal-file.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { type GapReport, measureGoal } from "../../src/goal/measure.js";
import { PROVENANCE_LIMITS, provenanceLines, provenanceOf } from "../../src/goal/provenance.js";
import { buildReconcilerInput } from "../../src/goal/reconcile.js";
import { readUiSnapshot } from "../../src/ui/read-model.js";
import { forbiddenTermsFor } from "../../src/work/seed-lint.js";
import { commitAll, gitIn } from "../helpers/tmp.js";
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

  it("retains provenance for a failed target without publishing its private report or changing successful events", async () => {
    const fx = setupGoal();
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 0\nexit 2\n");
    commitAll(fx.repo, "make the target command fail after printing zero");
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "private-measurement.txt"), "PRIVATE_CANARY_987654321\n");
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 9, 19, 0, 0, 0) + tick++ * 1000);
    const { report, file } = await measureGoal(fx.location, "g-fast", { runner: "host", now });
    expect(report.target).toMatchObject({ measured: null, result: null });
    expect(report.metrics[0]).toMatchObject({ value: null, failure_code: "nonzero_exit", failure: "exit code 2" });
    expect(report.provenance).toMatchObject({
      revision: gitIn(fx.repo, "rev-parse", "HEAD").trim(),
      tree: "dirty",
      changed_paths: 1,
      captured_at: "2026-10-19T00:00:01.000Z",
      working_directory: "repository root (host, no isolation)",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(report);

    const events = new Ledger(fx.location.dir).readVerified();
    expect(events.find((e) => e.type === "metric.measure_failed")?.payload).toMatchObject({
      metric_id: "m-p95",
      reason_code: "nonzero_exit",
    });
    expect(events.find((e) => e.type === "goal.measured")?.payload.target_met).toBeNull();
    const successes = events.filter((e) => e.type === "metric.measured");
    expect(successes).toHaveLength(1);
    expect(successes[0]?.payload).toMatchObject({ metric_id: "m-errors", input_sha256: report.provenance.fingerprint });
    expect(Object.keys(successes[0]?.payload ?? {}).sort()).toEqual(
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

    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.goals[0]).toMatchObject({ audit_state: "approved", gap: null });
    const visible = JSON.stringify(snapshot);
    for (const privateValue of [
      "PRIVATE_CANARY_987654321",
      "m-p95",
      "nonzero_exit",
      report.provenance.revision,
      report.provenance.fingerprint,
      report.provenance.captured_at,
      file,
      fx.repo,
      fx.home,
    ]) {
      expect(visible).not.toContain(privateValue);
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

  it("states the read-only /work mount for a Docker run without running Docker", () => {
    const p = provenanceOf(
      { head: "a".repeat(40), changedPaths: 0, fingerprint: "b".repeat(64) },
      new Date("2026-10-19T00:00:00.000Z"),
      "docker",
    );
    expect(p.working_directory).toBe("/work (repository root, read-only mount)");
    expect(p.tree).toBe("clean");
    expect(provenanceLines(p)).toContain("working directory: /work (repository root, read-only mount)");
  });

  it("takes the capture time when the tree is observed, before any metric runs", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 9, 19, 0, 0, 0) + tick++ * 1000);
    const { report } = await measureGoal(fx.location, "g-fast", { runner: "host", now });
    const events = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "metric.measured");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(Date.parse(report.provenance.captured_at)).toBeLessThan(Date.parse(event.ts));
    }
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
