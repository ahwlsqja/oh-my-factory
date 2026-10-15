import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { schemaUrl, validate } from "../../src/core/schema.js";
import {
  type IsolationLevel,
  type IsolationStage,
  type StageMeasurement,
  type ViolationCode,
  ISOLATION_LEVELS,
  ISOLATION_STAGES,
  VIOLATION_CODES,
  compareLevel,
  minLevel,
  runIsolation,
} from "../../src/isolation/types.js";

/** A measurement with no facts: enough for the ordering and the minimum, which read only `level` and `violations`. */
function measurement(
  stage: IsolationStage,
  level: IsolationLevel,
  violations: ViolationCode[] = [],
  shaChar = "a",
): StageMeasurement {
  return {
    stage,
    mode: "container",
    measured_at: "2026-10-12T00:00:00.000Z",
    facts: null,
    checks: null,
    level,
    violations,
    facts_sha256: shaChar.repeat(64),
  };
}

const RUN = "r-20261012T000000Z-ab12";

describe("level order", () => {
  it("ranks unmeasured below L1 below L2 below L3", () => {
    const ladder = ["unmeasured", "L1", "L2", "L3"] as const;
    for (let i = 0; i < ladder.length; i++) {
      for (let j = 0; j < ladder.length; j++) {
        expect(compareLevel(ladder[i]!, ladder[j]!)).toBe(i < j ? -1 : i > j ? 1 : 0);
      }
    }
  });

  it("takes the minimum, and an empty list is unmeasured", () => {
    expect(minLevel([])).toBe("unmeasured");
    expect(minLevel(["L2", "L3"])).toBe("L2");
    expect(minLevel(["L2", "L1", "L3"])).toBe("L1");
    expect(minLevel(["L2", "unmeasured"])).toBe("unmeasured");
  });

  it("lists the levels and stages the schema and the sequencer rely on", () => {
    expect(ISOLATION_LEVELS).toEqual(["L1", "L2", "L3"]);
    expect(ISOLATION_STAGES).toEqual(["author", "implementer", "sut", "harness"]);
  });
});

describe("runIsolation", () => {
  it("is unmeasured and incomplete with no measurement", () => {
    expect(runIsolation(RUN, [])).toEqual({
      run_id: RUN,
      stages: { author: null, implementer: null, sut: null, harness: null },
      level: "unmeasured",
      complete: false,
    });
  });

  it("stays unmeasured until all four stages are measured, even when every measured stage is L2", () => {
    const three = ISOLATION_STAGES.slice(0, 3).map((stage) => measurement(stage, "L2"));
    expect(runIsolation(RUN, three)).toMatchObject({ level: "unmeasured", complete: false });
    const four = ISOLATION_STAGES.map((stage) => measurement(stage, "L2"));
    expect(runIsolation(RUN, four)).toMatchObject({ level: "L2", complete: true });
  });

  it("takes the lowest stage as the run level", () => {
    const all = ISOLATION_STAGES.map((stage) => measurement(stage, stage === "sut" ? "L1" : "L2", stage === "sut" ? ["host_network"] : []));
    const result = runIsolation(RUN, all);
    expect(result.level).toBe("L1");
    expect(result.stages.sut).toEqual({ level: "L1", measurements: 1, violations: ["host_network"], facts_sha256s: ["a".repeat(64)] });
  });

  it("keeps the minimum over rounds: an L1 container in round 1 is not healed by an L2 container in round 2", () => {
    const rounds = [
      measurement("sut", "L1", ["privileged", "cap_added"], "1"),
      measurement("sut", "L2", [], "2"),
      measurement("sut", "L1", ["cap_added"], "3"),
      measurement("sut", "L2", [], "2"),
    ];
    const all = [...rounds, ...ISOLATION_STAGES.filter((stage) => stage !== "sut").map((stage) => measurement(stage, "L2"))];
    const sut = runIsolation(RUN, all).stages.sut;
    expect(sut).toEqual({
      level: "L1",
      measurements: 4,
      violations: ["privileged", "cap_added"],
      facts_sha256s: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    });
  });
});

describe("isolation.schema.json", () => {
  const document = (): Record<string, unknown> => ({
    schema_version: 1,
    run_id: RUN,
    stages: Object.fromEntries(ISOLATION_STAGES.map((stage) => [stage, [measurement(stage, "L2")]])),
    level: "L2",
  });

  it("accepts a document built from measurements", () => {
    expect(validate("isolation.schema.json", document())).toEqual({ ok: true });
  });

  it("rejects an unknown violation code, a bad level, an extra key and a missing stage", () => {
    const badCode = document();
    (badCode.stages as Record<string, StageMeasurement[]>).sut = [{ ...measurement("sut", "L1"), violations: ["made_up"] as unknown as ViolationCode[] }];
    expect(validate("isolation.schema.json", badCode).ok).toBe(false);
    expect(validate("isolation.schema.json", { ...document(), level: "L9" }).ok).toBe(false);
    expect(validate("isolation.schema.json", { ...document(), note: "hi" }).ok).toBe(false);
    const missing = document();
    delete (missing.stages as Record<string, unknown>).harness;
    expect(validate("isolation.schema.json", missing).ok).toBe(false);
  });

  it("closes the same lists the TypeScript types close", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("isolation.schema.json"), "utf8")) as {
      properties: { stages: { properties: Record<string, unknown> }; level: { enum: string[] } };
      $defs: { violation_code: { enum: string[] } };
    };
    expect(schema.$defs.violation_code.enum).toEqual([...VIOLATION_CODES]);
    expect(Object.keys(schema.properties.stages.properties)).toEqual([...ISOLATION_STAGES]);
    expect(schema.properties.level.enum).toEqual(["unmeasured", ...ISOLATION_LEVELS]);
  });
});
