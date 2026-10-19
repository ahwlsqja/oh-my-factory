import { existsSync } from "node:fs";
import type { Command } from "commander";
import { createMarkdownStore, findWorkItem } from "../adapters/state-markdown.js";
import { humanActor } from "../core/actor.js";
import {
  BUDGET_KINDS,
  BudgetError,
  type BudgetKind,
  type BudgetState,
  budgetState,
  budgetStateFromEvents,
  declareBudget,
  raiseBudget,
} from "../core/budget.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { requireProject } from "../core/project.js";
import { parseDuration } from "../goal/duration.js";
import { assertGoalId, GoalFileError, goalFile } from "../goal/goal-file.js";
import { type GoalLock, GoalLockError, latestApproval, readGoalLock } from "../goal/goal-lock.js";
import { raiseWallTime, wallTimeLimitMs } from "../goal/wall-time.js";
import { type ClaimStatus, claimStatus } from "../work/claim.js";
import { renderIntent } from "../work/intent-md.js";
import { verifiedItems, verifyItemAgainstLedger } from "../work/ledger-verify.js";
import { canTransition } from "../work/transitions.js";
import { OPEN_STATES, TERMINAL_WORK_STATES, type WorkItem, type WorkState } from "../work/types.js";
import { type LimitKind, microUsd, openItemBudget, raiseWorkLimit, WorkBudgetError } from "../work/w-budget.js";
import { renderWorkItem } from "../work/work-item.js";
import { confirmByTyping, type PromptStreams, requireTerminal, type TerminalStreams } from "./confirm.js";
import { sweepItemBestEffort } from "./item-sweep.js";

/** What a person typed after `omf budget declare|raise`: strings, because validation is `parseBudgetArgs`'s job. */
export interface BudgetArgs {
  verb: "declare" | "raise";
  goalId: string;
  /** `rounds`, `disclosure` or `wall_time`. */
  kind: string;
  /** A positive integer, or a duration such as `2h` for `wall_time`. */
  amount: string;
}

/**
 * `wall_time` is a J8 cap too but it is not a counted budget, so it stays out of `BudgetKind` and
 * is parsed here. It can only be raised: its base comes from goal.md at J1.
 */
export type ParsedBudgetArgs =
  | { verb: "declare" | "raise"; goalId: string; kind: BudgetKind; amount: number }
  | { verb: "raise"; goalId: string; kind: "wall_time"; by: string };

/**
 * Validates the typed arguments without touching the ledger. The CLI runs this before it asks for a
 * terminal, so a usage error is reported as such, with or without one.
 */
export function parseBudgetArgs(args: BudgetArgs): ParsedBudgetArgs {
  assertGoalId(args.goalId);
  if (args.kind === "wall_time") {
    if (args.verb === "declare") {
      throw new BudgetError(
        "forbidden",
        "wall time is set by goal.md at J1 approval, so it cannot be declared; " +
          `raise it with omf budget raise ${args.goalId} wall_time <duration>`,
      );
    }
    parseDuration(args.amount);
    return { verb: "raise", goalId: args.goalId, kind: "wall_time", by: args.amount };
  }
  const kind = BUDGET_KINDS.find((candidate) => candidate === args.kind);
  if (kind === undefined) throw new Error(`unknown budget kind ${args.kind}; use rounds, disclosure or wall_time`);
  if (!/^[1-9][0-9]*$/.test(args.amount)) {
    throw new BudgetError("invalid_amount", `amount must be a positive integer; got ${args.amount}`);
  }
  return { verb: args.verb, goalId: args.goalId, kind, amount: Number(args.amount) };
}

function requireGoal(status: ProjectLocation, goalId: string): void {
  assertGoalId(goalId);
  if (!existsSync(goalFile(status.dir, goalId))) {
    throw new GoalFileError(`goal ${goalId} not found; run omf goal new ${goalId}`);
  }
}

