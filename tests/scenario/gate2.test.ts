import { describe, expect, it, vi } from "vitest";
import {
  GATE2_REASON_CODES,
  GATE2_ROUTE_OF,
  evaluateGate2,
  runGate2,
  runGate2Probes,
  gate2EventFor,
  scenarioAggregate,
  sealFeedbackFor,
} from "../../src/scenario/gate2.js";
import type { Gate2Result, ScenarioAggregate } from "../../src/scenario/gate2.js";
import { validateDef } from "../../src/core/schema.js";
import { SCOPE } from "../helpers/decision.js";
import type { Gate2Input, Gate2ReasonCode, Gate2Route } from "../../src/scenario/gate2.js";
import { EXPOSURE_LIMIT } from "../../src/scenario/types.js";
import { EXPOSURE_LIMIT_DEFAULT } from "../../src/feedback/types.js";
import type { WorkItem } from "../../src/work/types.js";
import {
  DECISIONS_DIGEST,
  baselineScenarios,
  effective,
  passingInput,
  pick,
  rebuild,
  refOf,
  sha,
  setProbe,
} from "../helpers/gate2-input.js";

const blockGate1 = (i: Gate2Input): Gate2Input => ({ ...i, gate1: { status: "blocked_on_user", j: "J2", reasons: [{ code: "interface_missing" }] } });
const addAnomalies = (i: Gate2Input): Gate2Input => ({ ...i, anomalies: 2 });
const probeError = (i: Gate2Input): Gate2Input =>
  setProbe(i, "null_error", pick(i, "behavior", "train"), "error", "fixture_hash_mismatch");
const nullPasses = (i: Gate2Input): Gate2Input => setProbe(i, "null_empty", pick(i, "behavior", "test"), "pass");
const echoPasses = (i: Gate2Input): Gate2Input => setProbe(i, "echo", pick(i, "contradiction_canary"), "pass");
/** The same scenarios without any contradiction canary (owner decision O-2: GATE-2 requires at least one). */
const withoutCanaries = (list: ReturnType<typeof baselineScenarios>): ReturnType<typeof baselineScenarios> =>
  list.filter((e) => e.scenario.kind !== "contradiction_canary");
/** Drops the d-cache link: the test-split behavior scenario names nothing. */
const unlink = (i: Gate2Input): Gate2Input =>
  rebuild(i, [
    effective({ kind: "behavior", split: "train", refs: ["d-interface"] }),
    effective({ kind: "behavior", split: "test", refs: [] }),
    effective({ kind: "contradiction_canary", split: "train" }),
  ]);

interface Row {
  name: string;
  code: Gate2ReasonCode;
  route: Gate2Route;
  /** Every reason the row produces, in order. Exact on purpose: no row may fail for a second, unnoticed cause. */
  exact: Gate2ReasonCode[];
  make: () => Gate2Input;
}

