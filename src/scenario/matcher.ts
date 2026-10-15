import type { Expect, JsonScalar, StepObservation } from "./types.js";

/**
 * OMF's own matcher for model-authored `stdout_matches` and `json_path` (spec §5.3, M3-D5). A scenario is
 * written by a model, so its pattern is hostile input: it is compiled into a program of single-character
 * items and run as a Thompson set simulation, O(n * m) time and O(m) space, and nothing here builds a host
 * regex engine object from it.
 *
 * Grammar of an anchored pattern (the only pattern form): '^' atom* '$' with no other anchor.
 *   atom  := literal | '.' | '\d' | '\w' | '\s' | '\D' | '\W' | '\S' | '\' meta | class
 *   class := '[' '^'? (char | range 'a-z' | '\d' | '\w' | '\s')+ ']'
 *   an atom may be followed by one of '*', '+', '?'
 * '.' is any code point except '\n'; a negated class does match '\n'. No groups, alternation, counted
 * repeats, back-references, lookaround or flags: they are refused at compile time, so a nested-quantifier
 * pattern never exists to be evaluated.
 */
export type PatternError = "not_anchored" | "unsupported_construct" | "bad_escape" | "bad_class" | "too_long" | "empty_class";
export const MAX_PATTERN_LENGTH = 512;
/** Characters (UTF-16 units). Longer input never matches, so a step costs a bounded amount. */
export const MAX_MATCH_INPUT = 1024 * 1024;

type ClassEscape = "d" | "w" | "s";
type Atom =
  | { t: "lit"; cp: number }
  | { t: "any" }
  | { t: "esc"; c: ClassEscape; neg: boolean }
  | { t: "class"; neg: boolean; ranges: readonly (readonly [number, number])[]; escs: readonly ClassEscape[] };
/** `plus` is compiled to `one` followed by `star`, so the simulation only knows three quantifiers. */
export interface PatternItem {
  readonly atom: Atom;
  readonly quant: "one" | "star" | "opt";
}
export interface PatternProgram {
  readonly items: readonly PatternItem[];
}

const META = new Set(Array.from("\\^$.*+?()[]{}|-/"));
const FORBIDDEN = new Set(Array.from("(){}|"));

type Parsed<T> = ({ ok: true; next: number } & T) | { ok: false; error: PatternError };

function escapeMatches(c: ClassEscape, cp: number): boolean {
  if (c === "d") return cp >= 0x30 && cp <= 0x39;
  if (c === "w") return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
  return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d);
}

function atomMatches(atom: Atom, cp: number): boolean {
  switch (atom.t) {
    case "lit":
      return atom.cp === cp;
    case "any":
      return cp !== 0x0a;
    case "esc":
      return escapeMatches(atom.c, cp) !== atom.neg;
    case "class": {
      const listed = atom.ranges.some(([lo, hi]) => cp >= lo && cp <= hi) || atom.escs.some((c) => escapeMatches(c, cp));
      return listed !== atom.neg;
    }
  }
}

/** Parses `[...]` starting at the '['. */
function parseClass(cps: readonly string[], start: number): Parsed<{ atom: Atom }> {
  let i = start + 1;
  let neg = false;
  if (cps[i] === "^") {
    neg = true;
    i++;
  }
  const ranges: [number, number][] = [];
  const escs: ClassEscape[] = [];
  for (;;) {
    const c = cps[i];
    if (c === undefined) return { ok: false, error: "bad_class" };
    if (c === "]") {
      i++;
      break;
    }
    let lo: number;
    if (c === "\\") {
      const n = cps[i + 1];
      if (n === undefined) return { ok: false, error: "bad_escape" };
      if (n === "d" || n === "w" || n === "s") {
        escs.push(n);
        i += 2;
        continue;
      }
      if (!META.has(n)) return { ok: false, error: "bad_escape" };
      lo = n.codePointAt(0) as number;
      i += 2;
    } else {
      lo = c.codePointAt(0) as number;
      i++;
    }
    const dash = cps[i];
    const upper = cps[i + 1];
    if (dash === "-" && upper !== undefined && upper !== "]") {
      let hi: number;
      if (upper === "\\") {
        const n = cps[i + 2];
        if (n === undefined || !META.has(n)) return { ok: false, error: "bad_escape" };
        hi = n.codePointAt(0) as number;
        i += 3;
      } else {
        hi = upper.codePointAt(0) as number;
        i += 2;
      }
      if (hi < lo) return { ok: false, error: "bad_class" };
      ranges.push([lo, hi]);
    } else {
      ranges.push([lo, lo]);
    }
  }
  if (ranges.length === 0 && escs.length === 0) return { ok: false, error: "empty_class" };
  return { ok: true, next: i, atom: { t: "class", neg, ranges, escs } };
}

