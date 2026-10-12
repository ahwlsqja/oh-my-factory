#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Command } from "commander";
import { runDoctor } from "../core/doctor.js";
import { Ledger } from "../core/ledger.js";
import { projectDir } from "../core/paths.js";
import { initProject } from "../core/project.js";

const program = new Command()
  .name("omf")
  .description("oh-my-factory: a goal-driven software factory for Claude Code and Codex CLI")
  .version("0.0.1");

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
    } else if (report.ok) {
      console.log("ok");
    } else {
      console.log("problems:");
      for (const problem of report.problems) console.log(`  - ${problem}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  });

const ledgerCommand = program.command("ledger").description("inspect the host ledger");

ledgerCommand
  .command("verify")
  .description("verify the ledger hash chain")
  .action(() => {
    const ledger = new Ledger(projectDir(process.cwd()));
    if (!existsSync(ledger.file)) {
      console.error("project not initialized; run omf init");
      process.exitCode = 1;
      return;
    }
    const result = ledger.verify();
    if (result.ok) {
      console.log(`ok: ${result.count} events, head ${result.head}`);
    } else {
      console.error(`corrupt at seq ${result.seq}: ${result.reason}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
