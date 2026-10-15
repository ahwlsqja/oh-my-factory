import { describe, expect, it } from "vitest";
import { evaluateGate1 } from "../../src/decision/gate1.js";
import { scenarioLinkCoverage } from "../../src/decision/lint.js";
import type { DecisionState } from "../../src/decision/types.js";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { HUMAN, NOW, addOpen, closeInterface, reportAt, resolveOpen, setupDecisionItem } from "../helpers/decision-fixture.js";
import { symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Ledger } from "../../src/core/ledger.js";
import { resolveProject } from "../../src/core/paths.js";
import { WORK_STARTED_EVENT } from "../../src/scenario/events.js";
import { s2Station } from "../../src/seal/s2-station.js";
import { createCommandAuthor } from "../../src/seal/session.js";
import { runS2ThenGate2 } from "../../src/seal/station.js";
import { runDecideDefer } from "../../src/cli/decide.js";
import { runLine } from "../../src/work/sequencer.js";
import { fakeClock } from "../helpers/tick.js";
import { cleanStations, finished, passGate, station } from "../helpers/line.js";
import { openVault } from "../../src/vault/vault.js";
import { W_EVENT_TYPES, newRunId, wEvent } from "../../src/work/w-events.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { type LineFixture, ROUND1, ROUND2, appendWorkStarted, passDeps, plantCanary, prompts, sealStored, setupLine, tamperSet, writeYaml } from "../helpers/line-fixture.js";
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

// The same walk through the sequencer: S2 is the real station and GATE-2 is the real gate (only GATE-3 is a stand-in).
const AUTHOR_STUB_PATH = fileURLToPath(new URL("../helpers/line-author-stub.mjs", import.meta.url));

/** An author that prints the n-th file on its n-th call (the last one from then on), logging every prompt like the line stub. */
function sequencedAuthor(l: LineFixture, files: readonly string[]) {
  let calls = 0;
  return {
    ...createCommandAuthor({ command: [process.execPath, AUTHOR_STUB_PATH, files[0] ?? "", l.promptLog], timeoutMs: 20_000 }),
    async run(request: Parameters<ReturnType<typeof createCommandAuthor>["run"]>[0]) {
      const file = files[Math.min(calls, files.length - 1)] ?? "";
      calls += 1;
      return createCommandAuthor({ command: [process.execPath, AUTHOR_STUB_PATH, file, l.promptLog], timeoutMs: 20_000 }).run(request);
    },
  };
}

function lineStations(l: LineFixture, files: readonly string[], trace: string[], override: Parameters<typeof cleanStations>[0] = {}) {
  const s2 = s2Station({ location: l.f.fx.location, session: sequencedAuthor(l, files), ids: l.ids, timeoutMs: 20_000 });
  const spy = { id: "S2" as const, run: (ctx: Parameters<typeof s2.run>[0]) => (trace.push("S2"), s2.run(ctx)) };
  return cleanStations({ ...override, override: { S2: spy, ...(override.override ?? {}) } });
}