/**
 * The J8 write, after the person confirmed (spec §4.4). The actor is a parameter so a test can run the
 * whole path without a terminal; the CLI passes `humanActor`. Everything below `parseBudgetArgs` is a
 * ledger rule enforced by core/budget.ts or goal/wall-time.ts, so this function adds only what they
 * cannot know: the person-only check up front (the same wording as core) and the approval a wall time
 * raise needs.
 */
export function runBudgetCommand(status: ProjectLocation, args: BudgetArgs, actor: string): string {
  const parsed = parseBudgetArgs(args);
  if (!actor.startsWith("human:")) {
    throw new BudgetError("forbidden", `only a person may ${parsed.verb} a budget (J8); actor was ${actor}`);
  }
  requireGoal(status, parsed.goalId);
  const ledger = new Ledger(status.dir);
  if (parsed.kind === "wall_time") {
    if (latestApproval(ledger.readVerified(), parsed.goalId) === null) {
      throw new BudgetError(
        "not_declared",
        `goal ${parsed.goalId} is not approved; wall time counts from the first approval`,
      );
    }
    raiseWallTime(ledger, parsed.goalId, parsed.by, actor);
    return `raised wall time for ${parsed.goalId} by ${parsed.by} as ${actor}`;
  }
  if (parsed.verb === "declare") {
    declareBudget(ledger, parsed.goalId, parsed.kind, parsed.amount, actor);
    return `declared ${parsed.kind} budget ${parsed.amount} for ${parsed.goalId} as ${actor}`;
  }
  raiseBudget(ledger, parsed.goalId, parsed.kind, parsed.amount, actor);
  const after = budgetState(ledger, parsed.goalId, parsed.kind);
  if (after === null) throw new Error("unreachable: a raised budget has no state");
  return `raised ${parsed.kind} budget of ${parsed.goalId} by ${parsed.amount} as ${actor}; ${after.remaining} remaining`;
}

/** What a person typed after `omf budget raise`: strings, because validation is `parseBudgetRaiseArgs`'s job. */
export interface BudgetRaiseArgs {
  id: string;
  kind?: string | undefined;
  amount?: string | undefined;
  /** `--rounds <n>`, the work item form. */
  rounds?: string;
  /** `--usd <amount>`, the work item form. */
  usd?: string;
}

export type ParsedBudgetRaise =
  | { form: "goal"; args: BudgetArgs }
  /** `amount` is in the unit the ledger stores (rounds, or micro-USD); `display` is what the person typed. */
  | { form: "work"; workId: string; kind: LimitKind; amount: number; display: string };

const WORK_ID_ARG = /^w-[0-9a-f]{12}$/;
const USD_ARG = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;

/**
 * Splits `omf budget raise` into its two forms without touching the ledger. `--rounds` or
 * `--usd` or a `w-` id selects the work item form; anything else is the goal form, unchanged. Amounts that
 * are not positive (a zero, a sign, an exponent, a result that is not a safe integer of micro-dollars) are
 * `WorkBudgetError("invalid_amount")`; main.ts exits 2 for every error, like the goal form.
 */
