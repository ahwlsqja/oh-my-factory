import type { Command } from "commander";
import { legacyImageWarnings } from "../adapters/measure-cmd.js";
import { createReconciler } from "../adapters/reconciler.js";
import { readConfig } from "../core/config.js";
import { type TickResult, tickGoal } from "../goal/tick.js";
import { humanActor } from "../core/actor.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { requireProject } from "../core/project.js";
import { safeText } from "../core/safe-text.js";
import { approveGoal } from "../goal/approve.js";
import { type AuditReport, auditGoal } from "../goal/audit.js";
import { type BandsConfig, bandsLockInfoOf, readBands } from "../goal/bands.js";
import { createGoal, readGoal, referencedMetrics, semanticHash } from "../goal/goal-file.js";
import { diffStat } from "../goal/git.js";
import type { ApprovalExpectation } from "../goal/goal-lock.js";
import { type GapReport, measureGoal } from "../goal/measure.js";
import { metricSha256, proposeMetric, readProposal } from "../goal/metrics.js";
import { createMarkdownStore } from "../adapters/state-markdown.js";
import { type BudgetState, budgetStateFromEvents } from "../core/budget.js";
import { cancelGoal, cancelProblem, resumeGoal, resumeProblem, stoppedNextSteps } from "../goal/lifecycle.js";
import { type Escalation, type RunState, runStateFromEvents } from "../goal/run-state.js";
import { assertGoalExists, withTickLock } from "../goal/tick-lock.js";
import { verifiedItems } from "../work/ledger-verify.js";
import { OPEN_STATES, type RiskClass, type WorkState } from "../work/types.js";
import { confirmByTyping, requireTerminal } from "./confirm.js";

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
  if (report.state === "tampered") {
    console.log(
      `a lock does not match the ledger and measurement is stopped; run omf goal approve ${report.goal_id} to repair it`,
    );
  }
  if (report.budget !== null) {
    console.log(`budget: ${report.budget.remaining} of ${report.budget.declared + report.budget.raised} rounds left`);
  }
  if (report.wall_time_exceeded) console.log("wall time exceeded (J6)");
  printList("problems", report.problems);
  printList("needs re-approval (J1)", report.regime_changes);
  printList("warnings", report.warnings);
}

const listOrNone = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

const BAND_TIERS = ["3sigma", "2sigma", "1sigma"] as const;

/** One line per metric on the approval screen: the baseline and what each tier does, or that nothing is watched. */
function describeBands(config: BandsConfig | null): string {
  if (config === null) return "none (not monitored)";
  const tiers = BAND_TIERS.flatMap((tier) => {
    const entry = config.tiers[tier];
    return entry === undefined ? [] : [`${tier} -> ${entry.action}`];
  });
  return `baseline ${safeText(config.baseline)}; ${safeText(tiers.join(", "))}`;
}

