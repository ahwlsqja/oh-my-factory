import { referencedMetrics } from "../goal/goal-file.js";
import type { GoalSemantic } from "../goal/goal-file.js";
import type { IntentCandidate } from "./types.js";

export type LintRule = "number" | "metric-name";

/** Findings name the rule and the field, never the matched text: they are written to the ledger (spec §4.6). */
export interface LintFinding {
  rule: LintRule;
  field: string;
}

/** Phrases already normalized by `normalizeForTerms` (lowercase, every run of non-alphanumerics is one space). */
export interface ForbiddenTerms {
  phrases: string[];
}

/**
 * Lowercases, splits camelCase (`errorRate` becomes `error rate`) and turns every run of non-letters and
 * non-digits into one space, so `error-rate`, `ERROR_RATE` and `errorRate` all read `error rate`.
 */
function normalizeForTerms(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The names a seed must not carry (spec §4.9): for each metric id the goal references (for example
 * `m-error-rate`), the full id and its multi-token phrase without the `m-` prefix. Spelling variants
 * (`error rate`, `error-rate`, `error_rate`, `errorRate`) collapse to one phrase when text is normalized.
 * A single stem is forbidden only when it contains a digit (`p95`) or is the id's only stem (`m-latency`).
 * Ordinary single words such as `errors`, or `latency` of `m-p95-latency`, stay allowed: banning every stem would
 * reject most real objectives and starve the loop, and paraphrase is a documented limit of any deterministic lint.
 */
export function forbiddenTermsFor(semantic: GoalSemantic): ForbiddenTerms {
  const phrases = new Set<string>();
  for (const id of referencedMetrics(semantic)) {
    const stems = id.replace(/^m-/, "").split("-");
    phrases.add(["m", ...stems].join(" "));
    if (stems.length >= 2) phrases.add(stems.join(" "));
    for (const stem of stems) {
      if (stems.length === 1 || /\d/.test(stem)) phrases.add(stem);
    }
  }
  return { phrases: [...phrases].sort() };
}

const NO_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const NO_WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;
const NO_LETTER_BEFORE = String.raw`(?<![\p{L}_])`;
const UNIT = String.raw`(?:ms|s|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|kb|mb|gb|tb|x|req\/s|qps|rps|users?|percent|per\s*cent)`;
const NUMBER_WORD =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|" +
  "eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)";
const WORD_UNIT = String.raw`(?:%|percent|per\s*cent|ms|seconds?|minutes?|hours?|days?|kb|mb|gb|users?|requests?)`;
const COMPARATOR = String.raw`(?:under|below|over|above|at\s+most|at\s+least|within|less\s+than|more\s+than)`;

/** Each pattern is one way a threshold can be written. Any hit is rule `number`. */
const NUMBER_PATTERNS: readonly RegExp[] = [
  // a decimal number: 3.5, 0.25, 1.2.3
  /\d+\.\d+/u,
  // a thousands separator: 1,200
  /\d{1,3}(?:,\d{3})+/u,
  // two or more digits standing alone; digits glued to a letter (utf8, sha256, v2, p95) are names, not values
  new RegExp(`${NO_WORD_BEFORE}\\d{2,}`, "u"),
  // a percentage
  /\d[ \t]*%/u,
  // a number next to a unit word, even a single digit: 5 minutes, 250ms, 2x
  new RegExp(`${NO_LETTER_BEFORE}\\d+[ \\t]*${UNIT}${NO_WORD_AFTER}`, "iu"),
  // a symbol comparator right before a number: <250, >= 3
  /(?:<=|>=|<|>|≤|≥)\s*\d/u,
  // a word comparator with a number within two words: at most 4, under about 250
  new RegExp(`${NO_WORD_BEFORE}${COMPARATOR}${NO_WORD_AFTER}(?:[^\\p{L}\\p{N}]+\\p{L}+){0,2}[^\\p{L}\\p{N}]*\\d`, "iu"),
  // a number written in words next to a unit: twenty percent, five hundred ms
  new RegExp(`${NO_WORD_BEFORE}${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*[ \\t]*${WORD_UNIT}${NO_WORD_AFTER}`, "iu"),
];

/** An ordered-list marker at the start of a line (`1. `, `2) `) is structure, not a number. */
function withoutListMarkers(text: string): string {
  return text.replace(/^[ \t]*\d+[.)][ \t]+/gmu, "");
}

function hasPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

/**
 * Seed lint for one text field (spec §4.9). Rule `number` rejects any way of writing a threshold; rule `metric-name`
 * rejects a forbidden phrase on a word boundary. A single digit standing alone (`step 2`, `add 3 retries`) is allowed:
 * it cannot carry a target, and banning it would reject ordinary instructions. At most one finding per rule.
 */
export function lintText(field: string, text: string, terms: ForbiddenTerms): LintFinding[] {
  const findings: LintFinding[] = [];
  const prose = withoutListMarkers(text);
  if (NUMBER_PATTERNS.some((pattern) => pattern.test(prose))) findings.push({ rule: "number", field });
  const normalized = normalizeForTerms(text);
  if (terms.phrases.some((phrase) => hasPhrase(normalized, phrase))) findings.push({ rule: "metric-name", field });
  return findings;
}

/**
 * A declared path is lint-checked more narrowly than prose: forbidden phrases (so `bench/m-p95.sh` cannot name a
 * metric), decimal numbers (`python3.12`) and digit runs of four or more (dates, ports, thresholds).
 * Short digit runs (`docs/v2`) are ordinary names.
 */
function lintPath(field: string, path: string, terms: ForbiddenTerms): LintFinding[] {
  const findings: LintFinding[] = [];
  if (/\d+\.\d+/u.test(path) || /\d{4,}/u.test(path)) findings.push({ rule: "number", field });
  const normalized = normalizeForTerms(path);
  if (terms.phrases.some((phrase) => hasPhrase(normalized, phrase))) findings.push({ rule: "metric-name", field });
  return findings;
}

/** Lints every free-text field of a candidate and its declared paths. The order of findings follows the field order. */
export function lintCandidate(candidate: IntentCandidate, terms: ForbiddenTerms): LintFinding[] {
  const findings: LintFinding[] = [
    ...lintText("title", candidate.title, terms),
    ...lintText("problem", candidate.problem, terms),
    ...lintText("proposed_outcome", candidate.proposed_outcome, terms),
    ...lintText("affected_users_systems", candidate.affected_users_systems, terms),
    ...lintText("constraints", candidate.constraints, terms),
    ...lintText("rationale", candidate.rationale, terms),
  ];
  candidate.open_questions.forEach((question, index) => {
    findings.push(...lintText(`open_questions[${index}]`, question, terms));
  });
  candidate.affected_paths.forEach((path, index) => {
    findings.push(...lintPath(`affected_paths[${index}]`, path, terms));
  });
  return findings;
}