export function parseBudgetRaiseArgs(raw: BudgetRaiseArgs): ParsedBudgetRaise {
  const { rounds, usd } = raw;
  const workForm = rounds !== undefined || usd !== undefined || WORK_ID_ARG.test(raw.id);
  if (!workForm) {
    if (raw.kind === undefined || raw.amount === undefined) {
      throw new Error(
        "budget raise needs <kind> <amount> for a goal, or --rounds <n> or --usd <amount> for a work item",
      );
    }
    const args: BudgetArgs = { verb: "raise", goalId: raw.id, kind: raw.kind, amount: raw.amount };
    parseBudgetArgs(args);
    return { form: "goal", args };
  }
  if (!WORK_ID_ARG.test(raw.id))
    throw new Error(`--rounds and --usd raise a work item's limit; ${raw.id} is not a work id`);
  if (raw.kind !== undefined || raw.amount !== undefined)
    throw new Error("a work item takes --rounds or --usd, not <kind> <amount>");
  if (rounds !== undefined && usd === undefined) {
    if (!/^[1-9][0-9]*$/.test(rounds) || !Number.isSafeInteger(Number(rounds))) {
      throw new WorkBudgetError("invalid_amount", `--rounds must be a positive integer; got ${rounds}`);
    }
    return { form: "work", workId: raw.id, kind: "rounds", amount: Number(rounds), display: rounds };
  }
  if (usd !== undefined && rounds === undefined) {
    let micro = 0;
    try {
      if (!USD_ARG.test(usd)) throw new RangeError("not a plain decimal");
      micro = microUsd(Number(usd));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      throw new WorkBudgetError("invalid_amount", `--usd must be a positive amount of dollars; got ${usd}`);
    }
    return { form: "work", workId: raw.id, kind: "model_micro_usd", amount: micro, display: `${usd} USD` };
  }
  throw new Error("give exactly one of --rounds <n> and --usd <amount>");
}

const dollars = (micro: number): string => (micro / 1_000_000).toFixed(6);

/**
 * The lines printed above the confirmation prompt: the item, the limits in force and what was used. Read-only;
 * it applies the same checks as the write (`openItemBudget`), so an item the raise would refuse never reaches
 * the prompt. Ids and numbers only.
 */
export function workLimitLines(location: ProjectLocation, workId: string): string[] {
  const { item, state } = openItemBudget(location, workId, new Ledger(location.dir).readVerified());
  const limit = state.effective;
  if (limit === null) throw new Error("unreachable: openItemBudget returns recorded limits");
  const unknown = state.spend.unknown_count > 0 ? `, ${state.spend.unknown_count} unknown` : "";
  return [
    `work ${workId} of goal ${item.front.goal_id} (${item.front.state})`,
    `rounds: limit ${limit.max_rounds} (raised ${state.raised.rounds}), started ${state.rounds_started}`,
    `model spend: limit ${dollars(limit.max_model_micro_usd)} USD (raised ${dollars(state.raised.model_micro_usd)}), spent ${dollars(state.spend.micro_usd)} USD${unknown}`,
  ];
}

/**
 * Everything `omf budget raise <work_id> --rounds|--usd` does after parsing: a terminal, the limits in force,
 * the person retypes the work id, then the J8 write. Returns the exit code: 0 raised, 1 declined. Streams and
 * `print` are parameters so a test runs the whole path without a terminal. It resumes nothing; a person then
 * runs the item again (`omf run`).
 */
export async function workLimitRaiseFlow(
  location: ProjectLocation,
  raise: Extract<ParsedBudgetRaise, { form: "work" }>,
  actor: string,
  io: PromptStreams = { input: process.stdin, output: process.stdout },
  streams: TerminalStreams = process,
  print: (line: string) => void = (line) => console.log(line),
): Promise<0 | 1> {
  requireTerminal("J8 work limit raise", "nothing was raised", streams);
  for (const line of workLimitLines(location, raise.workId)) print(line);
  const label = raise.kind === "rounds" ? "rounds" : "model spend";
  const prompt = `Type ${raise.workId} to raise the ${label} limit by ${raise.display} as ${actor}: `;
  if (!(await confirmByTyping(raise.workId, prompt, io))) {
    console.error("not raised");
    return 1;
  }
  raiseWorkLimit(location, raise.workId, raise.kind, raise.amount, actor);
  print(`raised the ${label} limit of ${raise.workId} by ${raise.display} as ${actor}`);
  return 0;
}

/** The wall time clock as `auditGoal` enforces it: the limit is the approved time plus the raises. */
export interface WallTimeReport {
  base_ms: number;
  raised_ms: number;
  limit_ms: number;
  /** Since the first approval. */
  elapsed_ms: number;
  /** Negative once the limit has passed. */
  remaining_ms: number;
  exceeded: boolean;
}

