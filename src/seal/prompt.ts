import { canonicalize } from "../core/canonical-json.js";
import { type LeakContext, lintDecisionStrings } from "../decision/leak-lint.js";
import { renderSpec } from "../decision/spec-md.js";
import { findDecision } from "../decision/state.js";
import { DECISION_ID_PATTERN, INTERFACE_DECISION_ID, type DecisionState, type InterfaceContract, isQuantitative } from "../decision/types.js";
import type { SealFeedback } from "../scenario/types.js";
import { renderIntent } from "../work/intent-md.js";
import { lintCandidate } from "../work/seed-lint.js";
import type { WorkItem } from "../work/types.js";

/**
 * The closed set of things an author may see (M3c-D12): no plan field, no code field, no diff field, no path field.
 * Adding a field here is a change to what the author can know, so `buildSealPrompt` also refuses any other own key
 * at run time, in case a widened object reaches it through a cast.
 */
export interface SealInputs {
  /** `renderIntent` without its front matter, after the leak gate in `sealInputsFor`. */
  readonly intent: string;
  /** Rendered from the verified ledger; the host `spec.md` is never read. */
  readonly spec: string;
  readonly contract: InterfaceContract;
  /** Resolved and not quantitative: the only ids a scenario may name. */
  readonly linkable_decision_ids: readonly string[];
  /** Resolved and quantitative: naming one invalidates the scenario (M3-D17). */
  readonly quantitative_decision_ids: readonly string[];
  readonly feedback?: SealFeedback;
}

export type SealInputErrorCode = "forbidden_input" | "interface_missing" | "interface_not_supported" | "intent_leak" | "too_large";

/** The message is the code and nothing else, so no intent text reaches a log through an error. */
export class SealInputError extends Error {
  constructor(readonly code: SealInputErrorCode) {
    super(code);
    this.name = "SealInputError";
  }
}

/** Intent, spec and contract together. The cap only stops a runaway item; a real one is a few KB. */
export const MAX_SEAL_INPUT_CHARS = 200_000;

const INPUT_KEYS: readonly string[] = ["intent", "spec", "contract", "linkable_decision_ids", "quantitative_decision_ids", "feedback"];

/** The YAML block at the top of `intent.md`: goal id, work id, fingerprint, rationale and affected paths. The author sees none of it. */
const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;

/**
 * Builds the inputs from the item and the folded state (spec §5.3). In this order:
 * - `interface_missing`: `d-interface` is absent, open, deferred or n/a, or resolved without a body;
 * - `interface_not_supported`: the contract's kind is `http`. Every authored scenario would be refused at intake, so
 *   nothing is spent on the author (M3-D5);
 * - `intent_leak`: the intent fails the seed lint or the decision leak rules under the current lock. `intent.md` has no
 *   hash in `work.created` and is not re-linted after creation, so after a goal re-lock or a hand edit it can hold the
 *   locked target or a metric name. M3a withholds such text from `spec.md`; this does the same for the seal prompt;
 * - `too_large`.
 * GATE-1 has already passed when the stage calls this, so no resolved record is withheld from the spec.
 */
export function sealInputsFor(item: WorkItem, state: DecisionState, leak: LeakContext, feedback?: SealFeedback): SealInputs {
  const record = findDecision(state, INTERFACE_DECISION_ID);
  const contract = record !== null && record.status === "resolved" ? record.interface : null;
  if (contract === null) throw new SealInputError("interface_missing");
  if (contract.kind !== "cli") throw new SealInputError("interface_not_supported");

  const candidate = item.intent.candidate;
  if (lintCandidate(candidate, leak.terms).length > 0 || lintDecisionStrings(candidate, leak).length > 0) {
    throw new SealInputError("intent_leak");
  }

  const intent = renderIntent(item.intent).replace(FRONT_MATTER, "");
  const spec = renderSpec(state, { title: item.front.title }, leak);
  if (intent.length + spec.length + canonicalize(contract).length > MAX_SEAL_INPUT_CHARS) throw new SealInputError("too_large");

  const resolved = state.decisions.filter((decision) => decision.status === "resolved");
  return {
    intent,
    spec,
    contract,
    linkable_decision_ids: resolved.filter((decision) => !isQuantitative(decision.class)).map((decision) => decision.id),
    quantitative_decision_ids: resolved.filter((decision) => isQuantitative(decision.class)).map((decision) => decision.id),
    ...(feedback === undefined ? {} : { feedback }),
  };
}

