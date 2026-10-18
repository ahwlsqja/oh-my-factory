#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { containerIsolationProbe } from "../container/doctor-probe.js";
import { runDoctorParallel } from "../core/doctor.js";
import { Ledger, TORN_TAIL_WARNING } from "../core/ledger.js";
import { GitNotFoundError, NotAGitRepoError, UnsupportedRepoError, resolveProject } from "../core/paths.js";
import { SymlinkRefusedError, assertStateTreeClean } from "../core/safe-fs.js";
import { exitFor } from "./exit.js";
import { registerDecideCommands } from "./decide.js";
import { registerDecideSigningCommands } from "./decide-sign.js";
import { registerGoalCommands } from "./goal.js";
import { registerWCommands } from "./w-commands.js";
import { registerBudgetCommands, registerWorkCommands } from "./work.js";
import { NOT_INITIALIZED_MESSAGE, initProject, readProjectStatus } from "../core/project.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const program = new Command()
  .name("omf")
  .description("oh-my-factory: a goal-driven software factory for Claude Code and Codex CLI")
  .version(version);

program.addHelpText(
  "after",
  "\nExit codes: 0 ok, 1 problems found (including a failed ledger verify) or usage error, 2 the command could not run (for example outside a git repository, or a command refusing a corrupt ledger), 3 blocked on a person (J2: open design decisions).",
);

program
  .command("init")
  .description("create OMF host state for this repository (writes nothing to the repository)")
  .action(() => {
    const result = initProject(process.cwd());
    console.log(`${result.created ? "initialized" : "already initialized"} ${result.projectDir}`);
    process.exitCode = exitFor("ok");
  });

program
  .command("doctor")
  .description("check tools, repository, ledger and isolation; writes preflight.json")
  .option("--json", "print the full report as JSON")
  .option("--strict", "treat the tool warnings (Docker missing or not running, an agent CLI missing) as problems")
  .action(async (options: { json?: boolean; strict?: boolean }) => {
    const report = await runDoctorParallel(process.cwd(), process.env, undefined, containerIsolationProbe(), {
      strict: options.strict === true,
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.ok) {
        console.log("ok");
      } else {
        console.log("problems:");
        for (const problem of report.problem_details) {
          console.log(`  - ${problem.message}`);
          console.log(`    fix: ${problem.fix}`);
        }
      }
      for (const warning of report.warning_details) {
        const needed = warning.needed_by.length > 0 ? ` (needed for: ${warning.needed_by.join(", ")})` : "";
        console.error(`warning: ${warning.message}${needed}`);
        console.error(`  fix: ${warning.fix}`);
      }
    }
    // Finding problems is doctor's job, so a report with problems exits 1 (the documented "problems found").
    process.exitCode = exitFor(report.ok ? "ok" : "problem");
  });

const ledgerCommand = program.command("ledger").description("inspect the host ledger");

ledgerCommand
  .command("verify")
  .description("verify the ledger hash chain")
  .option("--json", "print the result as JSON")
  .action((options: { json?: boolean }) => {
    try {
      verifyLedger(options.json === true);
    } catch (err) {
      // With --json every error is the same object on stdout, so a script parses one shape for all of them.
      if (options.json !== true) throw err;
      console.log(JSON.stringify({ ok: false, error: { code: errorCode(err), message: errorMessage(err) } }, null, 2));
      process.exitCode = exitFor("cannotRun");
    }
  });

/** Closed set of `error.code` values of `omf ledger verify --json`. */
type VerifyErrorCode =
  | "not_initialized"
  | "ledger_corrupt"
  | "not_a_git_repository"
  | "git_not_found"
  | "unsupported_repository"
  | "symlink_refused"
  | "cannot_run";

function errorCode(err: unknown): VerifyErrorCode {
  if (err instanceof NotAGitRepoError) return "not_a_git_repository";
  if (err instanceof GitNotFoundError) return "git_not_found";
  if (err instanceof UnsupportedRepoError) return "unsupported_repository";
  if (err instanceof SymlinkRefusedError) return "symlink_refused";
  return "cannot_run";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function verifyLedger(json: boolean): void {
  const location = resolveProject(process.cwd());
  // A planted link stops the command with exit 2 before the ledger is read.
  assertStateTreeClean(location);
  const status = readProjectStatus(location);
  const { ledger } = status;
  const path = new Ledger(location.dir).file;
  if (ledger === null || (ledger.ok && !status.initialized)) {
    // Not initialized: the command could not run, like goal audit, work list and budget show.
    if (json) {
      const error = { code: "not_initialized", message: NOT_INITIALIZED_MESSAGE };
      console.log(JSON.stringify({ ok: false, error }, null, 2));
    } else console.error(NOT_INITIALIZED_MESSAGE);
    process.exitCode = exitFor("cannotRun");
  } else if (!ledger.ok) {
    if (json) {
      const error = {
        code: "ledger_corrupt",
        message: `ledger corrupt at seq ${ledger.seq}: ${ledger.reason}`,
        seq: ledger.seq,
        reason: ledger.reason,
        ...corruptionFields(ledger.seq, path),
      };
      console.log(JSON.stringify({ ok: false, error }, null, 2));
    } else {
      console.error(`corrupt at seq ${ledger.seq}: ${ledger.reason}`);
      console.error(corruptionHint(ledger.seq, path));
    }
    process.exitCode = exitFor("problem");
  } else {
    if (json) {
      const report = { ok: true, count: ledger.count, head: ledger.head, torn_tail: ledger.tornTail === true, path };
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ok: ${ledger.count} ${ledger.count === 1 ? "event" : "events"}, head ${ledger.head}`);
    }
    if (ledger.tornTail) console.error(`warning: ${TORN_TAIL_WARNING}`);
    process.exitCode = exitFor("ok");
  }
}

registerGoalCommands(program);
registerWorkCommands(program);
registerBudgetCommands(program);
registerDecideCommands(program);
registerDecideSigningCommands(program);
registerWCommands(program);

const CORRUPT_MESSAGE = /^ledger corrupt at seq (\d+): /;

/**
 * Structured form of `corruptionHint`. The ledger reader turns every line, a blank one included, into one event or
 * rejects it as corrupt at that line, so the 1-based file line of the bad event is its seq.
 */
function corruptionFields(seq: number, path: string): Record<string, unknown> {
  return { line: seq, path, next_action: "do not edit the ledger; restore it from a backup" };
}

/** Stderr line 2 of a corrupt-ledger message: where it is and what to do. Line 1 stays the stable text. */
function corruptionHint(seq: number, path: string): string {
  return `  ${path}, line ${seq}: do not edit it, restore from a backup; details: omf ledger verify --json`;
}

/** The second stderr line for the errors a person can fix, or null when the message says it all. */
function errorHint(err: unknown): string | null {
  if (err instanceof GitNotFoundError) return "  install git and make sure it is on PATH";
  if (err instanceof NotAGitRepoError) return "  run omf from inside a git repository, or create one with: git init";
  const corrupt = err instanceof Error ? CORRUPT_MESSAGE.exec(err.message) : null;
  if (corrupt?.[1] !== undefined) {
    try {
      return corruptionHint(Number(corrupt[1]), new Ledger(resolveProject(process.cwd()).dir).file);
    } catch {
      return null;
    }
  }
  return null;
}

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  const hint = errorHint(err);
  if (hint !== null) console.error(hint);
  process.exitCode = exitFor("cannotRun");
});