export interface BudgetReport {
  goal_id: string;
  rounds: BudgetState | null;
  disclosure: BudgetState | null;
  wall_time: WallTimeReport | null;
  /** Why `wall_time` is null, or null when it is present. */
  wall_time_note: string | null;
}

function wallTimeOf(
  status: ProjectLocation,
  events: readonly LedgerEvent[],
  goalId: string,
  now: Date,
): Pick<BudgetReport, "wall_time" | "wall_time_note"> {
  const approval = latestApproval(events, goalId);
  if (approval === null) {
    return { wall_time: null, wall_time_note: "not approved yet; wall time counts from the first approval" };
  }
  let lock: GoalLock | null = null;
  try {
    lock = readGoalLock(status.dir, goalId);
  } catch (err) {
    if (!(err instanceof GoalLockError)) throw err;
  }
  if (lock === null) {
    return { wall_time: null, wall_time_note: `goal lock missing or invalid; run omf goal audit ${goalId}` };
  }
  const base_ms = parseDuration(approval.wall_time ?? lock.semantic.budget.wall_time);
  const limit_ms = wallTimeLimitMs(events, goalId, approval, lock);
  const elapsed_ms = now.getTime() - Date.parse(approval.first_approved_at);
  const remaining_ms = limit_ms - elapsed_ms;
  return {
    wall_time: {
      base_ms,
      raised_ms: limit_ms - base_ms,
      limit_ms,
      elapsed_ms,
      remaining_ms,
      exceeded: remaining_ms < 0,
    },
    wall_time_note: null,
  };
}

/** Every budget of a goal from the verified ledger. Writes nothing; a corrupt ledger throws. */
export function budgetReport(status: ProjectLocation, goalId: string, now: Date = new Date()): BudgetReport {
  requireGoal(status, goalId);
  const events = new Ledger(status.dir).readVerified();
  return {
    goal_id: goalId,
    rounds: budgetStateFromEvents(events, goalId, "rounds"),
    disclosure: budgetStateFromEvents(events, goalId, "disclosure"),
    ...wallTimeOf(status, events, goalId, now),
  };
}

/** Whole minutes as `72h`, `1h 30m` or `-8h`; seconds are dropped because the shortest wall time is 1m. */
function formatSpan(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${sign}${rest}m`;
  return rest === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${rest}m`;
}

function stateLine(label: string, state: BudgetState | null): string {
  if (state === null) return `${label}: not declared`;
  return `${label}: declared ${state.declared}, raised ${state.raised}, consumed ${state.consumed}, remaining ${state.remaining}`;
}

/** The text of `omf budget show`, also printed above the confirmation prompt of `declare` and `raise`. */
export function budgetLines(report: BudgetReport): string[] {
  const lines = [
    `budget for ${report.goal_id}`,
    stateLine("rounds", report.rounds),
    stateLine("disclosure", report.disclosure),
  ];
  const wall = report.wall_time;
  if (wall === null) {
    lines.push(`wall time: ${report.wall_time_note ?? "unavailable"}`);
  } else {
    lines.push(
      `wall time: base ${formatSpan(wall.base_ms)}, raised ${formatSpan(wall.raised_ms)}, limit ${formatSpan(wall.limit_ms)}, ` +
        `elapsed ${formatSpan(wall.elapsed_ms)}, remaining ${formatSpan(wall.remaining_ms)}${wall.exceeded ? " (exceeded)" : ""}`,
    );
  }
  return lines;
}

