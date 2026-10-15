import { describe, expect, it } from "vitest";
import { evaluateGate1 } from "../../src/decision/gate1.js";
import { scenarioLinkCoverage } from "../../src/decision/lint.js";
import type { DecisionState } from "../../src/decision/types.js";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { HUMAN, NOW, addOpen, closeInterface, reportAt, resolveOpen, setupDecisionItem } from "../helpers/decision-fixture.js";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../src/core/ledger.js";
import { resolveProject } from "../../src/core/paths.js";
import { WORK_STARTED_EVENT } from "../../src/scenario/events.js";
import { runS2ThenGate2 } from "../../src/seal/station.js";
import { openVault } from "../../src/vault/vault.js";
import { W_EVENT_TYPES, newRunId, wEvent } from "../../src/work/w-events.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { ROUND1, ROUND2, appendWorkStarted, passDeps, prompts, sealStored, setupLine, tamperSet, writeYaml } from "../helpers/line-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §5.0: GATE-1 (decisions) and GATE-2 (seal) are different gates. The scenario-link rule belongs to GATE-2.
// If GATE-1 also asked for links, no item could ever reach S2, where the scenarios are written: a deadlock.
// This guards that, with a local GATE-2 stub standing in for the real one.

type Gate2Stub =
  | { status: "pass"; not_run: string[] }
  | { status: "back_to_S2"; unlinked: string[]; not_run: string[] };

/** What GATE-2 will do with the link rule (M3c): unlinked non-quantitative decisions send the item back to S2. */
function gate2Stub(state: DecisionState, linked: ReadonlySet<string>): Gate2Stub {
  const { unlinked, not_run } = scenarioLinkCoverage(state, linked);
  return unlinked.length === 0 ? { status: "pass", not_run } : { status: "back_to_S2", unlinked, not_run };
}

describe("W-gate1-then-gate2-walk", () => {
  it("passes GATE-1 with nothing linked, and only the GATE-2 stub asks for links", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache", "compatibility");
    resolveOpen(f, "d-cache");
    runDecideAdd(f.fx.location, f.workId, { id: "d-latency", class: "latency", question: "How fast must a lookup be?" }, "omf");
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-latency",
      {
        choice: "Bounded lookup time",
        rationale: "Callers wait on it.",
        rejected: [],
        response_measure: { metric: "cache lookup time", op: "<=", threshold: 40, unit: "ms", percentile: 95, window: null },
      },
      HUMAN,
    );

    const report = reportAt(f, NOW);
    expect(report.gate).toEqual({ status: "pass" });
    expect(report.problems.filter((p) => p.code === "unlinked")).toEqual([]);
    expect(evaluateGate1.length, "GATE-1 takes (state, now, ctx) and no link input").toBe(3);

    const coverage = scenarioLinkCoverage(report.state, new Set<string>());
    expect(coverage.unlinked).toEqual(expect.arrayContaining(["d-cache", "d-interface"]));
    expect(coverage.unlinked).not.toContain("d-latency");
    expect(coverage.not_run, "quantitative decisions are not_run, never unlinked and never success").toEqual(["d-latency"]);

    const back = gate2Stub(report.state, new Set<string>());
    expect(back.status).toBe("back_to_S2");
    expect(gate2Stub(report.state, new Set(coverage.unlinked))).toEqual({ status: "pass", not_run: ["d-latency"] });
  });

  it("walks GATE-1, seal, GATE-2 back to S2 for the unlinked ids, a re-seal, and GATE-2 pass with the quantitative decision not_run", async () => {
    const l = setupLine();
    expect(reportAt(l.f, NOW).gate).toEqual({ status: "pass" });

    const first = await runS2ThenGate2(passDeps(l, writeYaml(l, "r1.yaml", ROUND1)));
    if (first.status !== "back_to_S2") throw new Error(`expected back_to_S2, got ${first.status}`);
    expect(first.seal).toBe("stored");
    expect(first.feedback?.unlinked_decision_ids, "only the unlinked decision comes back, not the quantitative one").toEqual(["d-cache"]);

    const second = await runS2ThenGate2(passDeps(l, writeYaml(l, "r2.yaml", ROUND2), first.feedback ?? undefined));
    expect(second).toMatchObject({ status: "pass", seal: "stored", not_run: ["d-latency"] });

    const evaluated = ledgerEvents(l.f.fx, "gate2.evaluated").map((e) => [e.payload.status, e.payload.not_run_decision_ids]);
    expect(evaluated).toEqual([["fail", ["d-latency"]], ["pass", ["d-latency"]]]);
    expect(ledgerEvents(l.f.fx, "seal.completed").map((e) => e.payload.round)).toEqual([1, 2]);
    expect(prompts(l)[1], "the re-seal prompt names the unlinked decision").toContain("d-cache");
  });

  it("restarts after a killed run from the existing seal: no author call, no loop", async () => {
    const l = setupLine();
    const yaml = writeYaml(l, "r2.yaml", ROUND2);
    await sealStored(l, yaml);
    appendWorkStarted(l);
    const again = await runS2ThenGate2(passDeps(l, yaml));
    expect(again).toMatchObject({ status: "pass", seal: "reused" });
    expect(prompts(l)).toHaveLength(1);
    expect(ledgerEvents(l.f.fx, "seal.completed")).toHaveLength(1);
  });

  it("ends the line at J3 on a set edited after the start, instead of resealing", async () => {
    const l = setupLine();
    const yaml = writeYaml(l, "r2.yaml", ROUND2);
    const sealId = await sealStored(l, yaml);
    appendWorkStarted(l);
    tamperSet(l, sealId);
    const out = await runS2ThenGate2(passDeps(l, yaml));
    expect(out).toEqual({ status: "stop", route: "J3", code: "set_tampered" });
    expect(prompts(l)).toHaveLength(1);
    expect(ledgerEvents(l.f.fx, "seal.requested")).toHaveLength(1);
  });

  it("uses the event type M3b1 writes for a start", () => {
    expect(W_EVENT_TYPES).toContain(WORK_STARTED_EVENT);
    const event = wEvent({
      type: "work.started",
      payload: { goal_id: "g-x", work_id: "w-0123456789ab", run_id: newRunId(NOW, () => "0000"), from: "ready" },
    });
    expect(event.type).toBe(WORK_STARTED_EVENT);
  });

  it("runs whole through an OMF_HOME reached by a symlink", async () => {
    const l = setupLine();
    const link = join(makeTempDir("omf-link-"), "omf");
    symlinkSync(join(l.f.fx.home, ".omf"), link);
    const env = { OMF_HOME: link };
    const location = resolveProject(l.f.fx.repo, env);
    const deps = { ...passDeps(l, writeYaml(l, "r2.yaml", ROUND2)), location, env, ledger: new Ledger(location.dir), vault: openVault(location, env) };
    expect(await runS2ThenGate2(deps)).toMatchObject({ status: "pass", seal: "stored", not_run: ["d-latency"] });
  });
});