const ROWS: Row[] = [
  { name: "gate1 not passing", code: "gate1_not_passing", route: "J2", exact: ["gate1_not_passing"], make: () => blockGate1(passingInput()) },
  { name: "ledger anomaly", code: "ledger_anomaly", route: "J3", exact: ["ledger_anomaly"], make: () => addAnomalies(passingInput()) },
  {
    name: "no seal",
    code: "seal_missing",
    route: "back_to_S2",
    exact: ["seal_missing"],
    make: () => ({ ...passingInput(), seal: null, set: null, effective: [], probes: null, order: { ok: false, reason: "no_seal" } }),
  },
  {
    name: "seal after start",
    code: "seal_after_start",
    route: "J3",
    exact: ["seal_after_start"],
    make: () => ({ ...passingInput(), order: { ok: false, reason: "seal_after_start" } }),
  },
  {
    name: "set dir missing",
    code: "set_missing",
    route: "J3",
    exact: ["set_missing"],
    make: () => ({ ...passingInput(), set: { ok: false, reason: "set_missing" }, effective: [], probes: null }),
  },
  {
    name: "set unreadable",
    code: "set_unreadable",
    route: "J3",
    exact: ["set_unreadable"],
    make: () => ({ ...passingInput(), set: { ok: false, reason: "symlink_refused" }, effective: [], probes: null }),
  },
  {
    name: "set digest differs",
    code: "set_tampered",
    route: "J3",
    exact: ["set_tampered"],
    make: () => {
      const input = passingInput();
      if (input.set === null || !input.set.ok) throw new Error("baseline set must be ok");
      return { ...input, set: { ...input.set, set_sha256: sha("edited") } };
    },
  },
  {
    name: "extra file in the set dir",
    code: "set_tampered",
    route: "J3",
    exact: ["set_tampered"],
    make: () => ({ ...passingInput(), set: { ok: false, reason: "extra_entry" }, effective: [], probes: null }),
  },
  {
    name: "decisions changed after the seal",
    code: "decisions_drifted",
    route: "back_to_S2",
    exact: ["decisions_drifted"],
    make: () => ({ ...passingInput(), decisionsDigest: sha("other decisions") }),
  },
  {
    name: "no scenarios",
    code: "no_active_scenarios",
    route: "back_to_S2",
    exact: ["no_active_scenarios", "split_missing", "split_missing", "canary_missing", "unlinked_decisions"],
    make: () => rebuild(passingInput(), []),
  },
  {
    name: "no test behavior scenario",
    code: "split_missing",
    route: "back_to_S2",
    exact: ["split_missing"],
    make: () =>
      rebuild(passingInput(), [
        effective({ kind: "behavior", split: "train", refs: ["d-interface", "d-cache"] }),
        effective({ kind: "contradiction_canary", split: "train" }),
      ]),
  },
  {
    name: "no contradiction canary in the set",
    code: "canary_missing",
    route: "back_to_S2",
    exact: ["canary_missing"],
    make: () => rebuild(passingInput(), withoutCanaries(baselineScenarios())),
  },
  {
    name: "lint problems",
    code: "scenario_invalid",
    route: "back_to_S2",
    exact: ["scenario_invalid"],
    make: () => ({
      ...passingInput(),
      problems: [
        { code: "decision_quantitative", scenario_ref: "0123456789abcdef", decision_id: "d-latency" },
        { code: "expect_empty", scenario_ref: "fedcba9876543210" },
      ],
    }),
  },
  {
    name: "two behavior scenarios demand different exits",
    code: "contradiction",
    route: "back_to_S2",
    exact: ["contradiction"],
    make: () => rebuild(passingInput(), [...baselineScenarios(), effective({ kind: "behavior", split: "train", refs: ["d-cache"], exit: 2 })]),
  },
  {
    name: "train split exposure at the limit",
    code: "exposure_exhausted",
    route: "J3",
    exact: ["exposure_exhausted"],
    make: () => ({ ...passingInput(), exposure: { train: EXPOSURE_LIMIT, test: 0 } }),
  },
  {
    name: "test split exposure over the limit",
    code: "exposure_exhausted",
    route: "J3",
    exact: ["exposure_exhausted"],
    make: () => ({ ...passingInput(), exposure: { train: 0, test: EXPOSURE_LIMIT + 1 } }),
  },
  { name: "a probe errored", code: "probe_error", route: "J7", exact: ["probe_error"], make: () => probeError(passingInput()) },
  { name: "no probes at all", code: "probe_error", route: "J7", exact: ["probe_error"], make: () => ({ ...passingInput(), probes: null }) },
  { name: "null implementation passes", code: "null_impl_passes", route: "back_to_S2", exact: ["null_impl_passes"], make: () => nullPasses(passingInput()) },
  { name: "echo stub passes a canary", code: "judge_broken_or_gamed", route: "J3", exact: ["judge_broken_or_gamed"], make: () => echoPasses(passingInput()) },
  { name: "decision without a link", code: "unlinked_decisions", route: "back_to_S2", exact: ["unlinked_decisions"], make: () => unlink(passingInput()) },
];

