import type { Command } from "commander";
import { humanActor } from "../core/actor.js";
import { Ledger } from "../core/ledger.js";
import { requireProject } from "../core/project.js";
import { type AuditReport, auditGoal } from "../goal/audit.js";
import { createGoal } from "../goal/goal-file.js";
import { proposeMetric } from "../goal/metrics.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printList(title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  console.log(`${title}:`);
  for (const item of items) console.log(`  - ${item}`);
}

function printAudit(report: AuditReport): void {
  const regime = report.approval === null ? "" : ` (regime ${report.approval.regime})`;
  console.log(`goal ${report.goal_id}: ${report.state.replace("needs_reapproval", "needs re-approval")}${regime}`);
  if (report.state === "draft" && report.problems.length === 0) {
    console.log(`ready for J1: run omf goal approve ${report.goal_id}`);
  }
  if (report.budget !== null) {
    console.log(`budget: ${report.budget.remaining} of ${report.budget.declared + report.budget.raised} rounds left`);
  }
  if (report.wall_time_exceeded) console.log("wall time exceeded (J6)");
  printList("problems", report.problems);
  printList("needs re-approval (J1)", report.regime_changes);
}

/** Goal and metric commands (spec §9). Errors propagate to main.ts, which exits 2. */
export function registerGoalCommands(program: Command): void {
  const goal = program.command("goal").description("define, approve and measure goals");

  goal
    .command("new")
    .argument("<goal_id>", "id of the form g-<words>")
    .description("create goal.md in host state from a template")
    .action((goalId: string) => {
      const status = requireProject(process.cwd());
      const file = createGoal(status.dir, goalId);
      console.log(`created ${file}`);
      console.log(`edit it, propose its metrics with omf metric propose, then run omf goal audit ${goalId}`);
    });

  goal
    .command("audit")
    .argument("<goal_id>")
    .option("--json", "print the audit report as JSON")
    .description("check the goal, its locks and the ledger; report regime changes (writes nothing)")
    .action((goalId: string, options: { json?: boolean }) => {
      const status = requireProject(process.cwd());
      const report = auditGoal(status, goalId);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printAudit(report);
      process.exitCode = report.problems.length > 0 || report.regime_changes.length > 0 ? 1 : 0;
    });

  const metric = program.command("metric").description("propose metrics for J1");

  metric
    .command("propose")
    .argument("<metric_id>", "id of the form m-<words>")
    .argument("<command...>", "argv that prints the value on its last stdout line; put it after --")
    .requiredOption("--unit <unit>", "unit of the value, for example ms")
    .option("--watch <glob>", "a path whose change is a regime change (repeatable)", collect, [])
    .option("--image <ref>", "container image for --runner docker")
    .description("propose a metric; it is measured only after J1 approves a goal that uses it")
    .action((metricId: string, command: string[], options: { unit: string; watch: string[]; image?: string }) => {
      const status = requireProject(process.cwd());
      const owner = humanActor(status.repo);
      const proposal = proposeMetric(
        new Ledger(status.dir),
        status.dir,
        { metric_id: metricId, command, unit: options.unit, watched_paths: options.watch, image: options.image ?? null },
        owner,
      );
      console.log(`proposed ${proposal.metric_id} as ${owner}`);
    });
}