/** The fixed text. Each rule the judge applies is stated here, so a test can pin that the author was told. */
const INSTRUCTIONS: readonly string[] = [
  "You write acceptance scenarios for a command line program that does not exist yet. A person approved the specification below.",
  "Write only what the specification and the interface contract promise. You cannot see any code, plan or diff, and you must not ask for them.",
  "",
  "## Output format",
  "",
  "Print a YAML stream of scenario documents separated by lines that hold only ---. Print nothing else: no prose and no code fence.",
  "Allowed keys of a document: decision_refs, kind, split, interface, steps. Any other key is dropped and counted.",
  "- kind is behavior or contradiction_canary. interface is cli. split is train or test.",
  "- Write at least one behavior scenario in each split.",
  "- Write at least one contradiction_canary in every set. A set with none is rejected and sent back to you.",
  "- steps is a list. Each step has invoke (argv: a list of strings, stdin: a string) and expect (exit_code, stdout_matches, json_path, note). Every step needs at least one of exit_code, stdout_matches and json_path.",
  "- stdout_matches is typed: kind exact with text, or kind anchored with pattern.",
  "- An anchored pattern starts with ^ and ends with $. It may use literals, a dot, \\d \\w \\s and their capitals, character classes, and the suffixes *, + and ?. Groups, alternation and counted repeats are refused.",
  "- json_path maps paths such as $.items[0].name to a string, number, boolean or null. stdout must then be JSON.",
  "",
  "## Rules the judge applies",
  "",
  "- Step state: the steps of one scenario share one scratch directory (working directory, home and files); every scenario starts with an empty one.",
  "- An exact match compares the whole stdout including the trailing newline. stdout must be valid UTF-8.",
  "- A process killed by a signal never satisfies any expectation.",
  "- Every behavior scenario names the decisions it proves in decision_refs. A decision_ref must come from the linkable list below. Naming a quantitative decision invalidates the scenario.",
  "- A contradiction_canary must be statically unsatisfiable: an exact stdout_matches plus json_path entries that the exact text itself cannot satisfy (text that is not JSON, or JSON that disagrees with the path), so that no program can pass it. An exit_code entry cannot make a step unsatisfiable.",
  "",
];

function idLines(ids: readonly string[]): string[] {
  return ids.length === 0 ? ["(none)"] : ids.map((id) => `- ${id}`);
}

/** Ids and counts only (M3c-D12): anything else in a feedback object would carry scenario content into the next prompt. */
function feedbackLines(feedback: SealFeedback): string[] {
  const counts = [feedback.weak, feedback.contradictions, feedback.invalid];
  if (!feedback.unlinked_decision_ids.every((id) => DECISION_ID_PATTERN.test(id)) || !counts.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new SealInputError("forbidden_input");
  }
  return [
    "",
    "## Feedback on the last attempt",
    "",
    ...feedback.unlinked_decision_ids.map((id) => `- unlinked decision: ${id}`),
    `- weak scenarios: ${feedback.weak}`,
    `- contradictions: ${feedback.contradictions}`,
    `- invalid scenarios: ${feedback.invalid}`,
  ];
}

/**
 * Deterministic text: the fixed instructions, then the intent, the spec, the contract as canonical JSON, the two id
 * lists and, on a re-seal, the feedback lines. Throws `forbidden_input` when `inputs` has any own key other than the six
 * of `SealInputs` (a plan, a diff, a file list), so a widened type cannot reach a prompt.
 */
export function buildSealPrompt(inputs: SealInputs): string {
  if (Object.keys(inputs).some((key) => !INPUT_KEYS.includes(key))) throw new SealInputError("forbidden_input");
  const lines = [
    ...INSTRUCTIONS,
    "## Intent",
    "",
    inputs.intent.trimEnd(),
    "",
    "## Specification",
    "",
    inputs.spec.trimEnd(),
    "",
    "## Interface contract",
    "",
    canonicalize(inputs.contract),
    "",
    "## Linkable decision ids",
    "",
    ...idLines(inputs.linkable_decision_ids),
    "",
    "## Quantitative decision ids (never name these)",
    "",
    ...idLines(inputs.quantitative_decision_ids),
    ...(inputs.feedback === undefined ? [] : feedbackLines(inputs.feedback)),
  ];
  return `${lines.join("\n")}\n`;
}