describe("W-gate1-then-gate2-walk through runLine", () => {
  const gates = { "GATE-3": passGate("GATE-3") };

  it("sends GATE-2 back to S2 for the unlinked ids, the next S2 prompt carries exactly those, then GATE-2 passes and the line reaches S3", async () => {
    const l = setupLine();
    const trace: string[] = [];
    const stations = lineStations(l, [writeYaml(l, "r1.yaml", ROUND1), writeYaml(l, "r2.yaml", ROUND2)], trace, {
      override: { S3: station("S3", () => (trace.push("S3"), { kind: "ok" })) },
    });
    const result = finished(await runLine({ location: l.f.fx.location, workId: l.f.workId, stations, gates }));

    expect(trace).toEqual(["S2", "S2", "S3"]);
    expect(result.evidence.gates.history.filter((h) => h.gate === "GATE-2").map((h) => h.verdict)).toEqual(["fail", "pass"]);
    const second = prompts(l)[1] ?? "";
    expect(second).toContain("- unlinked decision: d-cache");
    expect(second.match(/- unlinked decision: .*/g)).toEqual(["- unlinked decision: d-cache"]);
    expect(second).toContain("- weak scenarios: 0");
    expect(ledgerEvents(l.f.fx, "seal.completed").map((e) => e.payload.round)).toEqual([1, 2]);
    expect(ledgerEvents(l.f.fx, "work.started")).toHaveLength(1);
  });

  it("restarts a started item on the standing seal: no author call, and GATE-1 is not raised again after a deferral ran out", async () => {
    const l = setupLine();
    const clock = fakeClock();
    const HOUR = 3_600_000;
    addOpen(l.f, "d-later");
    runDecideDefer(
      l.f.fx.location,
      l.f.workId,
      "d-later",
      { owner: "dev", reason: "Waiting on a benchmark.", revisit_trigger: "After the benchmark.", default: "Keep the current behavior.", expires_at: new Date(clock.now().getTime() + HOUR).toISOString() },
      HUMAN,
      clock.now(),
    );
    const yaml = writeYaml(l, "r2.yaml", ROUND2);
    const trace: string[] = [];
    const block = station("S3", () => ({ kind: "blocked", reason_code: "gate_blocked" }));
    const first = finished(await runLine({ location: l.f.fx.location, workId: l.f.workId, now: clock.now, stations: lineStations(l, [yaml], trace, { override: { S3: block } }), gates }));
    expect(first).toMatchObject({ outcome: "blocked", reason_code: "gate_blocked" });
    clock.advance(2 * HOUR);

    const second = finished(await runLine({ location: l.f.fx.location, workId: l.f.workId, now: clock.now, stations: lineStations(l, [yaml], trace), gates }));
    expect(second.reason_code).not.toBe("j2_open");
    expect(second.evidence.gates.history).toContainEqual({ gate: "GATE-1", verdict: "pass", reasons: ["already_started"] });
    expect(prompts(l)).toHaveLength(1);
    expect(ledgerEvents(l.f.fx, "seal.requested")).toHaveLength(1);
    expect(ledgerEvents(l.f.fx, "seal.completed")).toHaveLength(1);
  });

  it("stops blocked gate_blocked (J7) before S4 when a canary-shaped file appears in the repository after S3", async () => {
    const l = setupLine();
    const trace: string[] = [];
    const stations = lineStations(l, [writeYaml(l, "r2.yaml", ROUND2)], trace, {
      override: {
        S3: station("S3", () => (plantCanary(l.f.fx.repo), { kind: "ok" })),
        S4: station("S4", () => (trace.push("S4"), { kind: "ok" })),
      },
    });
    const result = finished(await runLine({ location: l.f.fx.location, workId: l.f.workId, stations, gates }));
    expect(trace).not.toContain("S4");
    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate_blocked" });
    expect(result.handoff?.decision_required.j).toBe("J7");
  });

  it("ends a resumed item whose GATE-2 returns back_to_S2 at J3, without a new seal request or a second S2 visit", async () => {
    const l = setupLine();
    const trace: string[] = [];
    // Round 1 links only d-interface; GATE-2 is stood in for so the item starts, then S3 blocks and leaves it in_progress.
    const yaml = writeYaml(l, "r1.yaml", ROUND1);
    const block = station("S3", () => ({ kind: "blocked", reason_code: "gate_blocked" }));
    const first = finished(await runLine({
      location: l.f.fx.location,
      workId: l.f.workId,
      stations: lineStations(l, [yaml], trace, { override: { S3: block } }),
      gates: { "GATE-2": passGate("GATE-2"), "GATE-3": passGate("GATE-3") },
    }));
    expect(first.reason_code).toBe("gate_blocked");
    const requested = ledgerEvents(l.f.fx, "seal.requested").length;
    const evaluated = ledgerEvents(l.f.fx, "gate2.evaluated").length;
    trace.length = 0;

    const second = finished(await runLine({ location: l.f.fx.location, workId: l.f.workId, stations: lineStations(l, [yaml], trace), gates }));

    expect(second).toMatchObject({ outcome: "blocked", reason_code: "scenarios_need_review" });
    expect(second.handoff?.decision_required.j).toBe("J3");
    expect(trace).toEqual(["S2"]);
    expect(ledgerEvents(l.f.fx, "seal.requested")).toHaveLength(requested);
    expect(ledgerEvents(l.f.fx, "gate2.evaluated")).toHaveLength(evaluated + 1);
  });
});
