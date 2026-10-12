import { existsSync } from "node:fs";
import type { Command } from "commander";
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
