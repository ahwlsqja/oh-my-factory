import { readFileSync } from "node:fs";
import type { ProjectLocation } from "../core/paths.js";
import { Ledger } from "../core/ledger.js";
import { safeText } from "../core/safe-text.js";
import { validateDef } from "../core/schema.js";
import { findDecision, foldDecisions } from "../decision/state.js";
import {
  type DecisionRecord,
  type DecisionScope,
  type DeferInput,
  INTENT_QUESTION_ID_PREFIX,
  type InterfaceContract,
  type NaInput,
  type ResolveInput,
  type ResponseMeasure,
} from "../decision/types.js";
import { DecisionError } from "../decision/write.js";
import type { WorkItem } from "../work/types.js";
import type { Command } from "commander";
import { humanActor } from "../core/actor.js";
import { requireProject } from "../core/project.js";
import { confirmByTyping, requireTerminal } from "./confirm.js";
import { decideReport, requireDecidableItem, runDecideDefer, runDecideNa, runDecideResolve } from "./decide.js";

export type SignVerb = "resolve" | "defer" | "na";

/** What a person is about to sign: the verb and the validated input file. */
export type SignAction =
  | { verb: "resolve"; input: ResolveInput }
  | { verb: "defer"; input: DeferInput }
  | { verb: "na"; input: NaInput };

/** `confirmByTyping` without its stream argument, so a test can answer the prompt without a terminal. */
export type ConfirmFn = (expected: string, prompt: string) => Promise<boolean>;

const VERB_PHRASE: Record<SignVerb, string> = { resolve: "resolve", defer: "defer", na: "mark n/a" };
const INPUT_DEF: Record<SignVerb, string> = { resolve: "resolve_input", defer: "defer_input", na: "na_input" };
const INPUT_NOUN: Record<SignVerb, string> = { resolve: "resolution", defer: "deferral", na: "not-applicable note" };

/**
 * What a person retypes to sign a decision. The decision id alone is not unique across work items, so the
 * work id is part of it: confirming means having read which item the decision belongs to (spec §6.2).
 */
export function signRetype(workId: string, decisionId: string): string {
  return `${workId}/${decisionId}`;
}

const argv = (command: string[] | null): string => (command === null ? "none" : safeText(JSON.stringify(command)));

function measureLines(measure: ResponseMeasure | null): string[] {
  if (measure === null) return [];
  const percentile = measure.percentile === null ? "" : ` at p${measure.percentile}`;
  const window = measure.window === null ? "" : ` over ${safeText(measure.window)}`;
  return [
    `measure: ${safeText(measure.metric)} ${measure.op} ${measure.threshold} ${safeText(measure.unit)}${percentile}${window}`,
  ];
}

/** The commands the factory will run for this item, as argv arrays: a person signs exactly these. */
function interfaceLines(contract: InterfaceContract): string[] {
  return [
    `interface: ${contract.kind}`,
    `  build: ${argv(contract.build)}`,
    `  run: ${argv(contract.run)}`,
    `  io contract: ${safeText(contract.io_contract)}`,
    `  gate fast: ${argv(contract.gates.fast)}`,
    `  gate full: ${argv(contract.gates.full)}`,
    `  gate deep: ${argv(contract.gates.deep)}`,
    `  required gates: ${contract.gates.required.join(", ")}`,
    `  test command: ${argv(contract.test_command)}`,
  ];
}

/**
 * The confirmation screen, printed above the prompt: the work item (id and title), the decision, and the
 * body that the signature would record. Pure, so a test reads it without a terminal.
 */