/** Registers `budget show|declare|raise` (spec §4.4 J8). Errors propagate to main.ts, which exits 2. */
export function registerBudgetCommands(program: Command): void {
  const budget = program.command("budget").description("show, declare and raise goal budgets (J8)");

  budget
    .command("show")
    .argument("<goal_id>")
    .option("--json", "print the budgets as JSON")
    .description("print rounds, disclosure and wall time: declared, raised, consumed and remaining")
    .action((goalId: string, options: { json?: boolean }) => {
      const status = requireProject(process.cwd());
      const report = budgetReport(status, goalId);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else for (const line of budgetLines(report)) console.log(line);
    });

  /** The goal form of declare and raise, as it always was: a terminal, the budgets in force, a typed goal id. */
  const goalBudgetFlow = async (status: ProjectLocation, args: BudgetArgs): Promise<void> => {
    const { verb, goalId, kind, amount } = args;
    // A usage error is reported as one, with or without a terminal.
    parseBudgetArgs(args);
    // No silent budget change (spec §6.2): without a terminal there is nobody to confirm.
    requireTerminal(`J8 budget ${verb}`);
    const actor = humanActor(status.repo);
    for (const line of budgetLines(budgetReport(status, goalId))) console.log(line);
    if (!(await confirmByTyping(goalId, `Type ${goalId} to ${verb} ${kind} ${amount} as ${actor}: `))) {
      console.error(verb === "declare" ? "not declared" : "not raised");
      process.exitCode = 1;
      return;
    }
    console.log(runBudgetCommand(status, args, actor));
  };

  budget
    .command("declare")
    .argument("<goal_id>")
    .argument("<kind>", "rounds, disclosure or wall_time (wall_time can only be raised)")
    .argument("<amount>", "a positive integer, or a duration such as 2h for wall_time")
    .description("J8: declare a rounds or disclosure budget (needs an interactive terminal)")
    .action(async (goalId: string, kind: string, amount: string) => {
      await goalBudgetFlow(requireProject(process.cwd()), { verb: "declare", goalId, kind, amount });
    });

  budget
    .command("raise")
    .argument("<id>", "a goal id, or a work id with --rounds or --usd")
    // Optional only because the work item form takes neither; the goal form's missing-argument error moves from
    // commander (exit 1) to parseBudgetRaiseArgs (exit 2), pinned by a test.
    .argument("[kind]", "goal form: rounds, disclosure or wall_time")
    .argument("[amount]", "goal form: a positive integer, or a duration such as 2h for wall_time")
    .option("--rounds <n>", "work item form: raise the item's round limit by <n>")
    .option("--usd <amount>", "work item form: raise the item's model spend limit by <amount> dollars")
    .description(
      "J8: raise a goal's rounds, disclosure or wall_time cap, or a work item's --rounds or --usd limit (needs an interactive terminal)",
    )
    .action(
      async (
        id: string,
        kind: string | undefined,
        amount: string | undefined,
        options: { rounds?: string; usd?: string },
      ) => {
        const status = requireProject(process.cwd());
        const parsed = parseBudgetRaiseArgs({ id, kind, amount, ...options });
        if (parsed.form === "goal") {
          await goalBudgetFlow(status, parsed.args);
          return;
        }
        // No silent raise (spec §6.2): the terminal is checked before the actor, like the goal form.
        requireTerminal("J8 work limit raise", "nothing was raised");
        process.exitCode = await workLimitRaiseFlow(status, parsed, humanActor(status.repo));
      },
    );
}

const ALL_STATES: readonly WorkState[] = [...OPEN_STATES, ...TERMINAL_WORK_STATES];

