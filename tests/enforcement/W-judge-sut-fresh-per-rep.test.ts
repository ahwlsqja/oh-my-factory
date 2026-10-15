import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRound, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { measureHook, resetMeasureHook } from "../helpers/measure-mock.js";
import { type Candidate, exited, RuntimeDouble } from "../helpers/sut-double.js";

vi.mock("../../src/container/measure.js", async () => (await import("../helpers/measure-mock.js")).measureMockModule());
beforeEach(resetMeasureHook);

// M3f-D7: one fresh, measured SUT container per (scenario, rep). The candidate below leaves a file under /tmp and a
// background process, and kills its own PID 1. None of it may be visible to another scenario or another rep.
const candidate: Candidate = ({ argv, state }) => {
  switch (argv[1]) {
    case "write":
      state.files.set("/tmp/leftover", "1");
      state.background.add("setsid-sleep");
      return exited("");
    case "read":
      return exited(`${state.files.size} ${state.background.size}`);
    default:
      state.dead = true;
      return { kind: "error", code: "EIO", message: "container gone" };
  }
};

describe("W-judge-sut-fresh-per-rep", () => {
  it("starts every scenario and every rep from an empty container, whatever an earlier one did", async () => {
    const double = new RuntimeDouble(candidate);
    const verdict = await runRound(
      double,
      [
        scenarioOf(1, [stepOf(["write"], 0), stepOf(["read"], 0, "1 1")]), // steps of one scenario share the container
        scenarioOf(2, [stepOf(["read"], 0, "0 0")]),
        scenarioOf(3, [stepOf(["die"], 0)]), // kills its own container
        scenarioOf(4, [stepOf(["read"], 0, "0 0")]),
      ],
      { k: 2 },
    );
    expect(verdict.tallies.map((tally) => tally.verdict)).toEqual(["pass", "pass", "fail", "pass"]);
    expect(verdict.counts).toEqual({ total: 4, pass: 3, fail: 1, flaky: 0, error: 0 });
  });

  it("creates and measures a new container per run and removes the previous one before the next exists", async () => {
    const double = new RuntimeDouble(candidate);
    await runRound(double, [scenarioOf(1, [stepOf(["read"], 0, "0 0")]), scenarioOf(2, [stepOf(["read"], 0, "0 0")])], {
      k: 3,
    });
    const suts = double.specs.filter((spec) => spec.labels.role === "sut").map((spec) => spec.name);
    expect(suts).toHaveLength(6);
    expect(new Set(suts).size).toBe(6);
    expect(measureHook.measured.filter((m) => m.role === "sut").map((m) => m.name)).toEqual(suts);
    suts.forEach((name, index) => {
      const created = double.calls.indexOf(`create:sut:${name}`);
      expect(double.calls.indexOf(`start:${name}`)).toBeGreaterThan(created);
      expect(double.calls.indexOf(`exec:sut:${name}`)).toBeGreaterThan(double.calls.indexOf(`start:${name}`));
      const previous = suts[index - 1];
      if (previous !== undefined) {
        const removed = double.calls.indexOf(`remove:${previous}`);
        expect(removed).toBeGreaterThanOrEqual(0);
        expect(removed).toBeLessThan(created);
      }
    });
  });
});
