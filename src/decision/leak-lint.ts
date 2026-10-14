import type { LedgerEvent } from "../core/ledger.js";
import type { GoalSemantic } from "../goal/goal-file.js";
import { readGoalLock } from "../goal/goal-lock.js";
import { type ForbiddenTerms, forbiddenTermsFor, lintText } from "../work/seed-lint.js";
import { DecisionError } from "./errors.js";

/**
 * What a decision must not reveal (spec §4.6, F6): the metric names, the locked target and the readings the
 * goal has produced so far. Built from the goal lock, so it always matches the regime G is working under.
 */
export interface LeakContext {
  /** forbiddenTermsFor(semantic): metric id phrases. */
  terms: ForbiddenTerms;
  /** The locked target as plain decimal text, for the word-bounded literal rule. */
  targetValues: readonly string[];
  /** The locked target as numbers, for the numeric rule. */
  targetNumbers: readonly number[];
  /** Every `metric.measured` value of the goal in the verified ledger. */
  measuredNumbers: readonly number[];
  /**
   * The same readings with the ledger seq each was recorded at, set by `loadLeakContext` and absent otherwise.
   * `leakContextAt` uses it to ask what a record could have seen when it was written (A22).
   */
  readings?: readonly { seq: number; value: number }[];
}

export type LeakRule = "metric-name" | "target-value" | "number-value";

/** Names the rule and the field, never the matched text: findings are written to the ledger (spec §4.6). */
export interface LeakFinding {
  rule: LeakRule;
  field: string;
}

/**
 * Keys OMF fills in or that have a fixed shape, so a person's text cannot be in them. `percentile` is a 0..100
 * shape number (p95), not a measurement. `id` is deliberately not here: an id is free text a person chooses
 * and it reaches `spec.md` (A16b).
 */
const OMF_SET_KEYS: ReadonlySet<string> = new Set(["class", "by", "at", "signed_by", "expires_at", "op", "kind", "percentile"]);

/**
 * One number in running text: `12`, `12.0`, `3,719.25`, `250ms`. A token is not part of a longer number
 * (`12` is not in `127`), and digits glued to a preceding letter or underscore are a name (`p95`, `utf8`, `v12`),
 * the same call seed lint makes. A unit after the digits does not hide the value.
 */
const NUMBER_TOKEN = /(?<![\p{L}\p{N}_])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?!\d)/gu;

/** The target as the plain decimal text a person would type. */
function decimalText(value: number): string {
  return String(value);
}

/** Forbidden terms and the locked target. `measured` is the goal's readings so far; none by default. */
export function leakContextFor(semantic: GoalSemantic, measured: readonly number[] = []): LeakContext {
  const value = semantic.target.value;
  return {
    terms: forbiddenTermsFor(semantic),
    targetValues: [decimalText(value)],
    targetNumbers: [value],
    measuredNumbers: [...measured],
  };
}

/**
 * Reads the goal lock and the `metric.measured` readings of the verified ledger (payload field `value`, see
 * `measureGoal`). A missing lock throws `goal_not_locked`: with no lock there is nothing to compare against, and a
 * lint that cannot run must not wave text through (fail closed). A lock file that is present but unreadable or
 * schema-invalid throws its `GoalLockError` unchanged: that is damaged host state, so the CLI exits 2 (A20).
 */
export function loadLeakContext(projectDir: string, goalId: string, events: readonly LedgerEvent[]): LeakContext {
  const lock = readGoalLock(projectDir, goalId);
  if (lock === null) throw new DecisionError("goal_not_locked", `goal ${goalId} has no lock; approve it (J1) before recording decisions`);
  const readings: { seq: number; value: number }[] = [];
  for (const event of events) {
    if (event.type !== "metric.measured" || event.payload.goal_id !== goalId) continue;
    const value = event.payload.value;
    if (typeof value === "number" && Number.isFinite(value)) readings.push({ seq: event.seq, value });
  }
  return { ...leakContextFor(lock.semantic, distinctSorted(readings)), readings };
}

function distinctSorted(readings: readonly { value: number }[]): number[] {
  return [...new Set(readings.map((reading) => reading.value))].sort((a, b) => a - b);
}