describe("evaluateGate2", () => {
  it("passes the baseline with the quantitative decision as not_run, never as success", () => {
    const result = evaluateGate2(passingInput());
    expect(result.status).toBe("pass");
    if (result.status !== "pass") return;
    expect(result.not_run).toEqual(["d-latency"]);
    expect(result.aggregate.active).toBe(3);
  });

  it.each(ROWS)("$name gives $code and route $route", (row) => {
    const result = evaluateGate2(row.make());
    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.reasons.map((r) => r.code)).toEqual(row.exact);
    expect(result.reasons.map((r) => r.code)).toContain(row.code);
    expect(result.route).toBe(row.route);
  });

  it("has a row for every reason code", () => {
    expect(new Set(ROWS.map((r) => r.code))).toEqual(new Set(GATE2_REASON_CODES));
  });

  it("pins the route table (M3c-D21)", () => {
    expect(GATE2_ROUTE_OF).toEqual({
      gate1_not_passing: "J2",
      ledger_anomaly: "J3",
      seal_after_start: "J3",
      set_missing: "J3",
      set_unreadable: "J3",
      set_tampered: "J3",
      judge_broken_or_gamed: "J3",
      probe_error: "J7",
      seal_missing: "back_to_S2",
      decisions_drifted: "back_to_S2",
      no_active_scenarios: "back_to_S2",
      split_missing: "back_to_S2",
      canary_missing: "back_to_S2",
      scenario_invalid: "back_to_S2",
      contradiction: "back_to_S2",
      null_impl_passes: "back_to_S2",
      unlinked_decisions: "back_to_S2",
      exposure_exhausted: "J3",
    });
  });

  it("collects every reason in the documented order and routes by the most severe", () => {
    let input = addAnomalies(blockGate1(passingInput()));
    input = echoPasses(nullPasses(input));
    input = {
      ...input,
      order: { ok: false, reason: "seal_after_start" },
      decisionsDigest: sha("other"),
      problems: [{ code: "expect_empty", scenario_ref: "0123456789abcdef" }],
      exposure: { train: 0, test: EXPOSURE_LIMIT },
    };
    const result = evaluateGate2(input);
    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.reasons.map((r) => r.code)).toEqual([
      "gate1_not_passing",
      "ledger_anomaly",
      "seal_after_start",
      "decisions_drifted",
      "scenario_invalid",
      "exposure_exhausted",
      "null_impl_passes",
      "judge_broken_or_gamed",
    ]);
    expect(result.route).toBe("J2");
  });

  it.each([
    { label: "J2 beats J3", make: (i: Gate2Input) => echoPasses(blockGate1(i)), route: "J2" },
    { label: "J3 beats J7", make: (i: Gate2Input) => echoPasses(probeError(i)), route: "J3" },
    { label: "J3 beats back_to_S2", make: (i: Gate2Input) => addAnomalies(unlink(i)), route: "J3" },
    { label: "J7 beats back_to_S2", make: (i: Gate2Input) => nullPasses(probeError(i)), route: "J7" },
  ])("$label", ({ make, route }) => {
    const result = evaluateGate2(make(passingInput()));
    expect(result.status === "fail" && result.route).toBe(route);
  });

  it("carries counts, splits, ids and refusal codes on the reasons, and nothing else", () => {
    const anomaly = evaluateGate2(addAnomalies(passingInput()));
    expect(anomaly.status === "fail" && anomaly.reasons).toEqual([{ code: "ledger_anomaly", count: 2 }]);

    const exposed = evaluateGate2({ ...passingInput(), exposure: { train: 0, test: EXPOSURE_LIMIT } });
    expect(exposed.status === "fail" && exposed.reasons).toEqual([{ code: "exposure_exhausted", split: "test", count: EXPOSURE_LIMIT }]);

    const probed = evaluateGate2(probeError(passingInput()));
    expect(probed.status === "fail" && probed.reasons).toEqual([{ code: "probe_error", count: 1, refusal_codes: ["fixture_hash_mismatch"] }]);

    const unlinked = evaluateGate2(unlink(passingInput()));
    expect(unlinked.status === "fail" && unlinked.reasons).toEqual([{ code: "unlinked_decisions", count: 1, decision_ids: ["d-cache"] }]);
  });

  it("treats an exposure count that is not a finite number as exhausted", () => {
    const result = evaluateGate2({ ...passingInput(), exposure: { train: Number.NaN, test: 0 } });
    expect(result.status === "fail" && result.reasons.map((r) => r.code)).toEqual(["exposure_exhausted"]);
  });

  it("ignores a lint problem coded contradiction: the contradiction reason comes from the scenarios", () => {
    const result = evaluateGate2({ ...passingInput(), problems: [{ code: "contradiction", scenario_ref: "0123456789abcdef" }] });
    expect(result.status).toBe("pass");
  });

  it("fails a set with zero contradiction canaries with canary_missing, and the same set plus one canary passes that check", () => {
    const without = evaluateGate2(rebuild(passingInput(), withoutCanaries(baselineScenarios())));
    expect(without.status).toBe("fail");
    if (without.status !== "fail") return;
    expect(without.reasons).toEqual([{ code: "canary_missing" }]);
    expect(without.route).toBe("back_to_S2");

    const withOne = evaluateGate2(rebuild(passingInput(), [...withoutCanaries(baselineScenarios()), effective({ kind: "contradiction_canary", split: "test" })]));
    expect(withOne.status).toBe("pass");

    // A canary that was contaminated or retired no longer counts: the set is back to zero active canaries.
    const spent = evaluateGate2(
      rebuild(passingInput(), [...withoutCanaries(baselineScenarios()), effective({ kind: "contradiction_canary", split: "train", status: "contaminated" })]),
    );
    expect(spent.status === "fail" && spent.reasons.map((r) => r.code)).toEqual(["canary_missing"]);
  });

  it("does not probe-judge retired or contaminated scenarios", () => {
    const retired = effective({ kind: "behavior", split: "train", refs: ["d-interface"], status: "retired" });
    const base = passingInput();
    const withRetired = rebuild(base, [...baselineScenarios(), retired]);
    const probes = withRetired.probes;
    if (probes === null) throw new Error("probes");
    // A passing null run for the retired scenario is stray data, not a verdict on the live judge.
    const stray = { ...withRetired, probes: { ...probes, null_error: [...probes.null_error, { scenario_ref: refOf(retired), outcome: "pass" as const }] } };
    expect(evaluateGate2(stray).status).toBe("pass");
  });

  it("fails closed on a missing probe entry and keeps the worst of duplicate entries", () => {
    const base = passingInput();
    const probes = base.probes;
    if (probes === null) throw new Error("probes");
    const ref = pick(base, "behavior", "train");
    const missing = { ...base, probes: { ...probes, null_empty: probes.null_empty.filter((r) => r.scenario_ref !== ref) } };
    const gone = evaluateGate2(missing);
    expect(gone.status === "fail" && gone.reasons.map((r) => r.code)).toEqual(["probe_error"]);

    const dup = { ...base, probes: { ...probes, null_empty: [...probes.null_empty, { scenario_ref: ref, outcome: "pass" as const }] } };
    const hidden = evaluateGate2(dup);
    expect(hidden.status === "fail" && hidden.reasons.map((r) => r.code)).toEqual(["null_impl_passes"]);
  });

  it("does not read the decisions digest as a pass signal when the seal is absent", () => {
    const result = evaluateGate2({ ...passingInput(), seal: null, set: null, effective: [], probes: null, order: { ok: false, reason: "no_seal" }, decisionsDigest: DECISIONS_DIGEST });
    expect(result.status === "fail" && result.aggregate).toBeNull();
  });
});

