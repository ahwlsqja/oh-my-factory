import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSeamLine } from "../helpers/line-m3f.js";

// Owner decision O-1: `noise_check: not_evaluated` stays an unverified area, so `merge_recommended` is unreachable in
// v0.1. M3f gives the line real stations, so this pins that none of them can write the one input that lifts it.
const JUDGE = new URL("../../src/judge/", import.meta.url);

describe("W-no-merge-recommended-in-m3f", () => {
  it("lets the stations write noise_check only through noiseCheckField, which answers not_evaluated or not run", () => {
    const writes = readdirSync(JUDGE)
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) =>
        readFileSync(new URL(name, JUDGE), "utf8")
          .split("\n")
          .filter((line) => /\bnoise_check\s*=[^=]/.test(line))
          .map((line) => `${name}: ${line.trim()}`),
      );
    expect(writes.length, "positive control: S6 writes noise_check").toBeGreaterThan(0);
    expect(writes.filter((write) => !/=\s*noiseCheckField\(/.test(write))).toEqual([]);
  });

  it("ends the cleanest line the stations can produce (the seam variant) at human_needed with the noise check listed", async () => {
    const run = await runSeamLine({ seam: true });
    expect(run.result.outcome).toBe("success");
    expect(run.result.evidence.recommendation).toBe("human_needed");
    expect(["not_evaluated", "not run"]).toContain(run.result.evidence.noise_check);
    expect(run.result.evidence.unverified_areas.map((area) => area.code)).toContain("noise_check_not_evaluated");
  });
});
