import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { validate } from "../core/schema.js";
import { goalDir } from "./goal-file.js";

export type Tier = "1sigma" | "2sigma" | "3sigma";
export type BandAction = "log" | "diagnose" | "propose";

export interface BandTier {
  action: BandAction;
  tools?: string;
  routes?: string[];
}

export interface BandsConfig {
  metric: string;
  baseline: string;
  rules: "western_electric";
  tiers: Partial<Record<Tier, BandTier>>;
}

export type BandResult =
  | { status: "insufficient_baseline"; points: number }
  | { status: "in_band"; mean: number; sigma: number }
  | { status: "breach"; tier: Tier; rule: string; mean: number; sigma: number };

export const MIN_BASELINE_POINTS = 5;

export class BandsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BandsError";
  }
}

export function bandsFile(projectDir: string, goalId: string, metricId: string): string {
  return join(goalDir(projectDir, goalId), "bands", `${metricId}.yaml`);
}

/** Reads `goals/<goal>/bands/<metric>.yaml` in the playbook's format, or null when there is none. */
export function readBands(projectDir: string, goalId: string, metricId: string): BandsConfig | null {
  const file = bandsFile(projectDir, goalId, metricId);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new BandsError(`${file} is not valid YAML: ${(err as Error).message}`);
  }
  const check = validate("bands.schema.json", data);
  if (!check.ok) throw new BandsError(`${file} is invalid: ${check.errors}`);
  const config = data as BandsConfig;
  if (config.metric !== metricId) throw new BandsError(`${file} is for metric ${config.metric}, expected ${metricId}`);
  return config;
}

export function baselineWindowMs(baseline: string): number {
  const match = /^rolling_([1-9][0-9]*)d$/.exec(baseline);
  if (match === null) throw new BandsError(`unsupported baseline ${baseline}; use rolling_<days>d`);
  return Number(match[1]) * 86_400_000;
}

/**
 * Western Electric rules over a rolling baseline (spec §4.3). Deterministic; no model is involved.
 * `history` is chronological and excludes `current`; mean and sigma come from `history`. The strongest
 * matching rule wins. A flat baseline (sigma 0) treats any change as beyond 3 sigma.
 */
export function detectBand(history: readonly number[], current: number): BandResult {
  if (history.length < MIN_BASELINE_POINTS) return { status: "insufficient_baseline", points: history.length };
  const mean = history.reduce((sum, x) => sum + x, 0) / history.length;
  const sigma = Math.sqrt(history.reduce((sum, x) => sum + (x - mean) ** 2, 0) / history.length);
  const z = (x: number): number => {
    if (sigma > 0) return (x - mean) / sigma;
    return x === mean ? 0 : Math.sign(x - mean) * Number.POSITIVE_INFINITY;
  };
  const recent = [...history, current];
  const tail = (n: number): number[] => recent.slice(-n).map(z);
  const zc = z(current);
  const side = Math.sign(zc);
  const beyond = (values: number[], limit: number): number =>
    values.filter((v) => Math.sign(v) === side && Math.abs(v) > limit).length;

  if (Math.abs(zc) > 3) return { status: "breach", tier: "3sigma", rule: "one point beyond 3 sigma", mean, sigma };
  if (side !== 0 && Math.abs(zc) > 2 && beyond(tail(3), 2) >= 2) {
    return { status: "breach", tier: "2sigma", rule: "two of three points beyond 2 sigma on one side", mean, sigma };
  }
  if (side !== 0 && Math.abs(zc) > 1 && beyond(tail(5), 1) >= 4) {
    return { status: "breach", tier: "1sigma", rule: "four of five points beyond 1 sigma on one side", mean, sigma };
  }
  if (side !== 0 && recent.length >= 8 && tail(8).every((v) => Math.sign(v) === side)) {
    return { status: "breach", tier: "1sigma", rule: "eight points in a row on one side of the mean", mean, sigma };
  }
  return { status: "in_band", mean, sigma };
}