function collectStates(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requireItem(projectDir: string, workId: string): WorkItem {
  const item = findWorkItem(projectDir, workId);
  if (item === null) throw new Error(`unknown work item ${workId}`);
  return item;
}

/**
 * Read-only checks before an approval: the actor is a person, the item exists, the ledger accounts for
 * it (a hand-edited item is never approved, spec §6.2) and it is waiting for a person. Returns the item.
 */
function assertApprovable(location: ProjectLocation, workId: string, actor: string): WorkItem {
  if (!/^human:\S+$/.test(actor)) throw new Error(`approval needs a human actor, got ${actor}`);
  const item = requireItem(location.dir, workId);
  const verdict = verifyItemAgainstLedger(item.front, new Ledger(location.dir).readVerified());
  if (!verdict.ok) throw new Error(`work item ${workId} is malformed (${verdict.reason}); nothing was approved`);
  if (item.front.state !== "awaiting_approval") {
    throw new Error(`work item ${workId} is ${item.front.state}; only awaiting_approval items can be approved`);
  }
  return item;
}

/**
 * Approves an `awaiting_approval` item. The ledger event comes first, then item.md (the ledger is
 * authoritative): a crash in between leaves a recorded approval and an item still awaiting one,
 * which `omf work approve` can finish. No J number: the spec has no item-approval judgment.
 */
export function runWorkApprove(
  location: ProjectLocation,
  workId: string,
  actor: string,
  now: Date = new Date(),
): WorkItem {
  const item = assertApprovable(location, workId, actor);
  new Ledger(location.dir).append({
    actor,
    type: "work.approved",
    payload: { goal_id: item.front.goal_id, work_id: workId },
  });
  return createMarkdownStore(location.dir).approveWorkItem(workId, actor, now);
}

/**
 * Vetoes an item from any open state, also while a run holds its claim: a veto only restricts, so
 * it needs no terminal. The run sees the new state when it re-reads the item at its next station.
 */
export function runVeto(
  location: ProjectLocation,
  workId: string,
  actor: string,
  reason: string,
  now: Date = new Date(),
): { item: WorkItem; previous: WorkState; claim: ClaimStatus } {
  if (!/^human:\S+$/.test(actor)) throw new Error(`veto needs a human actor, got ${actor}`);
  const text = reason.trim();
  if (text.length === 0 || text.length > 500) throw new Error("veto reason must be 1 to 500 characters");
  const item = requireItem(location.dir, workId);
  const previous = item.front.state;
  if (!canTransition(previous, "vetoed"))
    throw new Error(`work item ${workId} is already ${previous}; nothing to veto`);
  const claim = claimStatus(item.dir);
  new Ledger(location.dir).append({
    actor,
    type: "work.vetoed",
    payload: { goal_id: item.front.goal_id, work_id: workId, reason: text },
  });
  return { item: createMarkdownStore(location.dir).vetoWorkItem(workId, actor, text, now), previous, claim };
}

/** Work item and veto commands (spec §4.4 step 5, §9). Errors propagate to main.ts, which exits 2. */
/**
 * What `work list` and `work show` print for an item whose file is exactly one W edge behind the ledger. The reason is a person's question ("did someone edit this by hand?"): the ledger is the
 * authority, so a crash leftover is healed by the next W entry on the goal, never by editing item.md.
 * Display only: `--json` keeps the machine reason `w_repairable`.
 */
export const REPAIRABLE_LABEL = "repairable (file is behind the ledger; the next W entry on this goal repairs it)";

export function registerWorkCommands(program: Command): void {
  const work = program.command("work").description("list, inspect and approve work items");

  work
    .command("list")
    .argument("<goal_id>")
    .option("--state <state>", "only items in this state (repeatable)", collectStates, [])
    .option("--json", "print the items as JSON")
    .description("list a goal's work items; items the ledger does not account for are reported as malformed (exit 1)")
    .action((goalId: string, options: { state: string[]; json?: boolean }) => {
      const status = requireProject(process.cwd());
      for (const state of options.state) {
        if (!ALL_STATES.includes(state as WorkState))
          throw new Error(`unknown state ${state}; use ${ALL_STATES.join(", ")}`);
      }
      const events = new Ledger(status.dir).readVerified();
      const { items, malformed, repairable } = verifiedItems(createMarkdownStore(status.dir), events, goalId);
      const repairableIds = new Set(repairable.map((entry) => entry.work_id));
      const shown =
        options.state.length === 0 ? items : items.filter((item) => options.state.includes(item.front.state));
      if (options.json) {
        console.log(JSON.stringify({ goal_id: goalId, items: shown.map((item) => item.front), malformed }, null, 2));
      } else {
        if (shown.length === 0 && malformed.length === 0) console.log("no work items");
        for (const { front } of shown) {
          console.log(`${front.work_id}  ${front.state.padEnd(17)} ${front.risk.class.padEnd(6)} ${front.title}`);
        }
        for (const entry of malformed) {
          const label = entry.work_id !== null && repairableIds.has(entry.work_id) ? REPAIRABLE_LABEL : entry.reason;
          console.log(`malformed ${entry.work_id ?? "(no id)"}: ${label}`);
        }
      }
      if (malformed.length > 0) {
        console.error(
          `warning: ${malformed.length} malformed work item(s) are never dispatched or counted as open work`,
        );
      }
      process.exitCode = malformed.length > 0 ? 1 : 0;
    });

  work
    .command("show")
    .argument("<work_id>")
    .description("print a work item's item.md, claim and intent.md")
    .action((workId: string) => {
      const status = requireProject(process.cwd());
      const item = requireItem(status.dir, workId);
      const verdict = verifyItemAgainstLedger(item.front, new Ledger(status.dir).readVerified());
      console.log(`work ${workId} (${item.front.state}) of goal ${item.front.goal_id}`);
      if (verdict.ok) console.log("ledger: consistent");
      else if (verdict.reason === "w_repairable") console.log(`ledger: ${REPAIRABLE_LABEL}`);
      else console.log(`ledger: MALFORMED (${verdict.reason}); this item is never dispatched`);
      const claim = claimStatus(item.dir);
      if (claim.held) console.log(`claim: held by pid ${claim.owner === null ? "unknown" : claim.owner.pid}`);
      console.log("--- item.md ---");
      console.log(renderWorkItem(item.front, item.progress).trimEnd());
      console.log("--- intent.md ---");
      console.log(renderIntent(item.intent).trimEnd());
    });

  work
    .command("approve")
    .argument("<work_id>")
    .description("approve a high-risk work item so it can be dispatched (needs an interactive terminal)")
    .action(async (workId: string) => {
      const status = requireProject(process.cwd());
      // No silent approval (spec §6.2): without a terminal there is nobody to confirm.
      requireTerminal("work approval");
      const actor = humanActor(status.repo);
      const { front } = assertApprovable(status, workId, actor);
      console.log(`work ${workId} of goal ${front.goal_id}: ${front.title}`);
      console.log(`risk: ${front.risk.class} (${front.risk.rules.join(", ")})`);
      console.log(`affected paths: ${front.affected_paths.join(", ")}`);
      if (front.has_open_questions) console.log("the intent lists open questions; read them with omf work show first");
      const confirmed = await confirmByTyping(workId, `Type ${workId} to approve as ${actor}: `);
      if (!confirmed) {
        console.error("not approved");
        process.exitCode = 1;
        return;
      }
      runWorkApprove(status, workId, actor);
      console.log(`approved ${workId}; it is ready for dispatch`);
    });

  program
    .command("veto")
    .argument("<work_id>")
    .option("--reason <text>", "why, at most 500 characters", "vetoed")
    .description("veto a work item from any open state; no terminal needed, because a veto only restricts")
    .action(async (workId: string, options: { reason: string }) => {
      const status = requireProject(process.cwd());
      const actor = humanActor(status.repo);
      const result = runVeto(status, workId, actor, options.reason);
      // The vetoed item will never reach another station, so a container of a killed run would stay for ever without this.
      await sweepItemBestEffort(status, workId, process.env);
      console.log(`vetoed ${workId} (was ${result.previous})`);
      if (result.claim.held) {
        const pid = result.claim.owner === null ? "unknown" : String(result.claim.owner.pid);
        console.log(`note: a run holds the claim (pid ${pid}); it stops when it re-reads the item at its next station`);
      }
    });
}