describe("scenarioAggregate", () => {
  it("counts by status, kind and split, and holds numbers only (the J3 sampling hook gets nothing else)", () => {
    const set = [
      effective({ kind: "behavior", split: "train" }),
      effective({ kind: "behavior", split: "train" }),
      effective({ kind: "behavior", split: "test", status: "retired" }),
      effective({ kind: "contradiction_canary", split: "test", status: "contaminated" }),
      effective({ kind: "contradiction_canary", split: "train" }),
    ];
    const aggregate = scenarioAggregate(set);
    expect(aggregate).toEqual({
      total: 5,
      active: 3,
      retired: 1,
      contaminated: 1,
      behavior: { train: 2, test: 0 },
      contradiction_canary: { train: 1, test: 0 },
    });
    const leaves: unknown[] = [];
    const walk = (v: unknown): void => (typeof v === "object" && v !== null ? Object.values(v).forEach(walk) : void leaves.push(v));
    walk(aggregate);
    expect(leaves.every((v) => typeof v === "number")).toBe(true);
  });
});

describe("gate2EventFor", () => {
  const digests = { seal_id: "seal-0123456789abcdef", set_sha256: sha("set"), decisions_digest: DECISIONS_DIGEST };

  it("builds a gate2.evaluated event that validates and carries codes, counts and ids only", () => {
    const input = unlink(passingInput());
    const result = evaluateGate2(input);
    const event = gate2EventFor(SCOPE, 2, result, digests);
    expect(event.actor).toBe("omf");
    expect(event.type).toBe("gate2.evaluated");
    expect(validateDef("scenario.schema.json", "ev_gate2_evaluated", event.payload)).toEqual({ ok: true });
    expect(event.payload).toMatchObject({
      goal_id: SCOPE.goal_id,
      work_id: SCOPE.work_id,
      round: 2,
      seal_id: digests.seal_id,
      status: "fail",
      route: "back_to_S2",
      reason_codes: ["unlinked_decisions"],
      unlinked_decision_ids: ["d-cache"],
      not_run_decision_ids: ["d-latency"],
      counts: { active: 3, behavior_train: 1, behavior_test: 1, canaries: 1, contaminated: 0, retired: 0 },
    });
    const text = JSON.stringify(event);
    for (const entry of input.effective) {
      expect(text).not.toContain(entry.scenario.canary);
      expect(text).not.toContain(entry.scenario.scenario_id);
      expect(text).not.toContain("reports a miss");
    }
  });

  it("writes a pass with a null route, and zero counts when there was no set to count", () => {
    const pass = gate2EventFor(SCOPE, 1, evaluateGate2(passingInput()), digests);
    expect(validateDef("scenario.schema.json", "ev_gate2_evaluated", pass.payload)).toEqual({ ok: true });
    expect(pass.payload).toMatchObject({ status: "pass", route: null, reason_codes: [], unlinked_decision_ids: [] });

    const noSeal: Gate2Result = evaluateGate2({ ...passingInput(), seal: null, set: null, effective: [], probes: null, order: { ok: false, reason: "no_seal" } });
    const event = gate2EventFor(SCOPE, 1, noSeal, { seal_id: null, set_sha256: null, decisions_digest: DECISIONS_DIGEST });
    expect(validateDef("scenario.schema.json", "ev_gate2_evaluated", event.payload)).toEqual({ ok: true });
    expect(event.payload).toMatchObject({
      seal_id: null,
      set_sha256: null,
      counts: { active: 0, behavior_train: 0, behavior_test: 0, canaries: 0, contaminated: 0, retired: 0 },
    });
  });

  it("lists each reason code once and keeps at most 100 unlinked decision ids", () => {
    const ids = Array.from({ length: 120 }, (_, n) => `d-x${n}`);
    const result: Gate2Result = {
      status: "fail",
      route: "back_to_S2",
      reasons: [
        { code: "split_missing", split: "train" },
        { code: "split_missing", split: "test" },
        { code: "unlinked_decisions", count: 120, decision_ids: ids },
      ],
      not_run: [],
      aggregate: null,
    };
    const event = gate2EventFor(SCOPE, 1, result, digests);
    expect(event.payload["reason_codes"]).toEqual(["split_missing", "unlinked_decisions"]);
    expect(event.payload["unlinked_decision_ids"]).toEqual(ids.slice(0, 100));
    expect(validateDef("scenario.schema.json", "ev_gate2_evaluated", event.payload)).toEqual({ ok: true });
  });

  it("throws, appending nothing, when a reason code has drifted from the schema enum", () => {
    const drifted = {
      status: "fail",
      route: "back_to_S2",
      reasons: [{ code: "not_a_schema_code" }],
      not_run: [],
      aggregate: null,
    } as unknown as Gate2Result;
    expect(() => gate2EventFor(SCOPE, 1, drifted, digests)).toThrow(/invalid gate2\.evaluated payload/);
  });
});

