import { createHash } from "node:crypto";
import type { DecisionClass, DecisionRecord, DecisionState } from "../../src/decision/types.js";
import type { EffectiveScenario, SealRecord } from "../../src/scenario/events.js";
import type { Gate2Input, Gate2Probes, ProbeRun } from "../../src/scenario/gate2.js";
import { scenarioRef } from "../../src/scenario/types.js";
import type { RefusalCode, ScenarioSplit, ScenarioStatus, StoredKind, StoredScenario } from "../../src/scenario/types.js";
import type { ScenarioSetRead } from "../../src/vault/vault.js";
import { SCOPE } from "./decision.js";

const AT = "2026-10-14T00:00:00.000Z";
const HUMAN = "human:tester@example.invalid";

export function sha(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

export const SEAL_ID = "seal-0123456789abcdef";
export const DECISIONS_DIGEST = sha("decisions");
export const SET_SHA = sha("set");

let counter = 0;
function hex32(n: number): string {
  return n.toString(16).padStart(32, "0");
}

export interface StoredOverrides {
  kind?: StoredKind;
  split?: ScenarioSplit;
  refs?: string[];
  /** Exit code the single step demands; the exact stdout is always "miss\n". */
  exit?: number;
  status?: ScenarioStatus;
}

/** A valid stored scenario with unique id and canary. All scenarios share one invoke, so two with different `exit` contradict. */
export function stored(over: StoredOverrides = {}): StoredScenario {
  counter += 1;
  const canary = `omf-canary-${hex32(counter)}`;
  return {
    schema_version: 1,
    scenario_id: `s-${hex32(counter + 4096)}`,
    work_id: SCOPE.work_id,
    author: { vendor: "stub", model: "stub-1", at: AT, isolation: "host_command" },
    decision_refs: over.refs ?? [],
    kind: over.kind ?? "behavior",
    split: over.split ?? "train",
    interface: "cli",
    steps: [
      {
        invoke: { argv: ["cache", "get", "k"], stdin: "" },
        expect: {
          exit_code: over.exit ?? 1,
          stdout_matches: { kind: "exact", text: "miss\n" },
          json_path: null,
          note: `${canary} a missing key reports a miss`,
        },
      },
    ],
    canary,
  };
}

export function effective(over: StoredOverrides = {}): EffectiveScenario {
  return { scenario: stored(over), status: over.status ?? "active" };
}

/** Train behavior (d-interface), test behavior (d-cache) and a train canary: the smallest set that passes. */
export function baselineScenarios(): EffectiveScenario[] {
  return [
    effective({ kind: "behavior", split: "train", refs: ["d-interface"] }),
    effective({ kind: "behavior", split: "test", refs: ["d-cache"] }),
    effective({ kind: "contradiction_canary", split: "train" }),
  ];
}

let seq = 0;
export function decision(id: string, cls: DecisionClass = "other"): DecisionRecord {
  seq += 1;
  return {
    id,
    class: cls,
    question: "Which policy do we use?",
    qas: null,
    response_measure: null,
    status: "resolved",
    resolution: { choice: "Policy A.", rationale: "Cheap and bounded.", rejected: [], by: HUMAN, at: AT },
    deferral: null,
    interface: null,
    na: null,
    added_by: "omf",
    added_seq: seq,
    closed_seq: seq + 1000,
    measure_seq: null,
  };
}

/** d-interface and d-cache need a link; d-latency is quantitative, so it is `not_run`. */
export function baselineState(): DecisionState {
  return {
    scope: SCOPE,
    decisions: [decision("d-interface", "interface"), decision("d-cache"), decision("d-latency", "latency")],
    anomalies: [],
  };
}

export function sealRecord(over: Partial<SealRecord> = {}): SealRecord {
  return {
    seq: 7,
    round: 1,
    seal_id: SEAL_ID,
    author: { vendor: "stub", model: "stub-1", at: AT, isolation: "host_command" },
    decisions_digest: DECISIONS_DIGEST,
    set_sha256: SET_SHA,
    counts: { authored: 3, stored: 3, behavior: 2, contradiction_canary: 1, train: 2, test: 1, rejected: 0, ignored_fields: 0 },
    ...over,
  };
}

export function refOf(e: EffectiveScenario): string {
  return scenarioRef(e.scenario.scenario_id);
}

/** Every active scenario gets `verdict` against both nulls; canaries also against the echo stub. Retired and contaminated ones are not probed. */
export function verdictProbes(scenarios: readonly EffectiveScenario[], verdict: ProbeRun["outcome"] = "fail"): Gate2Probes {
  const active = scenarios.filter((s) => s.status === "active");
  const run = (s: EffectiveScenario): ProbeRun => ({ scenario_ref: refOf(s), outcome: verdict });
  return {
    null_error: active.map(run),
    null_empty: active.map(run),
    echo: active.filter((s) => s.scenario.kind === "contradiction_canary").map(run),
  };
}

/** Replaces the set, the effective view and the probes together, keeping the seal digest (so the set stays untampered). */
export function rebuild(input: Gate2Input, scenarios: readonly EffectiveScenario[]): Gate2Input {
  const set: ScenarioSetRead = { ok: true, scenarios: scenarios.map((s) => s.scenario), set_sha256: SET_SHA };
  return { ...input, set, effective: scenarios, probes: verdictProbes(scenarios, "fail") };
}

export function passingInput(): Gate2Input {
  const scenarios = baselineScenarios();
  return rebuild(
    {
      gate1: { status: "pass" },
      state: baselineState(),
      decisionsDigest: DECISIONS_DIGEST,
      seal: sealRecord(),
      order: { ok: true },
      anomalies: 0,
      set: null,
      effective: [],
      problems: [],
      probes: null,
      exposure: { train: 0, test: 0 },
    },
    scenarios,
  );
}

/** The ref of the first effective scenario of this kind (and split); throws when the input has none. */
export function pick(input: Gate2Input, kind: StoredKind, split?: ScenarioSplit): string {
  const found = input.effective.find((e) => e.scenario.kind === kind && (split === undefined || e.scenario.split === split));
  if (found === undefined) throw new Error(`no ${kind} scenario in the input`);
  return refOf(found);
}

export function setProbe(
  input: Gate2Input,
  list: keyof Gate2Probes,
  ref: string,
  outcome: ProbeRun["outcome"],
  refusal?: RefusalCode,
): Gate2Input {
  const probes = input.probes;
  if (probes === null) throw new Error("setProbe needs probes");
  const next: ProbeRun = refusal === undefined ? { scenario_ref: ref, outcome } : { scenario_ref: ref, outcome, refusal };
  return { ...input, probes: { ...probes, [list]: probes[list].map((run) => (run.scenario_ref === ref ? next : run)) } };
}
