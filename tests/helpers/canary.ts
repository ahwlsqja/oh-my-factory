/**
 * Strings that must never reach a model, a stored work item or a log (spec §4.6, F6). They are chosen to
 * be found by a plain search: no common word contains them, and no hash or id can contain the digit stems
 * as a standalone token.
 */
export const CANARY = {
  /** What the target metric prints on the first tick. */
  reading: "4817.39",
  /** What it prints on the second tick. */
  nextReading: "4903.11",
  /** The locked target value in goal.md. */
  target: "3719.25",
  metricId: "m-zebra-quokka",
  metricWords: ["zebra", "quokka"],
  /** The metric's script and its only watched path; part of the metric command. */
  watchedPath: "bench/canary-qwerty.sh",
  watchedStem: "canary-qwerty",
} as const;

export const CLEAN_TITLE = "Defer work on the checkout render path";

/**
 * A candidate that passes every filter: plain words, no number, no metric name, a path that is not high
 * risk. It is the control in every leak test, and `reconciler-stub.mjs` builds the same one (its unit test
 * compares the two).
 */
export const CLEAN_CANDIDATE = {
  title: CLEAN_TITLE,
  problem: "The page does extra work before it can answer.",
  proposed_outcome: "Do that work later so the first answer goes out sooner.",
  affected_users_systems: "Shoppers on the checkout page and the render service.",
  constraints: "",
  open_questions: [] as string[],
  rationale: "Deferring the work removes it from the path every request takes.",
  affected_paths: ["src/render"],
};

interface Needle {
  label: string;
  pattern: RegExp;
}

function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** The integer part of a value as a whole token: not glued to letters or digits, so a hex id never matches. */
function stem(value: string): RegExp {
  return new RegExp(`(?<![0-9A-Za-z])${value.slice(0, value.indexOf("."))}(?![0-9A-Za-z])`);
}

const NEEDLES: readonly Needle[] = [
  { label: "reading", pattern: literal(CANARY.reading) },
  { label: "next reading", pattern: literal(CANARY.nextReading) },
  { label: "target", pattern: literal(CANARY.target) },
  { label: "reading digits", pattern: stem(CANARY.reading) },
  { label: "next reading digits", pattern: stem(CANARY.nextReading) },
  { label: "target digits", pattern: stem(CANARY.target) },
  { label: "metric id", pattern: literal(CANARY.metricId) },
  { label: `metric word ${CANARY.metricWords[0]}`, pattern: literal(CANARY.metricWords[0]) },
  { label: `metric word ${CANARY.metricWords[1]}`, pattern: literal(CANARY.metricWords[1]) },
  { label: "watched path", pattern: literal(CANARY.watchedStem) },
];

/** The label of every canary found in `text`, in a fixed order, each once. Empty means no leak. */
export function canaryHits(text: string): string[] {
  return NEEDLES.filter((needle) => needle.pattern.test(text)).map((needle) => needle.label);
}
