// covers: S5.0.empty-means-fail
import { appendFileSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostFixtureRunner, fixturesDir } from "../../src/scenario/fixtures.js";
import { markScenarioStatus } from "../../src/scenario/events.js";
import { evaluateGate2, runGate2 } from "../../src/scenario/gate2.js";
import type { Gate2Context, Gate2Input, Gate2ReasonCode, Gate2Route } from "../../src/scenario/gate2.js";
import { EXPOSURE_LIMIT } from "../../src/scenario/types.js";
import { renderScenarioFile, setDir } from "../../src/vault/vault.js";
import { addOpen, resolveOpen } from "../helpers/decision-fixture.js";
import {
  DEFAULT_SPECS,
  type SealedItem,
  type SealedOptions,
  type SeedSpec,
  fakeFixtureRunner,
  gate2Reasons,
  scenarioFile,
  sealedCtx,
  seedSealedItem,
} from "../helpers/scenario-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";
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
    make: () =>
      rebuild(
        passingInput(),
        baselineScenarios().map((e) => ({ ...e, status: "retired" as const })),
      ),
  },
  {
    name: "all scenarios contaminated",
    code: "no_active_scenarios",
    route: "back_to_S2",
    make: () =>
      rebuild(
        passingInput(),
        baselineScenarios().map((e) => ({ ...e, status: "contaminated" as const })),
      ),
  },
  {
    name: "only a train split",
    code: "split_missing",
    route: "back_to_S2",
    make: () =>
      rebuild(
        passingInput(),
        baselineScenarios().filter((e) => e.scenario.split === "train"),
      ),
  },
  {
    name: "only a test split",
    code: "split_missing",
    route: "back_to_S2",
    make: () =>
      rebuild(
        passingInput(),
        baselineScenarios().filter((e) => e.scenario.split === "test"),
      ),
  },
  {
    name: "no contradiction canary",
    code: "canary_missing",
    route: "back_to_S2",
    make: () =>
      rebuild(
        passingInput(),
        baselineScenarios().filter((e) => e.scenario.kind !== "contradiction_canary"),
      ),
  },
  {
    name: "no seal.completed",
    code: "seal_missing",
    route: "back_to_S2",
    make: () => ({
      ...passingInput(),
      seal: null,
      set: null,
      effective: [],
      probes: null,
      order: { ok: false, reason: "no_seal" },
    }),
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

// Spec §5.0 GATE-2 and E7b: a judge that is empty, missing, unreadable, tampered or out of date never passes. These
// rows run the whole of runGate2 on sealed items (the pure table above runs evaluateGate2 on hand-built inputs).
interface SealedRow {
  name: string;
  specs?: readonly SeedSpec[];
  options?: SealedOptions;
  arrange?: (s: SealedItem) => void;
  ctx?: (s: SealedItem) => Partial<Gate2Context>;
  route: Gate2Route;
  /** Any one of these codes satisfies the row. */
  code: Gate2ReasonCode | Gate2ReasonCode[];
}

const retireAll =
  (status: "retired" | "contaminated", reason: "person_retired" | "canary_hit") =>
  (s: SealedItem): void => {
    for (const scenario of s.scenarios)
      markScenarioStatus(s.f.fx.ledger, s.f.scope, s.sealId, scenario.scenario_id, status, reason);
  };

const SEALED_ROWS: SealedRow[] = [
  { name: "zero scenarios", specs: [], route: "back_to_S2", code: "no_active_scenarios" },
  {
    name: "all retired",
    arrange: retireAll("retired", "person_retired"),
    route: "back_to_S2",
    code: "no_active_scenarios",
  },
  {
    name: "all contaminated",
    arrange: retireAll("contaminated", "canary_hit"),
    route: "back_to_S2",
    code: "no_active_scenarios",
  },
  { name: "only a train split", specs: [DEFAULT_SPECS[0] as SeedSpec], route: "back_to_S2", code: "split_missing" },
  { name: "only a test split", specs: [DEFAULT_SPECS[1] as SeedSpec], route: "back_to_S2", code: "split_missing" },
  {
    name: "no contradiction canary",
    specs: DEFAULT_SPECS.filter((spec) => spec.kind !== "contradiction_canary"),
    route: "back_to_S2",
    code: "canary_missing",
  },
  { name: "no seal.completed", options: { seal: false }, route: "back_to_S2", code: "seal_missing" },
  { name: "a set file removed", arrange: (s) => rmSync(scenarioFile(s, 1)), route: "J3", code: "set_tampered" },
  {
    name: "a seal.completed whose set dir is missing",
    arrange: (s) => rmSync(setDir(s.vault, s.ref), { recursive: true }),
    route: "J3",
    code: "set_missing",
  },
  {
    name: "a tampered file",
    arrange: (s) => {
      const scenario = s.scenarios[0];
      const step = scenario?.steps[0];
      if (scenario === undefined || step === undefined) throw new Error("seeded set is empty");
      writeFileSync(
        scenarioFile(s, 0),
        renderScenarioFile({
          ...scenario,
          steps: [{ ...step, expect: { ...step.expect, note: `${step.expect.note} edited` } }],
        }),
      );
    },
    route: "J3",
    code: "set_tampered",
  },
  {
    // A `status` key fails the stored_scenario schema (additionalProperties false); either name sends it to a person.
    name: "a file edited to say status: retired",
    arrange: (s) => appendFileSync(scenarioFile(s, 0), "status: retired\n"),
    route: "J3",
    code: ["set_unreadable", "set_tampered"],
  },
  {
    name: "a decision changed after the seal",
    arrange: (s) => {
      addOpen(s.f, "d-late");
      resolveOpen(s.f, "d-late");
    },
    route: "back_to_S2",
    code: "decisions_drifted",
  },
  { name: "a seal after work.started", options: { startBeforeSeal: true }, route: "J3", code: "seal_after_start" },
  {
    name: "an anomalous omf event",
    arrange: (s) => {
      s.f.fx.ledger.append({
        actor: "omf",
        type: "seal.failed",
        payload: { goal_id: s.f.scope.goal_id, work_id: s.f.scope.work_id },
      });
    },
    route: "J3",
    code: "ledger_anomaly",
  },
  { name: "GATE-1 no longer passing", arrange: (s) => addOpen(s.f, "d-late"), route: "J2", code: "gate1_not_passing" },
  {
    name: "a split at the exposure limit",
    ctx: () => ({ exposureCount: ({ split }) => (split === "test" ? EXPOSURE_LIMIT : 0) }),
    route: "J3",
    code: "exposure_exhausted",
  },
  {
    name: "a probe that errors",
    ctx: () => ({ runner: fakeFixtureRunner({ observe: () => ({ outcome: "error" }) }).runner }),
    route: "J7",
    code: "probe_error",
  },
];

describe("E7b: sealed items fail closed through runGate2", () => {
  it("passes the unmodified item, so the rows below fail for their own reason", async () => {
    expect((await runGate2(sealedCtx(seedSealedItem()))).status).toBe("pass");
  });

  it.each(SEALED_ROWS)("$name", async (row) => {
    const s = seedSealedItem(row.specs ?? DEFAULT_SPECS, row.options);
    row.arrange?.(s);
    const result = await runGate2(sealedCtx(s, row.ctx?.(s)));
    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.route).toBe(row.route);
    const wanted = Array.isArray(row.code) ? row.code : [row.code];
    expect(
      gate2Reasons(result).some((reason) => wanted.includes(reason.code)),
      `reasons: ${JSON.stringify(gate2Reasons(result))}`,
    ).toBe(true);
  });

  it("a fixture whose hash does not match is a J7 probe_error that names the refusal", async () => {
    const copy = makeTempDir("omf-fixtures-");
    cpSync(fixturesDir(), copy, { recursive: true });
    appendFileSync(join(copy, "null-error.mjs"), "\n// edited\n");
    const s = seedSealedItem(DEFAULT_SPECS);
    const result = await runGate2(sealedCtx(s, { runner: createHostFixtureRunner({ fixturesDir: copy }) }));
    expect(result.status === "fail" ? result.route : null).toBe("J7");
    expect(gate2Reasons(result)).toContainEqual(
      expect.objectContaining({ code: "probe_error", refusal_codes: ["fixture_hash_mismatch"] }),
    );
  });
});
