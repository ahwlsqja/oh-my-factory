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
import { GoalFileError, assertGoalId, goalFile } from "../goal/goal-file.js";
import { type GoalLock, GoalLockError, latestApproval, readGoalLock } from "../goal/goal-lock.js";
import { raiseWallTime, wallTimeLimitMs } from "../goal/wall-time.js";
import { type ClaimStatus, claimStatus } from "../work/claim.js";
import { renderIntent } from "../work/intent-md.js";
import { verifiedItems, verifyItemAgainstLedger } from "../work/ledger-verify.js";
import { canTransition } from "../work/transitions.js";
import { OPEN_STATES, TERMINAL_WORK_STATES, type WorkItem, type WorkState } from "../work/types.js";
import { renderWorkItem } from "../work/work-item.js";
import { confirmByTyping, requireTerminal } from "./confirm.js";

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
 * `wall_time` is a J8 cap too (D26) but it is not a counted budget, so it stays out of `BudgetKind` and
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

/** The wall time clock as `auditGoal` enforces it: the limit is the approved time plus the raises (D26). */
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
    wall_time: { base_ms, raised_ms: limit_ms - base_ms, limit_ms, elapsed_ms, remaining_ms, exceeded: remaining_ms < 0 },
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
  const lines = [`budget for ${report.goal_id}`, stateLine("rounds", report.rounds), stateLine("disclosure", report.disclosure)];
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

  const change = (verb: "declare" | "raise", description: string): void => {
    budget
      .command(verb)
      .argument("<goal_id>")
      .argument("<kind>", "rounds, disclosure or wall_time (wall_time can only be raised)")
      .argument("<amount>", "a positive integer, or a duration such as 2h for wall_time")
      .description(description)
      .action(async (goalId: string, kind: string, amount: string) => {
        const status = requireProject(process.cwd());
        const args: BudgetArgs = { verb, goalId, kind, amount };
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
      });
  };
  change("declare", "J8: declare a rounds or disclosure budget (needs an interactive terminal)");
  change("raise", "J8: raise a rounds, disclosure or wall_time cap (needs an interactive terminal)");
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
 * authoritative, D27): a crash in between leaves a recorded approval and an item still awaiting one,
 * which `omf work approve` can finish. No J number: the spec has no item-approval judgment (D5).
 */
export function runWorkApprove(location: ProjectLocation, workId: string, actor: string, now: Date = new Date()): WorkItem {
  const item = assertApprovable(location, workId, actor);
  new Ledger(location.dir).append({
    actor,
    type: "work.approved",
    payload: { goal_id: item.front.goal_id, work_id: workId },
  });
  return createMarkdownStore(location.dir).approveWorkItem(workId, actor, now);
}

/**
 * Vetoes an item from any open state, also while a run holds its claim (D28): a veto only restricts, so
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
  if (!canTransition(previous, "vetoed")) throw new Error(`work item ${workId} is already ${previous}; nothing to veto`);
  const claim = claimStatus(item.dir);
  new Ledger(location.dir).append({
    actor,
    type: "work.vetoed",
    payload: { goal_id: item.front.goal_id, work_id: workId, reason: text },
  });
  return { item: createMarkdownStore(location.dir).vetoWorkItem(workId, actor, text, now), previous, claim };
}

/** Work item and veto commands (spec §4.4 step 5, §9). Errors propagate to main.ts, which exits 2. */
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
        if (!ALL_STATES.includes(state as WorkState)) throw new Error(`unknown state ${state}; use ${ALL_STATES.join(", ")}`);
      }
      const events = new Ledger(status.dir).readVerified();
      const { items, malformed } = verifiedItems(createMarkdownStore(status.dir), events, goalId);
      const shown = options.state.length === 0 ? items : items.filter((item) => options.state.includes(item.front.state));
      if (options.json) {
        console.log(JSON.stringify({ goal_id: goalId, items: shown.map((item) => item.front), malformed }, null, 2));
      } else {
        if (shown.length === 0 && malformed.length === 0) console.log("no work items");
        for (const { front } of shown) {
          console.log(`${front.work_id}  ${front.state.padEnd(17)} ${front.risk.class.padEnd(6)} ${front.title}`);
        }
        for (const entry of malformed) console.log(`malformed ${entry.work_id ?? "(no id)"}: ${entry.reason}`);
      }
      if (malformed.length > 0) {
        console.error(`warning: ${malformed.length} malformed work item(s) are never dispatched or counted as open work`);
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
      console.log(verdict.ok ? "ledger: consistent" : `ledger: MALFORMED (${verdict.reason}); this item is never dispatched`);
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
    .action((workId: string, options: { reason: string }) => {
      const status = requireProject(process.cwd());
      const actor = humanActor(status.repo);
      const result = runVeto(status, workId, actor, options.reason);
      console.log(`vetoed ${workId} (was ${result.previous})`);
      if (result.claim.held) {
        const pid = result.claim.owner === null ? "unknown" : String(result.claim.owner.pid);
        console.log(`note: a run holds the claim (pid ${pid}); it stops when it re-reads the item at its next station`);
      }
    });
}
