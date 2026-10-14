#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { runDoctor } from "../core/doctor.js";
import { TORN_TAIL_WARNING } from "../core/ledger.js";
import { resolveProject } from "../core/paths.js";
import { registerDecideCommands } from "./decide.js";
import { registerDecideSigningCommands } from "./decide-sign.js";
import { registerGoalCommands } from "./goal.js";
import { registerBudgetCommands, registerWorkCommands } from "./work.js";
import { NOT_INITIALIZED_MESSAGE, initProject, readProjectStatus } from "../core/project.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

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
  });

program
  .command("doctor")
  .description("check tools, repository, ledger and isolation; writes preflight.json")
  .option("--json", "print the full report as JSON")
  .action((options: { json?: boolean }) => {
    const report = runDoctor(process.cwd());
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.ok) {
        console.log("ok");
      } else {
        console.log("problems:");
        for (const problem of report.problems) console.log(`  - ${problem}`);
      }
      for (const warning of report.warnings) console.error(`warning: ${warning}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  });

const ledgerCommand = program.command("ledger").description("inspect the host ledger");

ledgerCommand
  .command("verify")
  .description("verify the ledger hash chain")
  .action(() => {
    const status = readProjectStatus(resolveProject(process.cwd()));
    const { ledger } = status;
    if (ledger === null) {
      console.error(NOT_INITIALIZED_MESSAGE);
      process.exitCode = 1;
    } else if (!ledger.ok) {
      console.error(`corrupt at seq ${ledger.seq}: ${ledger.reason}`);
      process.exitCode = 1;
    } else if (!status.initialized) {
      console.error(NOT_INITIALIZED_MESSAGE);
      process.exitCode = 1;
    } else {
      console.log(`ok: ${ledger.count} ${ledger.count === 1 ? "event" : "events"}, head ${ledger.head}`);
      if (ledger.tornTail) console.error(`warning: ${TORN_TAIL_WARNING}`);
    }
  });

registerGoalCommands(program);
registerWorkCommands(program);
registerBudgetCommands(program);
registerDecideCommands(program);
registerDecideSigningCommands(program);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
