import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { humanActor } from "../core/actor.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { requireProject } from "../core/project.js";
import { approveGoal } from "../goal/approve.js";
import { type AuditReport, auditGoal } from "../goal/audit.js";
import { createGoal, readGoal, referencedMetrics, semanticHash } from "../goal/goal-file.js";
import { diffStat } from "../goal/git.js";
import type { ApprovalExpectation } from "../goal/goal-lock.js";
import { type GapReport, measureGoal } from "../goal/measure.js";
import { metricSha256, proposeMetric, readProposal } from "../goal/metrics.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `name@sha256:<digest>`: the only image form that cannot be re-pointed after J1 approved the metric. */
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

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
  if (report.state === "tampered") {
    console.log(`a lock does not match the ledger and measurement is stopped; run omf goal approve ${report.goal_id} to repair it`);
  }
  if (report.budget !== null) {
    console.log(`budget: ${report.budget.remaining} of ${report.budget.declared + report.budget.raised} rounds left`);
  }
  if (report.wall_time_exceeded) console.log("wall time exceeded (J6)");
  printList("problems", report.problems);
  printList("needs re-approval (J1)", report.regime_changes);
}

const listOrNone = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

/**
 * What the person approves, shown before the prompt: why approval is needed (problems and regime changes,
 * with the diff of watched paths), the locked fields and every metric command. `expected` holds the
 * hashes of what was shown; approveGoal refuses if either changed by the time the person confirms.
 */
export function approvalScreen(
  status: ProjectLocation,
  goalId: string,
): { lines: string[]; expected: ApprovalExpectation } {
  const lines: string[] = [];
  const out = (line: string): void => void lines.push(line);
  const audit = auditGoal(status, goalId);
  if (audit.problems.length > 0 || audit.regime_changes.length > 0) {
    out(`why approval is needed again (goal ${goalId} is ${audit.state.replace("needs_reapproval", "needs re-approval")}):`);
    for (const problem of audit.problems) out(`  problem: ${problem}`);
    for (const change of audit.regime_changes) out(`  - ${change}`);
    if (audit.approval !== null && audit.watched_paths_changed.length > 0) {
      out(`changes since the approval at ${audit.approval.head_commit.slice(0, 12)}:`);
      const stat = diffStat(status.repo, audit.approval.head_commit, audit.watched_paths_changed);
      out(stat === "" ? "  (only untracked files; no diff to show)" : stat);
    }
  }
  const { front } = readGoal(status.dir, goalId);
  out(`goal ${front.goal_id}: ${front.title}`);
  out(`objective: ${front.objective}`);
  out(`target: ${front.target.metric_id} ${front.target.operator} ${front.target.value} ${front.target.unit}`);
  out(`leading: ${listOrNone(front.leading)}; lagging: ${listOrNone(front.lagging)}; guardrails: ${listOrNone(front.guardrails)}`);
  out(`budget: ${front.budget.rounds} rounds, ${front.budget.wall_time} wall time, at most ${front.budget.max_open_work_items} open work items`);
  out(`decision rule: ${front.prereg.decision_rule} (minimum observation ${front.prereg.min_observation})`);
  const metrics: Record<string, string> = {};
  for (const id of referencedMetrics(front)) {
    const proposal = readProposal(status.dir, id);
    if (proposal === null) {
      out(`metric ${id}: no proposal`);
      continue;
    }
    metrics[id] = metricSha256(proposal);
    const image = proposal.image === null ? "" : `; image ${proposal.image}`;
    out(`metric ${id}: ${JSON.stringify(proposal.command)} -> ${proposal.unit}; watches ${listOrNone(proposal.watched_paths)}${image}`);
  }
  return { lines, expected: { semantic_sha256: semanticHash(front), metrics } };
}

function printGap(report: GapReport, file: string): void {
  console.log(`goal ${report.goal_id} (regime ${report.regime}), runner ${report.runner}`);
  const t = report.target;
  const wanted = `target ${t.operator} ${t.value} ${t.unit}`;
  if (t.result === null) console.log(`target ${t.metric_id}: not measured; ${wanted}`);
  else if (t.result.met) console.log(`target ${t.metric_id}: ${t.measured} ${t.unit}; ${wanted}; met`);
  else {
    console.log(
      `target ${t.metric_id}: ${t.measured} ${t.unit}; ${wanted}; gap ${t.result.gap} (${t.result.direction}, ${t.result.size})`,
    );
  }
  for (const m of report.metrics) {
    const value = m.value === null ? `failed: ${m.failure}` : `${m.value} ${m.unit}`;
    let band = "";
    if (m.band !== null) {
      band =
        m.band.status === "breach"
          ? `; band ${m.band.tier} (${m.band.rule})${m.band_action === null ? "" : ` -> ${m.band_action}`}`
          : `; ${m.band.status.replace(/_/g, " ")}`;
    }
    console.log(`  ${m.metric_id} [${m.roles.join(", ")}]: ${value}${band}`);
  }
  for (const g of report.guardrails) console.log(`guardrail ${g.metric_id}: ${g.status}`);
  printList("needs re-approval (J1)", report.regime_changes);
  if (report.wall_time_exceeded) console.log("wall time exceeded (J6)");
  console.log(`report: ${file}`);
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
      const screen = approvalScreen(status, goalId);
      for (const line of screen.lines) console.log(line);
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await prompt.question(`Type ${goalId} to approve as ${actor}: `)).trim();
      prompt.close();
      if (answer !== goalId) {
        console.error("not approved");
        process.exitCode = 1;
        return;
      }
      const result = approveGoal(status, goalId, actor, undefined, screen.expected);
      console.log(
        result.created
          ? `approved ${goalId} (regime ${result.approval.regime})`
          : `${goalId} is already approved (regime ${result.approval.regime})`,
      );
    });

  goal
    .command("measure")
    .argument("<goal_id>")
    .option("--runner <runner>", "docker (isolated) or host (no isolation)", "docker")
    .option("--json", "print the gap report as JSON")
    .description("audit the goal, run its locked metrics, and write a gap report to host state")
    .action((goalId: string, options: { runner: string; json?: boolean }) => {
      if (options.runner !== "docker" && options.runner !== "host") {
        throw new Error(`unknown runner ${options.runner}; use docker or host`);
      }
      const status = requireProject(process.cwd());
      const { report, file } = measureGoal(status, goalId, { runner: options.runner });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printGap(report, file);
      if (report.isolation === "none") console.error("warning: measured on the host without isolation (--runner host)");
      const failed = report.metrics.some((m) => m.failure !== null);
      process.exitCode = report.needs_reapproval || failed ? 1 : 0;
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
      if (proposal.watched_paths.length === 0) {
        console.error(
          `warning: ${proposal.metric_id} watches no path, so a change to the code it runs is not a regime change; add --watch <glob>`,
        );
      }
      if (proposal.image !== null && !DIGEST_PINNED.test(proposal.image)) {
        console.error(
          `warning: ${proposal.metric_id} image ${proposal.image} is not pinned by digest, so the tag can be re-pointed after approval without a regime change; use <name>@sha256:<digest>`,
        );
      }
    });
}