/** Parses one atom starting at `i` (not '$', which the caller handles). */
function parseAtom(cps: readonly string[], i: number): Parsed<{ atom: Atom }> {
  const ch = cps[i] as string;
  if (FORBIDDEN.has(ch) || ch === "^" || ch === "*" || ch === "+" || ch === "?") return { ok: false, error: "unsupported_construct" };
  if (ch === "[") return parseClass(cps, i);
  if (ch === ".") return { ok: true, next: i + 1, atom: { t: "any" } };
  if (ch === "\\") {
    const n = cps[i + 1];
    if (n === undefined) return { ok: false, error: "bad_escape" };
    const lower = n.toLowerCase();
    if (n.length === 1 && (lower === "d" || lower === "w" || lower === "s")) {
      return { ok: true, next: i + 2, atom: { t: "esc", c: lower, neg: n !== lower } };
    }
    if (!META.has(n)) return { ok: false, error: "bad_escape" };
    return { ok: true, next: i + 2, atom: { t: "lit", cp: n.codePointAt(0) as number } };
  }
  return { ok: true, next: i + 1, atom: { t: "lit", cp: ch.codePointAt(0) as number } };
}

export function compilePattern(pattern: string): { ok: true; program: PatternProgram } | { ok: false; error: PatternError } {
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, error: "too_long" };
  const cps = Array.from(pattern);
  if (cps[0] !== "^") return { ok: false, error: "not_anchored" };
  const items: PatternItem[] = [];
  let i = 1;
  let closed = false;
  while (i < cps.length) {
    if (cps[i] === "$") {
      if (i !== cps.length - 1) return { ok: false, error: "unsupported_construct" };
      closed = true;
      break;
    }
    const parsed = parseAtom(cps, i);
    if (!parsed.ok) return parsed;
    i = parsed.next;
    const q = cps[i];
    if (q === "*") items.push({ atom: parsed.atom, quant: "star" });
    else if (q === "?") items.push({ atom: parsed.atom, quant: "opt" });
    else if (q === "+") {
      items.push({ atom: parsed.atom, quant: "one" }, { atom: parsed.atom, quant: "star" });
    } else {
      items.push({ atom: parsed.atom, quant: "one" });
      continue;
    }
    i++;
  }
  if (!closed) return { ok: false, error: "not_anchored" };
  return { ok: true, program: { items } };
}

/** Epsilon closure: a star or optional item can be skipped, and the skip only ever moves forward. */
function close(items: readonly PatternItem[], states: Uint8Array): void {
  for (let s = 0; s < items.length; s++) {
    if (states[s] === 1 && (items[s] as PatternItem).quant !== "one") states[s + 1] = 1;
  }
}

/** `steps` counts (character, active state) transitions, so a test asserts the O(n * m) bound without timing. */
export function matchWhole(program: PatternProgram, input: string): { matched: boolean; steps: number } {
  const items = program.items;
  const m = items.length;
  if (input.length > MAX_MATCH_INPUT) return { matched: false, steps: 0 };
  let current = new Uint8Array(m + 1);
  let next = new Uint8Array(m + 1);
  current[0] = 1;
  close(items, current);
  let steps = 0;
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    next.fill(0);
    let alive = false;
    for (let s = 0; s < m; s++) {
      if (current[s] === 0) continue;
      steps++;
      const item = items[s] as PatternItem;
      if (!atomMatches(item.atom, cp)) continue;
      if (item.quant === "star") next[s] = 1;
      else next[s + 1] = 1;
      alive = true;
    }
    if (!alive) return { matched: false, steps };
    close(items, next);
    [current, next] = [next, current];
  }
  return { matched: current[m] === 1, steps };
}