describe("sealFeedbackFor", () => {
  it("is null for pass and for the J2, J3 and J7 routes: those never rerun the author", () => {
    expect(sealFeedbackFor(evaluateGate2(passingInput()))).toBeNull();
    expect(sealFeedbackFor(evaluateGate2(blockGate1(passingInput())))).toBeNull();
    expect(sealFeedbackFor(evaluateGate2(addAnomalies(passingInput())))).toBeNull();
    expect(sealFeedbackFor(evaluateGate2(probeError(passingInput())))).toBeNull();
  });

  it("gives plain counts and the unlinked ids when the item goes back to S2", () => {
    const result = evaluateGate2(unlink(nullPasses(passingInput())));
    expect(sealFeedbackFor(result)).toEqual({ unlinked_decision_ids: ["d-cache"], weak: 0, contradictions: 0, invalid: 0 });
    const weak = evaluateGate2(nullPasses(passingInput()));
    expect(sealFeedbackFor(weak)).toEqual({ unlinked_decision_ids: [], weak: 1, contradictions: 0, invalid: 0 });
  });
});

import { scenarioRef } from "../../src/scenario/types.js";
import type { RunTarget, StepInput } from "../../src/scenario/runner.js";
import type { StepObservation } from "../../src/scenario/types.js";
import { DEFAULT_SPECS, STRONG_EXPECT, buildScenarios, fakeFixtureRunner, fixtureOf } from "../helpers/scenario-fixture.js";

