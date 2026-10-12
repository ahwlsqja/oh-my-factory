import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { humanActor } from "../core/actor.js";
import { Ledger } from "../core/ledger.js";
import { type ProjectStatus, requireProject } from "../core/project.js";
import { approveGoal } from "../goal/approve.js";
import { type AuditReport, auditGoal } from "../goal/audit.js";
import { createGoal, readGoal, referencedMetrics } from "../goal/goal-file.js";
import { proposeMetric, readProposal } from "../goal/metrics.js";

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

const listOrNone = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

/** What the person approves: the locked fields and every metric command, shown before the prompt. */
function printForApproval(status: ProjectStatus, goalId: string): void {
  const { front } = readGoal(status.dir, goalId);
  console.log(`goal ${front.goal_id}: ${front.title}`);
  console.log(`objective: ${front.objective}`);
  console.log(`target: ${front.target.metric_id} ${front.target.operator} ${front.target.value} ${front.target.unit}`);
  console.log(`leading: ${listOrNone(front.leading)}; lagging: ${listOrNone(front.lagging)}; guardrails: ${listOrNone(front.guardrails)}`);
  console.log(
    `budget: ${front.budget.rounds} rounds, ${front.budget.wall_time} wall time, at most ${front.budget.max_open_work_items} open work items`,
  );
  console.log(`decision rule: ${front.prereg.decision_rule} (minimum observation ${front.prereg.min_observation})`);
  for (const id of referencedMetrics(front)) {
    const proposal = readProposal(status.dir, id);
    if (proposal === null) {
      console.log(`metric ${id}: no proposal`);
      continue;
    }
    const image = proposal.image === null ? "" : `; image ${proposal.image}`;
    console.log(
      `metric ${id}: ${JSON.stringify(proposal.command)} -> ${proposal.unit}; watches ${listOrNone(proposal.watched_paths)}${image}`,
    );
  }
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

  goal
    .command("approve")
    .argument("<goal_id>")
    .description("J1: approve the goal and lock its metrics (needs an interactive terminal)")
    .action(async (goalId: string) => {
      const status = requireProject(process.cwd());
      // No silent approval (spec §6.2): without a terminal there is nobody to confirm.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("J1 approval needs an interactive terminal; nothing was approved");
      }
      const actor = humanActor(status.repo);
      printForApproval(status, goalId);
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await prompt.question(`Type ${goalId} to approve as ${actor}: `)).trim();
      prompt.close();
      if (answer !== goalId) {
        console.error("not approved");
        process.exitCode = 1;
        return;
      }
      const result = approveGoal(status, goalId, actor);
      console.log(
        result.created
          ? `approved ${goalId} (regime ${result.approval.regime})`
          : `${goalId} is already approved (regime ${result.approval.regime})`,
      );
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
