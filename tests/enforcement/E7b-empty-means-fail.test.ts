import { describe, expect, it } from "vitest";
import { evaluateGate2 } from "../../src/scenario/gate2.js";
import type { Gate2Input, Gate2ReasonCode, Gate2Route } from "../../src/scenario/gate2.js";
import { EXPOSURE_LIMIT } from "../../src/scenario/types.js";
import { baselineScenarios, passingInput, rebuild, sha } from "../helpers/gate2-input.js";

// Spec §5.3 (GATE-2) and §11 E7b: a judge that proves nothing is not a judge. Empty, missing, unreadable or
// unprobed input is a failure with a reason and a route, never a pass. This file is the pure table; the sealed-item
// rows, which go through the real vault and the real ledger, are added with runGate2 (M3c task 9).

interface Row {
  name: string;
  code: Gate2ReasonCode;
  route: Gate2Route;
  make: () => Gate2Input;
}

const ROWS: Row[] = [
  { name: "zero scenarios", code: "no_active_scenarios", route: "back_to_S2", make: () => rebuild(passingInput(), []) },
  {
    name: "all scenarios retired",
    code: "no_active_scenarios",
    route: "back_to_S2",
    make: () => rebuild(passingInput(), baselineScenarios().map((e) => ({ ...e, status: "retired" as const }))),
  },
  {
    name: "all scenarios contaminated",
    code: "no_active_scenarios",
    route: "back_to_S2",
    make: () => rebuild(passingInput(), baselineScenarios().map((e) => ({ ...e, status: "contaminated" as const }))),
  },
  {
    name: "only a train split",
    code: "split_missing",
    route: "back_to_S2",
    make: () => rebuild(passingInput(), baselineScenarios().filter((e) => e.scenario.split === "train")),
  },
  {
    name: "only a test split",
    code: "split_missing",
    route: "back_to_S2",
    make: () => rebuild(passingInput(), baselineScenarios().filter((e) => e.scenario.split === "test")),
  },
  {
    name: "no contradiction canary",
    code: "canary_missing",
    route: "back_to_S2",
    make: () => rebuild(passingInput(), baselineScenarios().filter((e) => e.scenario.kind !== "contradiction_canary")),
  },
  {
    name: "no seal.completed",
    code: "seal_missing",
    route: "back_to_S2",
    make: () => ({ ...passingInput(), seal: null, set: null, effective: [], probes: null, order: { ok: false, reason: "no_seal" } }),
  },
  {
    name: "seal.completed whose set dir is gone",
    code: "set_missing",
    route: "J3",
    make: () => ({ ...passingInput(), set: { ok: false, reason: "set_missing" }, effective: [], probes: null }),
  },
  {
    name: "a set file removed or edited (digest differs)",
    code: "set_tampered",
    route: "J3",
    make: () => {
      const input = passingInput();
      if (input.set === null || !input.set.ok) throw new Error("baseline set must be ok");
      return { ...input, set: { ...input.set, set_sha256: sha("one file removed") } };
    },
  },
  {
    name: "probes never ran",
    code: "probe_error",
    route: "J7",
    make: () => ({ ...passingInput(), probes: null }),
  },
  {
    name: "the runner returned no results",
    code: "probe_error",
    route: "J7",
    make: () => ({ ...passingInput(), probes: { null_error: [], null_empty: [], echo: [] } }),
  },
  {
    name: "a decision changed after the seal",
    code: "decisions_drifted",
    route: "back_to_S2",
    make: () => ({ ...passingInput(), decisionsDigest: sha("a decision was resolved again") }),
  },
  {
    name: "a split's exposure reached the limit",
    code: "exposure_exhausted",
    route: "J3",
    make: () => ({ ...passingInput(), exposure: { train: EXPOSURE_LIMIT, test: EXPOSURE_LIMIT } }),
  },
];

describe("E7b-empty-means-fail (pure judge)", () => {
  it("the baseline passes, so each row below fails for its own defect and not for a bad fixture", () => {
    expect(evaluateGate2(passingInput()).status).toBe("pass");
  });

  it.each(ROWS)("$name fails with $code and route $route, never pass", (row) => {
    const result = evaluateGate2(row.make());
    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.map((r) => r.code)).toContain(row.code);
    expect(result.route).toBe(row.route);
  });
});