/**
 * The context as it stood at ledger `seq`: the same terms and target (the current lock), but only the readings
 * recorded at or before `seq`. Readings keep arriving with every tick, so a record that was clean when it was
 * written must not turn invalid because a later reading happens to share a number with it (A22). A context built
 * without per-reading seqs is returned unchanged.
 */
export function leakContextAt(ctx: LeakContext, seq: number): LeakContext {
  if (ctx.readings === undefined) return ctx;
  return { ...ctx, measuredNumbers: distinctSorted(ctx.readings.filter((reading) => reading.seq <= seq)) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `value` as a whole token: no letter, digit or `1.`-style prefix before it, no digit or `.5`-style tail after it. */
function hasLiteral(text: string, value: string): boolean {
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_]|\p{N}[.,])${escapeRegExp(value)}(?!\p{N}|[.,]\p{N})`, "u");
  return pattern.test(text);
}

/** An integer below 10 in magnitude (0 included): one digit cannot carry a target, and seed lint lets it through (A16a). */
function isLoneDigit(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) < 10;
}

/**
 * Equal to the reference, or equal to its integer part (3719 for 3719.25). An integer part of 0 carries nothing, so
 * it is not refused. `numberLeaks` decides which references a lone digit is compared with.
 */
function sameNumber(value: number, reference: number): boolean {
  const v = Math.abs(value);
  const r = Math.abs(reference);
  if (v === r) return true;
  const whole = Math.trunc(r);
  return whole !== 0 && v === whole;
}

function numberLeaks(value: number, ctx: LeakContext): boolean {
  if (!Number.isFinite(value)) return false;
  if (ctx.targetNumbers.some((target) => (isLoneDigit(value) ? Math.abs(value) === Math.abs(target) : sameNumber(value, target)))) {
    return true;
  }
  if (isLoneDigit(value)) return false;
  return ctx.measuredNumbers.some((reading) => sameNumber(value, reading));
}

function numberTokens(text: string): number[] {
  const tokens: number[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    tokens.push(Number(`${(match[1] ?? "").replaceAll(",", "")}${match[2] ?? ""}`));
  }
  return tokens;
}

function stringRules(field: string, text: string, ctx: LeakContext): LeakRule[] {
  const rules: LeakRule[] = [];
  // seed lint's own `number` finding is dropped: decisions must carry numeric thresholds (spec 409)
  if (lintText(field, text, ctx.terms).some((finding) => finding.rule === "metric-name")) rules.push("metric-name");
  if (ctx.targetValues.some((value) => hasLiteral(text, value))) rules.push("target-value");
  if (numberTokens(text).some((token) => numberLeaks(token, ctx))) rules.push("number-value");
  return rules;
}

function walk(node: unknown, path: string, ctx: LeakContext, add: (rule: LeakRule, field: string) => void): void {
  if (typeof node === "string") {
    for (const rule of stringRules(path, node, ctx)) add(rule, path);
  } else if (typeof node === "number") {
    if (numberLeaks(node, ctx)) add("number-value", path);
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}[${index}]`, ctx, add));
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      if (OMF_SET_KEYS.has(key)) continue;
      walk(record[key], path === "" ? key : `${path}.${key}`, ctx, add);
    }
  }
}

/**
 * Walks every leaf of `body` (strings and numbers, `id` included) and reports what leaks, as rule and field path.
 * Keys are visited in sorted order and each (rule, field) is reported once, so the result does not depend on
 * how the caller built the object.
 *
 * Documented limit (A18): near values (3700 for 3719.25), paraphrases ("about a dozen"), single stems of a
 * multi-stem metric id and watched-path stems are not detected. Seed lint's phrase set is kept on purpose:
 * forbidding every stem ("search", "cost") would make ordinary decision text unwritable.
 */
export function lintDecisionStrings(body: unknown, ctx: LeakContext): LeakFinding[] {
  const findings: LeakFinding[] = [];
  const seen = new Set<string>();
  walk(body, "", ctx, (rule, field) => {
    const key = `${rule}\u0000${field}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, field });
  });
  return findings;
}
