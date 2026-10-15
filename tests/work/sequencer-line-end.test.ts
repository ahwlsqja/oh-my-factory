import { describe, expect, it } from "vitest";
import { PLANTED, cleanStations, finished, passGates, setupLine } from "../helpers/line.js";

// The judge stations own images that outlive their own run (the round's SUT image, kept for S6). The line tells them
// when it is over, finished or aborted, while the claim is still held (M3f).
describe("LineOptions.onLineEnd", () => {
  it("is awaited once, after the last station", async () => {
    const trace: string[] = [];
    const result = await setupLine().go({
      stations: cleanStations({ trace }),
      gates: passGates(),
      onLineEnd: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        trace.push("end");
      },
    });
    expect(finished(result).kind).toBe("finished");
    expect(trace.at(-1)).toBe("end");
    expect(trace.filter((entry) => entry === "end")).toHaveLength(1);
  });

  it("cannot change the result when it throws", async () => {
    let calls = 0;
    const result = await setupLine().go({
      gates: passGates(),
      onLineEnd: () => {
        calls += 1;
        throw new Error(PLANTED);
      },
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(finished(result))).not.toContain(PLANTED);
  });
});