const MAX_JSON_PATH_SEGMENTS = 16;

const isIdentStart = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= "0" && c <= "9");
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** `$` then `.name` (name starts with a letter or underscore) or `[n]` segments, at most 16. Anything else is unsupported. */
export function compileJsonPath(path: string): { ok: true; segments: readonly (string | number)[] } | { ok: false } {
  if (path[0] !== "$") return { ok: false };
  const segments: (string | number)[] = [];
  let i = 1;
  while (i < path.length) {
    if (segments.length >= MAX_JSON_PATH_SEGMENTS) return { ok: false };
    if (path[i] === ".") {
      let j = i + 1;
      if (j >= path.length || !isIdentStart(path[j] as string)) return { ok: false };
      while (j < path.length && isIdentPart(path[j] as string)) j++;
      segments.push(path.slice(i + 1, j));
      i = j;
    } else if (path[i] === "[") {
      let j = i + 1;
      while (j < path.length && isDigit(path[j] as string)) j++;
      const digits = path.slice(i + 1, j);
      if (path[j] !== "]" || digits === "" || digits.length > 6 || (digits.length > 1 && digits[0] === "0")) return { ok: false };
      segments.push(Number(digits));
      i = j + 1;
    } else {
      return { ok: false };
    }
  }
  return { ok: true, segments };
}

/** Own properties and in-range indexes only, so `$.toString` or `$.a.length` is never found. */
export function evaluateJsonPath(doc: unknown, segments: readonly (string | number)[]): { found: true; value: unknown } | { found: false } {
  let value: unknown = doc;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(value) || segment >= value.length) return { found: false };
      value = value[segment];
    } else {
      if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, segment)) return { found: false };
      value = (value as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value };
}

export type ExpectFailure = "not_exited" | "exit_code" | "stdout" | "json_parse" | "json_path";
export type ExpectVerdict = { pass: true } | { pass: false; failed: ExpectFailure[] };

/**
 * Judges one step. An exact match is whole-stdout string equality: nothing is trimmed, and the trailing
 * newline is part of the text (the seal prompt tells the author). A step that did not exit by itself fails
 * with not_exited, whatever the expectation. An anchored pattern that does not compile fails the step
 * (intake already refused it; this is defence in depth). stdout above MAX_MATCH_INPUT fails.
 * An expectation with nothing to check passes here: intake and lint refuse it (`expect_empty`) and the
 * GATE-2 null probes catch one that slipped through, so this function stays a plain evaluator.
 */
export function evaluateExpect(expectation: Expect, observation: StepObservation): ExpectVerdict {
  if (observation.outcome !== "exited") return { pass: false, failed: ["not_exited"] };
  const failed: ExpectFailure[] = [];
  const { stdout } = observation;
  if (expectation.exit_code !== null && observation.exit_code !== expectation.exit_code) failed.push("exit_code");
  const wanted = expectation.stdout_matches;
  if (wanted !== null) {
    let ok = stdout.length <= MAX_MATCH_INPUT;
    if (ok && wanted.kind === "exact") ok = stdout === wanted.text;
    else if (ok && wanted.kind === "anchored") {
      const compiled = compilePattern(wanted.pattern);
      ok = compiled.ok && matchWhole(compiled.program, stdout).matched;
    }
    if (!ok) failed.push("stdout");
  }
  if (expectation.json_path !== null) {
    let doc: unknown;
    let parsed = stdout.length <= MAX_MATCH_INPUT;
    if (parsed) {
      try {
        doc = JSON.parse(stdout);
      } catch {
        parsed = false;
      }
    }
    if (!parsed) failed.push("json_parse");
    else if (!Object.entries(expectation.json_path).every(([path, expected]) => jsonPathHolds(doc, path, expected))) failed.push("json_path");
  }
  return failed.length === 0 ? { pass: true } : { pass: false, failed };
}

function jsonPathHolds(doc: unknown, path: string, expected: JsonScalar): boolean {
  const compiled = compileJsonPath(path);
  if (!compiled.ok) return false;
  const found = evaluateJsonPath(doc, compiled.segments);
  return found.found && found.value === expected;
}