export function decisionScreen(item: WorkItem, record: DecisionRecord, action: SignAction): string[] {
  const lines = [
    `work ${item.front.work_id} of goal ${item.front.goal_id}: ${safeText(item.front.title)}`,
    `decision ${record.id} (class ${record.class}): ${safeText(record.question)}`,
  ];
  if (record.qas !== null) {
    const { source, stimulus, environment, artifact, response } = record.qas;
    lines.push(
      `  source: ${safeText(source)}`,
      `  stimulus: ${safeText(stimulus)}`,
      `  environment: ${safeText(environment)}`,
      `  artifact: ${safeText(artifact)}`,
      `  response: ${safeText(response)}`,
    );
  }
  lines.push(`you are about to ${VERB_PHRASE[action.verb]} it with:`);
  switch (action.verb) {
    case "resolve": {
      const { input } = action;
      lines.push(`choice: ${safeText(input.choice)}`, `rationale: ${safeText(input.rationale)}`);
      for (const rejected of input.rejected ?? []) lines.push(`rejected: ${safeText(rejected)}`);
      lines.push(...measureLines(input.response_measure ?? record.response_measure));
      if (input.interface !== undefined) lines.push(...interfaceLines(input.interface));
      break;
    }
    case "defer": {
      const { input } = action;
      lines.push(
        `owner: ${safeText(input.owner)}`,
        `reason: ${safeText(input.reason)}`,
        `revisit trigger: ${safeText(input.revisit_trigger)}`,
        `default: ${safeText(input.default)}`,
        `expires: ${safeText(input.expires_at)}`,
      );
      break;
    }
    case "na":
      lines.push(`rationale: ${safeText(action.input.rationale)}`);
      break;
  }
  return lines;
}

/** True only when the person retyped `<work_id>/<decision_id>`. `confirm` is injectable for tests. */
export async function confirmSign(
  item: WorkItem,
  record: DecisionRecord,
  action: SignAction,
  actor: string,
  confirm: ConfirmFn = confirmByTyping,
): Promise<boolean> {
  const retype = signRetype(item.front.work_id, record.id);
  return confirm(retype, `Type ${retype} to ${VERB_PHRASE[action.verb]} as ${actor}: `);
}

/**
 * Reads and validates the `--file` input. Every failure is a `DecisionError` (exit 1): the CLI runs this
 * before it asks for a terminal, so a bad file is reported as such with or without one. The message names
 * the file and the schema error path, never the file's content.
 */
