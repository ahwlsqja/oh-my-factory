import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { BandsError, bandsFile, baselineWindowMs, detectBand, readBands } from "../../src/goal/bands.js";
import { makeTempDir } from "../helpers/tmp.js";

/** 20 points alternating 12, 8, ...: mean 10, sigma 2, ending on 8 (below the mean). */
const base = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 12 : 8));

describe("detectBand", () => {
  it("needs five baseline points", () => {
    expect(detectBand([10, 10, 10, 10], 10)).toEqual({ status: "insufficient_baseline", points: 4 });
  });

  it("is in band for an ordinary point", () => {
    expect(detectBand(base, 11)).toEqual({ status: "in_band", mean: 10, sigma: 2 });
  });

  it("rule 1: one point beyond 3 sigma", () => {
    expect(detectBand(base, 17)).toMatchObject({ status: "breach", tier: "3sigma", rule: "one point beyond 3 sigma" });
  });

  it("rule 2: two of three beyond 2 sigma on one side", () => {
    expect(detectBand([...base, 14.8], 15.5)).toMatchObject({
      status: "breach",
      tier: "2sigma",
      rule: "two of three points beyond 2 sigma on one side",
    });
    expect(detectBand([...base, 14.8], 9).status).toBe("in_band");
  });

  it("rule 3: four of five beyond 1 sigma on one side", () => {
    expect(detectBand([...base, 12.6, 12.6, 9, 12.6], 12.6)).toMatchObject({
      status: "breach",
      tier: "1sigma",
      rule: "four of five points beyond 1 sigma on one side",
    });
  });

  it("rule 4: eight in a row on one side", () => {
    const seven = Array.from({ length: 7 }, () => 10.5);
    expect(detectBand([...base, ...seven], 10.5)).toMatchObject({
      status: "breach",
      tier: "1sigma",
      rule: "eight points in a row on one side of the mean",
    });
    expect(detectBand([...base, ...seven.slice(1)], 10.5).status).toBe("in_band");
  });

  it("treats any change from a flat baseline as beyond 3 sigma", () => {
    expect(detectBand([5, 5, 5, 5, 5], 5)).toEqual({ status: "in_band", mean: 5, sigma: 0 });
    expect(detectBand([5, 5, 5, 5, 5], 5.1)).toMatchObject({ status: "breach", tier: "3sigma" });
  });
});

describe("bands files", () => {
  const write = (dir: string, metricId: string, text: string): void => {
    const file = bandsFile(dir, "g-a", metricId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  it("reads the playbook format", () => {
    const dir = makeTempDir();
    expect(readBands(dir, "g-a", "m-errors")).toBeNull();
    write(
      dir,
      "m-errors",
      [
        "metric: m-errors",
        "baseline: rolling_30d",
        "rules: western_electric",
        "tiers:",
        "  1sigma: { action: log }",
        '  2sigma: { action: diagnose, tools: "Read,Grep" }',
        "  3sigma: { action: propose, routes: [pull_request] }",
        "",
      ].join("\n"),
    );
    expect(readBands(dir, "g-a", "m-errors")).toMatchObject({ baseline: "rolling_30d", tiers: { "3sigma": { action: "propose" } } });
    expect(baselineWindowMs("rolling_30d")).toBe(30 * 86_400_000);
  });

  it("rejects a file for another metric or with an unknown action", () => {
    const dir = makeTempDir();
    write(dir, "m-errors", "metric: m-other\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  1sigma: { action: log }\n");
    expect(() => readBands(dir, "g-a", "m-errors")).toThrow(/is for metric m-other/);
    write(dir, "m-errors", "metric: m-errors\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  1sigma: { action: deploy }\n");
    expect(() => readBands(dir, "g-a", "m-errors")).toThrow(BandsError);
  });
});