describe("runGate2Probes", () => {
  const scenarios = buildScenarios(DEFAULT_SPECS, "w-probe");
  const refs = scenarios.map((s) => scenarioRef(s.scenario_id));

  it("runs a behavior scenario against both nulls and a canary against all three", async () => {
    const fake = fakeFixtureRunner();
    const probes = await runGate2Probes(fake.runner, scenarios);
    expect(probes.null_error.map((p) => p.scenario_ref)).toEqual(refs);
    expect(probes.null_empty.map((p) => p.scenario_ref)).toEqual(refs);
    expect(probes.echo.map((p) => p.scenario_ref), "only the canary meets the echo-everything stub").toEqual([refs[2]]);
    expect(fake.opened).toHaveLength(7);
    for (const run of [...probes.null_error, ...probes.null_empty, ...probes.echo]) expect(run.outcome).toBe("fail");
  });

  it("runs at most 8 scenarios at a time", async () => {
    const many = buildScenarios(Array.from({ length: 20 }, () => ({ split: "train" as const, expect: STRONG_EXPECT })), "w-probe");
    const fake = fakeFixtureRunner({ delayMs: 5 });
    await runGate2Probes(fake.runner, many);
    expect(fake.opened).toHaveLength(40);
    expect(fake.maxOpen()).toBeGreaterThan(1);
    expect(fake.maxOpen()).toBeLessThanOrEqual(8);
  });

  it("refuses a runner that executes candidate code", async () => {
    const candidate = fakeFixtureRunner({ executes: "candidate" });
    await expect(runGate2Probes(candidate.runner, scenarios)).rejects.toThrow("omf_fixture");
    expect(candidate.opened).toHaveLength(0);
  });

  it("keeps the refusal code, and an adapter that throws is an error, never a pass", async () => {
    const refusing = fakeFixtureRunner({ observe: () => ({ outcome: "refused", code: "fixture_hash_mismatch" }) });
    const refused = await runGate2Probes(refusing.runner, scenarios);
    expect(refused.null_error[0]).toMatchObject({ outcome: "error", refusal: "fixture_hash_mismatch" });
    const broken = await runGate2Probes(fakeFixtureRunner({ failOpen: true }).runner, scenarios);
    expect(broken.null_error[0]).toEqual({ scenario_ref: refs[0], outcome: "error" });
  });

  it("counts a fixture that did not run normally as an error, never as a failed scenario", async () => {
    const killed = await runGate2Probes(
      fakeFixtureRunner({ observe: (target, step) => (target.kind === "fixture" && target.id === "null-error" ? { outcome: "signaled", signal: "SIGKILL" } : fixtureOf(target, step)) }).runner,
      scenarios,
    );
    expect(killed.null_error.map((p) => p.outcome)).toEqual(["error", "error", "error"]);
    expect(killed.null_empty.map((p) => p.outcome)).toEqual(["fail", "fail", "fail"]);
    const crashed = await runGate2Probes(
      fakeFixtureRunner({ observe: (target, step) => (target.kind === "fixture" && target.id === "null-empty" ? { outcome: "exited", exit_code: 134, stdout: "" } : fixtureOf(target, step)) }).runner,
      scenarios,
    );
    expect(crashed.null_empty.map((p) => p.outcome)).toEqual(["error", "error", "error"]);
    const cannotStart = await runGate2Probes(fakeFixtureRunner({ observe: () => ({ outcome: "error" }) }).runner, scenarios);
    expect(cannotStart.null_error.map((p) => p.outcome)).toEqual(["error", "error", "error"]);
  });
});