/**
 * What the person approves, shown before the prompt: why approval is needed (problems and regime changes,
 * with the diff of watched paths), the locked fields, every metric command and the bands of every metric. `expected` holds the
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
    out(
      `why approval is needed again (goal ${safeText(goalId)} is ${audit.state.replace("needs_reapproval", "needs re-approval")}):`,
    );
    for (const problem of audit.problems) out(`  problem: ${safeText(problem)}`);
    for (const change of audit.regime_changes) out(`  - ${safeText(change)}`);
    if (audit.approval !== null && audit.watched_paths_changed.length > 0) {
      out(`changes since the approval at ${audit.approval.head_commit.slice(0, 12)}:`);
      const stat = diffStat(status.repo, audit.approval.head_commit, audit.watched_paths_changed);
      out(stat === "" ? "  (only untracked files; no diff to show)" : stat.split("\n").map(safeText).join("\n"));
    }
  }
  const { front } = readGoal(status.dir, goalId);
  out(`goal ${safeText(front.goal_id)}: ${safeText(front.title)}`);
  out(`objective: ${safeText(front.objective)}`);
  out(
    `target: ${safeText(front.target.metric_id)} ${front.target.operator} ${front.target.value} ${safeText(front.target.unit)}`,
  );
  out(
    `leading: ${safeText(listOrNone(front.leading))}; lagging: ${safeText(listOrNone(front.lagging))}; guardrails: ${safeText(listOrNone(front.guardrails))}`,
  );
  out(
    `budget: ${front.budget.rounds} rounds, ${safeText(front.budget.wall_time)} wall time, at most ${front.budget.max_open_work_items} open work items`,
  );
  out(
    `decision rule: ${safeText(front.prereg.decision_rule)} (minimum observation ${safeText(front.prereg.min_observation)})`,
  );
  for (const warning of audit.warnings) out(`warning: ${safeText(warning)}`);
  const metrics: Record<string, string> = {};
  for (const id of referencedMetrics(front)) {
    const proposal = readProposal(status.dir, id);
    if (proposal === null) {
      out(`metric ${safeText(id)}: no proposal`);
      continue;
    }
    metrics[id] = metricSha256(proposal);
    const image = proposal.image === null ? "" : `; image ${safeText(proposal.image)}`;
    out(
      `metric ${safeText(id)}: ${safeText(JSON.stringify(proposal.command))} -> ${safeText(proposal.unit)}; watches ${safeText(listOrNone(proposal.watched_paths))}${image}`,
    );
  }
  // Bands are locked with the goal (spec §4.6). The configs are read once, so the hash is of what is shown.
  const configs: Record<string, BandsConfig | null> = {};
  for (const id of referencedMetrics(front)) {
    configs[id] = readBands(status.dir, goalId, id);
    out(`bands ${safeText(id)}: ${describeBands(configs[id] ?? null)}`);
  }
  if (audit.approval !== null && audit.approval.bands_sha256 === null) {
    out(
      "bands not locked (approved before M2b): a change to a bands file is not a regime change until you approve again",
    );
  }
  const bands = bandsLockInfoOf(configs);
  return { lines, expected: { semantic_sha256: semanticHash(front), metrics, bands_sha256: bands.sha256 } };
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

interface GoalStatusReport {
  goal_id: string;
  state: RunState["status"];
  since: string | null;
  reason_code: string | null;
  ticks: number;
  audit_state: AuditReport["state"];
  rounds: BudgetState | null;
  disclosure: BudgetState | null;
  open_escalation: Escalation | null;
  next_steps: string[];
  /** `malformed` counts every item the ledger cannot account for; `repairable` is the subset one W edge behind it. */
  work: Record<WorkState, number> & { malformed: number; repairable: number };
}

function budgetLine(kind: string, state: BudgetState | null): string {
  return state === null
    ? `${kind}: not declared`
    : `${kind}: ${state.remaining} of ${state.declared + state.raised} left`;
}

function printStatus(report: GoalStatusReport): void {
  const audit = report.audit_state.replace("needs_reapproval", "needs re-approval");
  console.log(
    `goal ${report.goal_id}: ${report.state} (audit: ${audit}; ${report.ticks} ${report.ticks === 1 ? "tick" : "ticks"})`,
  );
  if (report.open_escalation !== null) {
    console.log(
      `${report.open_escalation.j} ${report.open_escalation.reason_code}: ${report.open_escalation.question}`,
    );
    console.log(`default: ${report.open_escalation.default}`);
  }
  console.log(budgetLine("rounds", report.rounds));
  console.log(budgetLine("disclosure", report.disclosure));
  console.log(
    `work: ${Object.entries(report.work)
      .map(([name, count]) => `${name.replace(/_/g, " ")} ${count}`)
      .join(", ")}`,
  );
  printList("next steps", report.next_steps);
}

/** What `omf goal tick` may print or emit as JSON: the TickResult without the model's titles (D29). */
type PublicTick = Omit<TickResult, "created"> & { created: { work_id: string; state: WorkState; risk: RiskClass }[] };

/**
 * A tick runs under cron and CI, whose logs other agents may read (spec §4.6: G receives aggregates only).
 * The TickResult holds no measured or target value; the model's titles are untrusted text, so ids stand in for them.
 * Values and the gap line stay in the host tick report.
 */
function publicTick(result: TickResult): PublicTick {
  const { created, ...rest } = result;
  return { ...rest, created: created.map(({ work_id, state, risk }) => ({ work_id, state, risk })) };
}

