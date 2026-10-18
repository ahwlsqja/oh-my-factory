// covers: F5.bands-detect-regression
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BandsError,
  bandsFile,
  bandsLockInfo,
  bandsLockInfoOf,
  baselineWindowMs,
  detectBand,
  readBands,
} from "../../src/goal/bands.js";
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
    expect(readBands(dir, "g-a", "m-errors")).toMatchObject({
      baseline: "rolling_30d",
      tiers: { "3sigma": { action: "propose" } },
    });
    expect(baselineWindowMs("rolling_30d")).toBe(30 * 86_400_000);
  });

  it("rejects a file for another metric or with an unknown action", () => {
    const dir = makeTempDir();
    write(
      dir,
      "m-errors",
      "metric: m-other\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  1sigma: { action: log }\n",
    );
    expect(() => readBands(dir, "g-a", "m-errors")).toThrow(/is for metric m-other/);
    write(
      dir,
      "m-errors",
      "metric: m-errors\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  1sigma: { action: deploy }\n",
    );
    expect(() => readBands(dir, "g-a", "m-errors")).toThrow(BandsError);
  });
});

describe("bandsLockInfo", () => {
  const write = (dir: string, metricId: string, text: string): void => {
    const file = bandsFile(dir, "g-fast", metricId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const plain = (metricId: string, action = "propose"): string =>
    `metric: ${metricId}\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  3sigma: { action: ${action} }\n`;

  it("hashes the parsed config per metric and uses null where there is no file", () => {
    const dir = makeTempDir();
    write(dir, "m-errors", plain("m-errors"));
    const info = bandsLockInfo(dir, "g-fast", ["m-p95", "m-errors"]);
    expect(Object.keys(info.map).sort()).toEqual(["m-errors", "m-p95"]);
    expect(info.map["m-p95"]).toBeNull();
    expect(info.map["m-errors"]).toMatch(/^[0-9a-f]{64}$/);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores comments, key order and metric order, and sees a changed tier", () => {
    const dir = makeTempDir();
    write(dir, "m-errors", plain("m-errors"));
    const first = bandsLockInfo(dir, "g-fast", ["m-p95", "m-errors"]);
    write(
      dir,
      "m-errors",
      "# widened later? no, only reformatted\ntiers:\n  3sigma:\n    action: propose\nrules: western_electric\nbaseline: rolling_30d\nmetric: m-errors\n",
    );
    expect(bandsLockInfo(dir, "g-fast", ["m-errors", "m-p95"])).toEqual(first);
    write(dir, "m-errors", plain("m-errors", "log"));
    expect(bandsLockInfo(dir, "g-fast", ["m-p95", "m-errors"]).sha256).not.toBe(first.sha256);
  });

  it("changes when a file is created", () => {
    const dir = makeTempDir();
    const none = bandsLockInfo(dir, "g-fast", ["m-errors"]);
    write(dir, "m-errors", plain("m-errors"));
    const created = bandsLockInfo(dir, "g-fast", ["m-errors"]);
    expect(created.sha256).not.toBe(none.sha256);
    expect(created.map["m-errors"]).not.toBeNull();
  });

  it("throws BandsError for a file that is not valid bands", () => {
    const dir = makeTempDir();
    write(dir, "m-errors", "metric: [\n");
    expect(() => bandsLockInfo(dir, "g-fast", ["m-errors"])).toThrow(BandsError);
  });

  it("bandsLockInfoOf hashes configs already read, independent of key order", () => {
    expect(bandsLockInfoOf({ "m-b": null, "m-a": null })).toEqual(bandsLockInfoOf({ "m-a": null, "m-b": null }));
    expect(bandsLockInfoOf({ "m-a": null }).map).toEqual({ "m-a": null });
  });
});