import { join } from "node:path";
import { symlinkSync } from "node:fs";
import { SymlinkRefusedError } from "../../src/core/safe-fs.js";
import { splitDigest } from "../../src/vault/vault.js";
import { runDecideDefer } from "../../src/cli/decide.js";
import { gate1ForItem } from "../../src/decision/gate1-item.js";
import { HUMAN, NOW, addOpen } from "../helpers/decision-fixture.js";
import { sealedCtx, seedSealedItem } from "../helpers/scenario-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

describe("runGate2", () => {
  it.each([
    ["a null fixture killed by a signal", (t: RunTarget, st: StepInput): StepObservation => (t.kind === "fixture" && t.id === "null-error" ? { outcome: "signaled", signal: "SIGKILL" } : fixtureOf(t, st))],
    ["a null fixture that cannot start", (t: RunTarget, st: StepInput): StepObservation => (t.kind === "fixture" && t.id === "null-empty" ? { outcome: "error" } : fixtureOf(t, st))],
  ])("does not pass when %s", async (_name, observe) => {
    const s = seedSealedItem(DEFAULT_SPECS);
    const result = await runGate2(sealedCtx(s, { runner: fakeFixtureRunner({ observe }).runner }));
    expect(result.status).toBe("fail");
    expect(result.status === "fail" ? result.reasons.map((r) => r.code) : []).toContain("probe_error");
  });

  it("passes a strong sealed set, lists the quantitative decision as not_run, appends nothing and samples counts only", async () => {
    const s = seedSealedItem(DEFAULT_SPECS, { latency: true });
    const before = s.f.fx.ledger.readVerified().length;
    const seen: ScenarioAggregate[] = [];
    const result = await runGate2(sealedCtx(s, { sample: (aggregate) => seen.push(aggregate) }));
    expect(result.status).toBe("pass");
    expect(result.status === "pass" ? result.not_run : null).toEqual(["d-latency"]);
    expect(s.f.fx.ledger.readVerified()).toHaveLength(before);
    expect(seen).toEqual([
      { total: 3, active: 3, retired: 0, contaminated: 0, behavior: { train: 1, test: 1 }, contradiction_canary: { train: 1, test: 0 } },
    ]);
    const text = JSON.stringify(seen);
    for (const scenario of s.scenarios) {
      expect(text).not.toContain(scenario.scenario_id);
      expect(text).not.toContain(scenario.canary);
    }
  });

  it("runs the guards before it reads or probes anything", async () => {
    const s = seedSealedItem();
    const fake = fakeFixtureRunner();
    const before = s.f.fx.ledger.readVerified().length;
    await expect(
      runGate2(sealedCtx(s, { runner: fake.runner, preflight: () => { throw new Error("guard first"); } })),
    ).rejects.toThrow("guard first");
    symlinkSync(s.f.fx.repo, join(s.f.fx.location.dir, "stray-link"));
    await expect(runGate2(sealedCtx(s, { runner: fake.runner }))).rejects.toBeInstanceOf(SymlinkRefusedError);
    expect(fake.opened, "no scenario was run").toHaveLength(0);
    expect(s.f.fx.ledger.readVerified()).toHaveLength(before);
  });

  it("takes its default environment from the location, never from the caller's process.env", async () => {
    const s = seedSealedItem();
    vi.stubEnv("OMF_HOME", makeTempDir("omf-elsewhere-"));
    try {
      symlinkSync(s.f.fx.repo, join(s.f.fx.location.dir, "stray-link"));
      const { env: _env, ...ctx } = sealedCtx(s, { runner: fakeFixtureRunner().runner });
      await expect(runGate2(ctx)).rejects.toBeInstanceOf(SymlinkRefusedError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a runner that executes candidate code", async () => {
    const s = seedSealedItem();
    await expect(runGate2(sealedCtx(s, { runner: fakeFixtureRunner({ executes: "candidate" }).runner }))).rejects.toThrow("omf_fixture");
  });

  it("asks the exposure count for the digest of each split", async () => {
    const s = seedSealedItem();
    const asked: { split: string; digest: string }[] = [];
    await runGate2(sealedCtx(s, { exposureCount: (key) => { asked.push(key); return 0; } }));
    expect(asked).toEqual([
      { split: "train", digest: splitDigest(s.scenarios, new Map(), "train") },
      { split: "test", digest: splitDigest(s.scenarios, new Map(), "test") },
    ]);
  });
});

describe("runGate2, GATE-1 for the item's state", () => {
  const HOUR = 3_600_000;

  /** An unsealed item with one open question that a person deferred for an hour; `now` is two hours later. */
  function lapsed() {
    const s = seedSealedItem(DEFAULT_SPECS, { seal: false });
    addOpen(s.f, "d-wait");
    const signed = new Date(NOW.getTime() - 3 * HOUR);
    runDecideDefer(
      s.f.fx.location,
      s.f.workId,
      "d-wait",
      {
        owner: "dev",
        reason: "Waiting on the cache benchmark.",
        revisit_trigger: "After the benchmark lands.",
        default: "Keep the current behavior.",
        expires_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
      },
      HUMAN,
      signed,
    );
    return s;
  }
  const codes = (result: Gate2Result): string[] => (result.status === "pass" ? [] : result.reasons.map((reason) => reason.code));
  const inProgress = (item: WorkItem): WorkItem => ({ ...item, front: { ...item.front, state: "in_progress" } });

  it("takes GATE-1 as passed for an in_progress item: an expired deferral gives no gate1_not_passing", async () => {
    const s = lapsed();
    const started = sealedCtx(s, { item: inProgress(s.f.item) });
    expect(codes(await runGate2(started))).not.toContain("gate1_not_passing");
  });

  it("on a ready item the GATE-1 verdict is the one gate1ForItem gives", async () => {
    const s = lapsed();
    const expected = gate1ForItem(s.f.fx.location, s.f.item, s.f.fx.ledger.readVerified(), NOW).result;
    expect(expected.status).toBe("blocked_on_user");
    const result = await runGate2(sealedCtx(s));
    expect(codes(result)).toContain("gate1_not_passing");
    const reason = result.status === "pass" ? undefined : result.reasons.find((r) => r.code === "gate1_not_passing");
    expect(reason).toMatchObject({ count: expected.status === "pass" ? 0 : expected.reasons.length });
  });
});

describe("exposure limit", () => {
  it("is the same number in the scenario module and the feedback module", () => {
    expect(EXPOSURE_LIMIT_DEFAULT).toBe(EXPOSURE_LIMIT);
  });
});
