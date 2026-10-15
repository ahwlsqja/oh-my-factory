import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { gate3EvaluatedEvent } from "../../src/gate/events.js";
import { evaluateGate3, measuredFrom } from "../../src/gate/gate3.js";
import { isolationPath, loadRunIsolation, recordStageMeasurement } from "../../src/isolation/record.js";
import { ISOLATION_STAGES, type IsolationLevel, type IsolationStage, runIsolation } from "../../src/isolation/types.js";
import { ALL_L2, RUN, SCOPE, healthyParts, isolationFor, measurement } from "../helpers/gate3-parts.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §5.0 (GATE-3) and §7 (J7): the run's isolation level is the minimum over its stages, a stage nobody
// measured is `unmeasured` (the lowest), and nothing but the ledger events decides it: not the declared level, not
// preflight.json, not an isolation.json that someone wrote. A level below the declared one stops the line at J7.

describe("W-gate3-measured-below-declared-stops", () => {
  it("a stage at L1 with L2 declared fails GATE-3 with isolation_below_declared and routes to J7", () => {
    const isolation = isolationFor({ ...ALL_L2, sut: "L1" });
    expect(isolation).toMatchObject({ level: "L1", complete: true });
    const result = evaluateGate3(measuredFrom(healthyParts({ isolation })));
    expect(result).toEqual({ passed: false, failed: ["isolation_below_declared"], route: "J7" });
    const event = gate3EvaluatedEvent(SCOPE, result);
    expect(event.payload).toMatchObject({ passed: false, route: "J7", failed: ["isolation_below_declared"] });
  });

  it("a round that was L1 stays L1 after a later L2 round of the same stage", () => {
    const rounds = runIsolation(RUN, [
      measurement("author", "L2"),
      measurement("implementer", "L2"),
      measurement("sut", "L1", 1),
      measurement("sut", "L2", 2),
      measurement("harness", "L2"),
    ]);
    expect(rounds.level).toBe("L1");
    expect(evaluateGate3(measuredFrom(healthyParts({ isolation: rounds }))).failed).toEqual(["isolation_below_declared"]);
  });

  it("control: all four stages at L2 with L2 declared pass, and a lower declaration accepts a lower level", () => {
    expect(evaluateGate3(measuredFrom(healthyParts()))).toEqual({ passed: true, failed: [], route: "none" });
    const low = isolationFor({ ...ALL_L2, harness: "L1" });
    expect(evaluateGate3(measuredFrom(healthyParts({ isolation: low, declared: "L1" }))).passed).toBe(true);
  });
});

describe("W-gate3-unmeasured-is-lowest", () => {
  it.each([0, 1, 2, 3])("%i of four stages measured at L2 is unmeasured, never L2, and fails GATE-3", (count) => {
    const levels: Partial<Record<IsolationStage, IsolationLevel>> = Object.fromEntries(ISOLATION_STAGES.slice(0, count).map((stage) => [stage, "L2"]));
    const isolation = isolationFor(levels);
    expect(isolation).toMatchObject({ level: "unmeasured", complete: false });
    const result = evaluateGate3(measuredFrom(healthyParts({ isolation })));
    expect(result).toEqual({ passed: false, failed: ["isolation_unmeasured"], route: "J7" });
  });

  it("all four stages at L2 give L2", () => {
    expect(isolationFor(ALL_L2)).toMatchObject({ level: "L2", complete: true });
  });

  it("a stage no event proves is unmeasured whatever preflight.json or isolation.json claim", () => {
    const dir = makeTempDir("omf-gate3-iso-");
    const itemDir = join(dir, "item");
    mkdirSync(itemDir);
    const ledger = new Ledger(dir, () => new Date("2026-10-12T10:00:00.000Z"));
    // Three stages are really recorded at L2. The author stage never is.
    for (const stage of ["implementer", "sut", "harness"] as const) recordStageMeasurement(ledger, SCOPE, itemDir, measurement(stage, "L2"));

    // The forgeries: an advisory preflight claiming L2, and an isolation.json that claims all four stages at L2.
    writeFileSync(join(itemDir, "preflight.json"), JSON.stringify({ isolation: { declared: "L2", measured: "L2", advisory: true } }));
    const forged = { schema_version: 1, run_id: RUN, stages: Object.fromEntries(ISOLATION_STAGES.map((stage) => [stage, [measurement(stage, "L2")]])), level: "L2" };
    mkdirSync(dirname(isolationPath(itemDir, RUN)), { recursive: true });
    writeFileSync(isolationPath(itemDir, RUN), JSON.stringify(forged));

    const loaded = loadRunIsolation(itemDir, SCOPE, ledger.readVerified());
    expect(loaded.stages.author).toBeNull();
    expect(loaded).toMatchObject({ level: "unmeasured", complete: false });
    expect(evaluateGate3(measuredFrom(healthyParts({ isolation: loaded }))).failed).toEqual(["isolation_unmeasured"]);
  });

  it("an isolation.json with no event behind it reads as nothing measured", () => {
    const dir = makeTempDir("omf-gate3-iso-");
    const itemDir = join(dir, "item");
    const ledger = new Ledger(dir, () => new Date("2026-10-12T10:00:00.000Z"));
    mkdirSync(dirname(isolationPath(itemDir, RUN)), { recursive: true });
    const forged = { schema_version: 1, run_id: RUN, stages: Object.fromEntries(ISOLATION_STAGES.map((stage) => [stage, [measurement(stage, "L2")]])), level: "L2" };
    writeFileSync(isolationPath(itemDir, RUN), JSON.stringify(forged));
    const loaded = loadRunIsolation(itemDir, SCOPE, ledger.readVerified());
    expect(Object.values(loaded.stages).every((stage) => stage === null)).toBe(true);
    expect(loaded.level).toBe("unmeasured");
  });

  it("a preflight-shaped object is not an accepted isolation input", () => {
    // Compile-time check: `typecheck` fails if the @ts-expect-error below is unused. Never called.
    const preflight = { declared: "L2", measured: "L2", advisory: true } as const;
    // @ts-expect-error GATE-3 reads a RunIsolation built from ledger events, not an advisory preflight claim
    const wrong = () => measuredFrom(healthyParts({ isolation: preflight }));
    void wrong;
  });
});
