import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuditSurface,
  SURFACE_KINDS,
  type SurfaceKind,
  scanCanaries,
  textSurface,
} from "../../src/audit/canary-scan.js";
import { evaluateGate3, measuredFrom } from "../../src/gate/gate3.js";
import { branchRef } from "../../src/git/user-repo.js";
import { promptSurface, workspaceSurface } from "../../src/implementer/surfaces.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { cleanAudit } from "../helpers/gate3-parts.js";
import { RUN_ID, type StubPlan, found, lineStarter, startedContainers } from "../helpers/implementer-e2.js";
import { auditCandidate, auditOf, classifyStop, gate3Of } from "../helpers/implementer-s5.js";
import { classifyS5 } from "../helpers/s5-fixture.js";
import { gitIn, makeTempDir } from "../helpers/tmp.js";

// WIRING ONLY. This is not E6 (the real model, told to find the scenarios in a real container, is the gated
// `G-e6-l2-leak-redteam`, not enforced until a run is recorded) and it proves nothing about isolation: the container
// is a local directory behind a fake daemon. What it proves is that the implementer station and the audit notice a
// vault canary wherever a stub plants one, and that no such round ends in success (spec §5.5, §5.6).

const start = lineStarter();

const publishedRefs = (repo: string): string =>
  gitIn(repo, "for-each-ref", "--format=%(refname)", "refs/heads/omf").trim();

/** Six surfaces, all clean except `kind`, which is `surface`. */
const cleanExcept = (kind: SurfaceKind, surface: AuditSurface): AuditSurface[] =>
  SURFACE_KINDS.map((each) => (each === kind ? surface : textSurface(each, "nothing to see")));

interface Stop {
  name: string;
  plan: (canary: string) => StubPlan;
}
const STOPS: Stop[] = [
  { name: "a committed file", plan: (canary) => ({ code: { path: "notes.txt", text: canary } }) },
  {
    name: "a commit that a later commit removes",
    plan: (canary) => ({ code: { path: "notes.txt", text: canary }, removeAgain: true }),
  },
  // The capture of `work`, `tmp` and `agent` is scanned together with the exported tree, before anything is published.
  { name: "an uncommitted file under the container's temp directory", plan: (canary) => ({ scratch: canary }) },
];

interface Landed {
  name: string;
  surface: "implementer_log";
  plan: (canary: string) => StubPlan;
}
const LANDED: Landed[] = [
  { name: "the session log only", surface: "implementer_log", plan: (canary) => ({ say: canary }) },
];

describe("E6-station-smoke (wiring only; not E6, not isolation)", () => {
  it.each(STOPS)("stops before publishing when the canary is in $name", async ({ plan }) => {
    const line = await start({ plan });
    const out = await line.stations.S3.run(line.ctx(1));

    expect(out).toEqual({ kind: "blocked", reason_code: "gate_blocked" });
    expect(publishedRefs(line.repo), "nothing was published").toBe("");
    expect(existsSync(join(line.item.dir, "runs", RUN_ID, "implementer-stage", "round-1")), "no stage left").toBe(
      false,
    );
    expect(ledgerEvents(line.l.f.fx, "implementer.candidate_checked").map((event) => event.payload)).toEqual([
      expect.objectContaining({ scan: "canary", published: false }),
    ]);
    expect(readFileSync(line.l.f.fx.ledger.file, "utf8")).not.toContain(line.entry.canary);
    expect(classifyStop("gate_blocked")).toMatchObject({ outcome: "blocked", reason_code: "gate_blocked" });
  });

  it.each(LANDED)("publishes, then the audit finds the canary on the $surface surface ($name)", async (variant) => {
    const line = await start({ plan: variant.plan });
    const ctx = line.ctx(1);
    expect(await line.stations.S3.run(ctx)).toMatchObject({ kind: "ok" });
    expect(publishedRefs(line.repo), "the branch carries commits only").toBe(branchRef(line.workId));
    expect(ledgerEvents(line.l.f.fx, "implementer.candidate_checked").map((event) => event.payload)).toEqual([
      expect.objectContaining({ scan: "clean", published: true }),
    ]);

    expect(await auditCandidate(line, ctx)).toMatchObject({ kind: "ok" });

    expect(auditOf(line, ctx)?.canary).toMatchObject({
      status: "scanned",
      hits: [{ surface: variant.surface, count: 1 }],
      total: 1,
    });
    const moved = ledgerEvents(line.l.f.fx, "scenario.status_changed");
    expect(moved).toHaveLength(1);
    expect(moved[0]?.payload).toMatchObject({
      seal_id: line.entry.seal_id,
      scenario_ref: line.entry.scenario_ref,
      status: "contaminated",
      reason: "canary_hit",
    });
    const gate3 = gate3Of(line, ctx);
    expect(gate3.passed).toBe(false);
    expect(gate3.failed).toContain("canary_hit");
    expect(classifyS5(ctx.inputs)).toMatchObject({
      outcome: "flawed",
      rule: "audit_flag",
      recommendation: "not_recommended",
    });
  });

  it("stops a canary in the released feedback before any container exists, and the audit counts it on the prompt surface", async () => {
    const line = await start();
    // Feedback only reaches the prompt from round 2 on.
    line.released.push(`- interface: 33% of 6 scenarios ${line.entry.canary}`);

    const out = await line.stations.S3.run(line.ctx(2));

    expect(out).toEqual({ kind: "blocked", reason_code: "gate_blocked" });
    expect(startedContainers(line.fake)).toEqual([]);
    expect(line.requests).toHaveLength(0);
    // The same text on the surface the audit reads: found on `prompt` and nowhere else.
    const scan = await scanCanaries([line.entry.canary], cleanExcept("prompt", promptSurface([...line.released])));
    expect(scan).toMatchObject({ status: "scanned", hits: [{ surface: "prompt", count: 1 }], total: 1 });
    expect(found(JSON.stringify(ledgerEvents(line.l.f.fx)), [line.entry.canary])).toEqual([]);
  });

  it("makes an incomplete capture a scan that did not run, which GATE-3 fails closed", async () => {
    const canary = "omf-canary-0123456789abcdef";
    const capture = (complete: boolean): AuditSurface =>
      workspaceSurface({
        treeDir: makeTempDir("omf-e6-tree-"),
        capture: { bytes: Buffer.from("nothing planted here"), complete },
      });
    const gate3 = async (complete: boolean) => {
      const scan = await scanCanaries([canary], cleanExcept("worktree", capture(complete)));
      const measured = measuredFrom({
        audit: cleanAudit({ canary: scan }),
        gates: null,
        contradiction: null,
        isolation: null,
        declared: "L2",
      });
      return { scan, measured, result: evaluateGate3(measured) };
    };

    const whole = await gate3(true);
    expect(whole.scan.status).toBe("scanned");
    expect(whole.measured.canary, "control: a complete clean capture reads clean").toBe("clean");

    const cut = await gate3(false);
    expect(cut.scan).toMatchObject({ status: "not_run", truncated: true });
    expect(cut.measured.canary).toBe("not_run");
    expect(cut.result.passed).toBe(false);
    expect(cut.result.failed).toContain("canary_not_scanned");
  });
});
