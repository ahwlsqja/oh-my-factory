import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { s6Station } from "../../src/judge/s6-station.js";
import type { RoundState } from "../../src/judge/state.js";
import { LINE_ORDER } from "../../src/work/line-types.js";
import { OK, fakeGate, passGate, setupLine, stationsOf } from "../helpers/line.js";
import { judgeSpy, roundState, slot } from "../helpers/s6-fixture.js";

/** The real S6 inside the real sequencer: stub stations around it, S4 leaves the round state, GATE-3 answers `gate3`. */
async function walk(gate3: "pass" | "fail") {
  const l = setupLine();
  const log: string[] = [];
  const spy = judgeSpy(l);
  let state: RoundState | null = null;
  const real = s6Station({
    location: l.fx.location,
    current: () => state,
    feedback: slot(),
    judgeTest: (input) => {
      log.push("judge-test");
      return spy.judge(input);
    },
  });
  const stations = stationsOf(log, {
    S4: (ctx) => {
      state = roundState([], { round: ctx.round });
      return OK;
    },
    S6: (ctx) => real.run(ctx),
  });
  await l.go({
    stations,
    gates: {
      "GATE-2": passGate("GATE-2", log),
      "GATE-3": fakeGate("GATE-3", { log, verdict: gate3, reasons: gate3 === "fail" ? ["isolation_unmeasured"] : [] }),
    },
  });
  return { l, log };
}

// Spec §5.5 to §5.8: the single-use test split is spent after GATE-3 and by S6 alone.
describe("W-test-split-after-gate3", () => {
  it("runs the split only after GATE-3 passed", async () => {
    const { l, log } = await walk("pass");

    expect(log.indexOf("GATE-3")).toBeGreaterThan(log.indexOf("S5"));
    expect(log.indexOf("S6")).toBeGreaterThan(log.indexOf("GATE-3"));
    expect(log.indexOf("judge-test")).toBeGreaterThan(log.indexOf("S6"));
    const types = l.events().map((event) => event.type);
    expect(types.indexOf("feedback.test_run_consumed")).toBeGreaterThan(types.indexOf("work.round"));
    expect(types).toContain("feedback.test_run_completed");
  });

  it("never reaches S6, and never consumes the split, when GATE-3 fails", async () => {
    const { l, log } = await walk("fail");

    expect(log).toContain("GATE-3");
    expect(log).not.toContain("S6");
    expect(log).not.toContain("judge-test");
    expect(l.events().map((event) => event.type)).not.toContain("feedback.test_run_consumed");
  });

  it("is ordered after GATE-3 in the line, and no other judge module can consume the split", () => {
    expect(LINE_ORDER.indexOf("S6")).toBeGreaterThan(LINE_ORDER.indexOf("GATE-3"));
    const dir = new URL("../../src/judge/", import.meta.url);
    const spenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => /import[^;]*\b(beginTestRun|completeTestRun)\b/.test(readFileSync(new URL(name, dir), "utf8")));
    expect(spenders).toEqual(["s6-station.ts"]);
  });
});