/**
 * Exit code of `omf goal tick` (spec §8). 0: the goal ticked on or finished. 1: a person has to act, which
 * includes a goal parked for a person, a tick the audit or a failed model call stopped, and any open item
 * awaiting approval (D18), so a cron user hears about it. Errors that stop the command exit 2 in main.ts.
 */
export function tickExitCode(result: TickResult): number {
  if (result.status === "finish") return 0;
  if (result.status !== "continue") return 1;
  if (result.outcome === "stopped" || result.outcome === "failed") return 1;
  return result.awaiting_approval.length > 0 ? 1 : 0;
}

function printTick(goalId: string, result: TickResult): void {
  const reason = result.reason_code === null ? "" : `: ${result.reason_code}`;
  console.log(`goal ${goalId}: tick ${result.tick_id} ${result.status} (${result.outcome}${reason})`);
  if (result.escalation !== null) {
    console.log(`${result.escalation.j} ${result.escalation.reason_code}: ${result.escalation.question}`);
  }
  for (const item of result.created) {
    console.log(`  dispatched ${item.work_id} (${item.state}, risk ${item.risk}); veto with: omf veto ${item.work_id}`);
  }
  if (result.rejected.length > 0) {
    const codes = [...new Set(result.rejected.map((r) => `${r.filter}:${r.reason_code}`))];
    console.log(`  rejected ${result.rejected.length} candidate(s): ${codes.join(", ")}`);
  }
  printList("awaiting approval", result.awaiting_approval);
  printList("next steps", result.next_steps);
  if (result.report !== null) console.log(`report: ${result.report}`);
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
      requireTerminal("J1 approval", "nothing was approved");
      const actor = humanActor(status.repo);
      const screen = approvalScreen(status, goalId);
      for (const line of screen.lines) console.log(line);
      if (!(await confirmByTyping(goalId, `Type ${goalId} to approve as ${actor}: `))) {
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
    .action(async (goalId: string, options: { runner: string; json?: boolean }) => {
      if (options.runner !== "docker" && options.runner !== "host") {
        throw new Error(`unknown runner ${options.runner}; use docker or host`);
      }
      const status = requireProject(process.cwd());
      if (options.runner === "docker") for (const line of legacyImageWarnings(status.dir, goalId)) console.error(line);
      const { report, file } = await measureGoal(status, goalId, { runner: options.runner });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printGap(report, file);
      if (report.isolation === "none") console.error("warning: measured on the host without isolation (--runner host)");
      const failed = report.metrics.some((m) => m.failure !== null);
      process.exitCode = report.needs_reapproval || failed ? 1 : 0;
    });

  goal
    .command("status")
    .argument("<goal_id>")
    .option("--json", "print the status as JSON")
    .description("show the run state, budgets, open escalation and work items of a goal (writes nothing)")
    .action((goalId: string, options: { json?: boolean }) => {
      const status = requireProject(process.cwd());
      assertGoalExists(status.dir, goalId);
      const events = new Ledger(status.dir).readVerified();
      const run = runStateFromEvents(events, goalId);
      const verified = verifiedItems(createMarkdownStore(status.dir), events, goalId);
      const work: Record<WorkState, number> = {
        ready: 0,
        awaiting_approval: 0,
        in_progress: 0,
        awaiting_review: 0,
        done: 0,
        failed: 0,
        vetoed: 0,
        cancelled: 0,
      };
      for (const item of verified.items) work[item.front.state] += 1;
      const report: GoalStatusReport = {
        goal_id: goalId,
        state: run.status,
        since: run.since,
        reason_code: run.reason_code,
        ticks: run.ticks,
        audit_state: auditGoal(status, goalId).state,
        rounds: budgetStateFromEvents(events, goalId, "rounds"),
        disclosure: budgetStateFromEvents(events, goalId, "disclosure"),
        open_escalation: run.open_escalation,
        next_steps: stoppedNextSteps(run, goalId),
        work: { ...work, malformed: verified.malformed.length, repairable: verified.repairable.length },
      };
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printStatus(report);
    });

  goal
    .command("resume")
    .argument("<goal_id>")
    .description("J6 continue: let a blocked or failed goal tick again (needs an interactive terminal)")
    .action(async (goalId: string) => {
      const status = requireProject(process.cwd());
      // The tick lock comes first: a running tick is reported before anything else, and no tick can start
      // between what the person reads below and the resume that follows (D23).
      await withTickLock(status, goalId, async () => {
        requireTerminal("goal resume");
        const actor = humanActor(status.repo);
        const ledger = new Ledger(status.dir);
        const run = runStateFromEvents(ledger.readVerified(), goalId);
        const problem = resumeProblem(run, goalId);
        if (problem !== null) throw new Error(problem);
        console.log(`goal ${goalId} is ${run.status}${run.reason_code === null ? "" : ` (${run.reason_code})`}`);
        if (run.open_escalation !== null) console.log(`${run.open_escalation.j}: ${run.open_escalation.question}`);
        if (!(await confirmByTyping(goalId, `Type ${goalId} to resume as ${actor}: `))) {
          console.error("not resumed");
          process.exitCode = 1;
          return;
        }
        resumeGoal(ledger, goalId, actor);
        console.log(`resumed ${goalId}; the next tick runs it again`);
      });
    });

  goal
    .command("cancel")
    .argument("<goal_id>")
    .description("J6 stop: end the goal and cancel its open work items (needs an interactive terminal)")
    .action(async (goalId: string) => {
      const status = requireProject(process.cwd());
      await withTickLock(status, goalId, async () => {
        requireTerminal("goal cancel");
        const actor = humanActor(status.repo);
        const ledger = new Ledger(status.dir);
        const store = createMarkdownStore(status.dir);
        const run = runStateFromEvents(ledger.readVerified(), goalId);
        const problem = cancelProblem(run, goalId);
        if (problem !== null) throw new Error(problem);
        const open = store.fetchWorkItemsByStates(goalId, OPEN_STATES).length;
        console.log(
          `goal ${goalId} is ${run.status}; cancelling ends it for good and cancels ${open} open work ${open === 1 ? "item" : "items"}`,
        );
        if (!(await confirmByTyping(goalId, `Type ${goalId} to cancel as ${actor}: `))) {
          console.error("not cancelled");
          process.exitCode = 1;
          return;
        }
        const result = cancelGoal(ledger, store, goalId, actor, new Date());
        console.log(
          `cancelled ${goalId}; ${result.cancelled.length} work ${result.cancelled.length === 1 ? "item" : "items"} cancelled`,
        );
      });
    });

  goal
    .command("tick")
    .argument("<goal_id>")
    .option("--runner <runner>", "docker (isolated) or host (no isolation)", "docker")
    .option("--json", "print the tick result as JSON")
    .description("run one pass of the goal loop: audit, measure, reconcile, dispatch, refresh (non-interactive)")
    .action(async (goalId: string, options: { runner: string; json?: boolean }) => {
      if (options.runner !== "docker" && options.runner !== "host") {
        throw new Error(`unknown runner ${options.runner}; use docker or host`);
      }
      const status = requireProject(process.cwd());
      // spec §11.5: an unreadable config.toml stops the command; there is no silent fallback to defaults.
      const config = readConfig(status.dir);
      const reconciler = createReconciler(status.dir, config.reconciler);
      if (options.runner === "host") console.error("warning: ticking on the host without isolation (--runner host)");
      if (options.runner === "docker") for (const line of legacyImageWarnings(status.dir, goalId)) console.error(line);
      const result = await tickGoal(status, goalId, { runner: options.runner, reconciler, config });
      if (options.json) console.log(JSON.stringify(publicTick(result), null, 2));
      else printTick(goalId, result);
      process.exitCode = tickExitCode(result);
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
        {
          metric_id: metricId,
          command,
          unit: options.unit,
          watched_paths: options.watch,
          image: options.image ?? null,
        },
        owner,
      );
      console.log(`proposed ${proposal.metric_id} as ${owner}`);
      if (proposal.watched_paths.length === 0) {
        console.error(
          `warning: ${proposal.metric_id} watches no path, so a change to the code it runs is not a regime change; add --watch <glob>`,
        );
      }
    });
}