export function readSignAction(verb: SignVerb, file: string): SignAction {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new DecisionError("invalid_input", `cannot read ${file}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DecisionError("invalid_input", `${file} is not valid JSON`);
  }
  const checked = validateDef("decision.schema.json", INPUT_DEF[verb], data);
  if (!checked.ok)
    throw new DecisionError("invalid_input", `${file} is not a valid ${INPUT_NOUN[verb]}: ${checked.errors}`);
  return { verb, input: data } as SignAction;
}

const scopeOf = (item: WorkItem): DecisionScope => ({ goal_id: item.front.goal_id, work_id: item.front.work_id });

/**
 * The decision a person is about to sign, or a refusal before anyone is asked: unknown, or final (resolved or
 * n/a; v0.1 has no general reopen, M3a A13). An open decision and a deferred one can be signed (A21). The write
 * re-checks both atomically under the ledger lock.
 */
export function openDecision(location: ProjectLocation, item: WorkItem, decisionId: string): DecisionRecord {
  const record = findDecision(foldDecisions(new Ledger(location.dir).readVerified(), scopeOf(item)), decisionId);
  if (record === null) {
    const hint = decisionId.startsWith(INTENT_QUESTION_ID_PREFIX)
      ? "; the intent's open questions are recorded by the first omf decide write, so run omf decide add first"
      : "";
    throw new DecisionError(
      "unknown_decision",
      `decision ${decisionId} not found in work item ${item.front.work_id}${hint}`,
    );
  }
  if (record.status === "resolved" || record.status === "na") {
    throw new DecisionError("already_closed", `decision ${decisionId} is already ${record.status}; v0.1 has no reopen`);
  }
  return record;
}

const TERMINAL_ACTION: Record<SignVerb, string> = {
  resolve: "decision resolve",
  defer: "decision defer",
  na: "decision n/a",
};
const NOT_DONE: Record<SignVerb, string> = {
  resolve: "nothing was resolved",
  defer: "nothing was deferred",
  na: "nothing was marked n/a",
};
const DECLINED: Record<SignVerb, string> = { resolve: "not resolved", defer: "not deferred", na: "not marked n/a" };
const DONE: Record<SignVerb, string> = { resolve: "resolved", defer: "deferred", na: "marked n/a" };

function signAs(
  location: ProjectLocation,
  workId: string,
  decisionId: string,
  action: SignAction,
  actor: string,
  now: Date,
): void {
  if (action.verb === "resolve") runDecideResolve(location, workId, decisionId, action.input, actor, now);
  else if (action.verb === "defer") runDecideDefer(location, workId, decisionId, action.input, actor, now);
  else runDecideNa(location, workId, decisionId, action.input, actor, now);
}

/** The whole interactive path of one verb, in the order of M3a A20. */
async function signFromTerminal(verb: SignVerb, workId: string, decisionId: string, file: string): Promise<void> {
  const status = requireProject(process.cwd());
  const item = requireDecidableItem(status, workId);
  const action = readSignAction(verb, file);
  const record = openDecision(status, item, decisionId);
  // No silent decision (spec §6.2): without a terminal there is nobody to confirm.
  requireTerminal(TERMINAL_ACTION[verb], NOT_DONE[verb]);
  const actor = humanActor(status.repo);
  for (const line of decisionScreen(item, record, action)) console.log(line);
  if (!(await confirmSign(item, record, action, actor))) {
    console.error(DECLINED[verb]);
    process.exitCode = 1;
    return;
  }
  const now = new Date();
  signAs(status, workId, decisionId, action, actor, now);
  console.log(`${DONE[verb]} ${decisionId} of ${workId} as ${actor}`);
  const { gate } = decideReport(status, workId, now);
  console.log(
    gate.status === "pass"
      ? "GATE-1: pass"
      : `GATE-1: blocked on a person (${gate.reasons.length} reason${gate.reasons.length === 1 ? "" : "s"}); run omf decide lint ${workId}`,
  );
}

/** A refused decision is exit 1 with its message; any other error propagates to main.ts, which exits 2. */
async function refusing(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof DecisionError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}

/**
 * Adds `resolve` and `defer` to the `decide` command that `registerDecideCommands` created. They need an
 * interactive terminal and the `<work_id>/<decision_id>` retype; `resolve --na` marks a decision not applicable.
 */
export function registerDecideSigningCommands(program: Command): void {
  const decide = program.commands.find((command) => command.name() === "decide");
  if (decide === undefined) throw new Error("registerDecideCommands must run before registerDecideSigningCommands");

  decide
    .command("resolve")
    .argument("<work_id>")
    .argument("<decision_id>")
    .requiredOption(
      "--file <resolution.json>",
      "the resolution: choice, rationale, rejected, and a measure or interface where the class needs one",
    )
    .option("--na", 'mark the decision not applicable instead; the file holds {"rationale": "..."} only')
    .description(
      "resolve a design decision as a person (needs an interactive terminal; retype <work_id>/<decision_id>)",
    )
    .action((workId: string, decisionId: string, options: { file: string; na?: boolean }) =>
      refusing(() => signFromTerminal(options.na === true ? "na" : "resolve", workId, decisionId, options.file)),
    );

  decide
    .command("defer")
    .argument("<work_id>")
    .argument("<decision_id>")
    .requiredOption(
      "--file <deferral.json>",
      "the deferral: owner, reason, revisit_trigger, default, expires_at (OMF sets signed_by)",
    )
    .description(
      "defer a design decision with a signed default and an expiry (needs an interactive terminal; retype <work_id>/<decision_id>)",
    )
    .action((workId: string, decisionId: string, options: { file: string }) =>
      refusing(() => signFromTerminal("defer", workId, decisionId, options.file)),
    );
}
