import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { declareBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { type ProjectLocation, resolveProject } from "../../src/core/paths.js";
import { writePrivateFile } from "../../src/core/private-fs.js";
import { initProject } from "../../src/core/project.js";
import { bandsFile } from "../../src/goal/bands.js";
import {
  createGoal,
  goalTemplate,
  readGoal,
  referencedMetrics,
  semanticHash,
  semanticOf,
} from "../../src/goal/goal-file.js";
import { headCommit } from "../../src/goal/git.js";
import { goalLockFile, lockGoal } from "../../src/goal/goal-lock.js";
import { definitionOf, metricSha256, proposeMetric, readProposal, writeLock } from "../../src/goal/metrics.js";
import type { IntentCandidate } from "../../src/work/types.js";
import type { ReconcileOutcome, ReconcileRequest, Reconciler } from "../../src/adapters/reconciler.js";
import { type StateStore, createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { readConfig } from "../../src/core/config.js";
import { auditGoal } from "../../src/goal/audit.js";
import type { GapSummary } from "../../src/goal/gap-summary.js";
import type { ReconcileContext } from "../../src/goal/reconcile.js";
import { commitAll, makeGitRepo, makeTempDir } from "./tmp.js";

export interface GoalFixture {
  repo: string;
  /** Use as HOME for CLI runs; OMF state is under `<home>/.omf`, the same place the core calls use. */
  home: string;
  env: NodeJS.ProcessEnv;
  location: ProjectLocation;
  ledger: Ledger;
  goalFile: string;
}

/**
 * An initialized project with goal g-fast: target m-p95 <= 250 ms (the bench prints 312), guardrail
 * m-errors (prints 0.4). m-p95 watches `bench/p95.sh` only, so editing bench/errors.sh is not a regime
 * change. Both metrics are proposed by human:dev. Nothing is approved yet.
 */
export function setupGoal(options: { guardrails?: string[] } = {}): GoalFixture {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env = { OMF_HOME: join(home, ".omf") };
  initProject(repo, env);
  const location = resolveProject(repo, env);
  mkdirSync(join(repo, "bench"), { recursive: true });
  writeFileSync(join(repo, "bench", "p95.sh"), "echo 312\n");
  writeFileSync(join(repo, "bench", "errors.sh"), "echo 0.4\n");
  commitAll(repo, "add bench");
  const goalFile = createGoal(location.dir, "g-fast");
  const guardrails = options.guardrails ?? ["m-errors"];
  writeFileSync(
    goalFile,
    goalTemplate("g-fast")
      .replace(/m-replace-me/g, "m-p95")
      .replace("value: 0", "value: 250")
      // Older tests count elapsed time against 72h; the shipped default is longer (see the observation tests in audit.test.ts).
      .replace("wall_time: 14d", "wall_time: 72h")
      .replace("guardrails: []", `guardrails: [${guardrails.join(", ")}]`),
  );
  const ledger = new Ledger(location.dir);
  proposeMetric(
    ledger,
    location.dir,
    { metric_id: "m-p95", command: ["sh", "bench/p95.sh"], unit: "ms", watched_paths: ["bench/p95.sh"], image: null },
    "human:dev",
  );
  proposeMetric(
    ledger,
    location.dir,
    { metric_id: "m-errors", command: ["sh", "bench/errors.sh"], unit: "%", watched_paths: [], image: null },
    "human:dev",
  );
  return { repo, home, env, location, ledger, goalFile };
}

/**
 * Writes `goals/<goal>/bands/<metric>.yaml` with one 3 sigma tier and returns its path. A test edits the
 * returned file to change the bands after approval.
 */
export function writeBands(
  fx: GoalFixture,
  metricId: string,
  action: "log" | "diagnose" | "propose" = "propose",
): string {
  const file = bandsFile(fx.location.dir, "g-fast", metricId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `metric: ${metricId}\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  3sigma: { action: ${action} }\n`,
  );
  return file;
}

/**
 * Approves goal g-fast exactly as `lockGoal` did before M2b: the `goal.approved` event has no `bands_sha256`
 * and no `wall_time`, and the goal lock has no `bands` map. Used to prove that such an approval still audits clean.
 */
export function approveLegacy(fx: GoalFixture): void {
  const goal = readGoal(fx.location.dir, "g-fast");
  const metrics = referencedMetrics(goal.front);
  const approvedAt = new Date().toISOString();
  for (const id of metrics) {
    const proposal = readProposal(fx.location.dir, id)!;
    const sha256 = metricSha256(proposal);
    writeLock(fx.location.dir, {
      schema_version: 1,
      goal_id: "g-fast",
      ...definitionOf(proposal),
      owner: proposal.owner,
      approved_by: "human:dev",
      approved_at: approvedAt,
      sha256,
      regime: 1,
    });
    fx.ledger.append({
      actor: "human:dev",
      type: "metric.locked",
      payload: { goal_id: "g-fast", metric_id: id, sha256, regime: 1 },
    });
  }
  const semantic = semanticOf(goal.front);
  const semantic_sha256 = semanticHash(semantic);
  const head_commit = headCommit(fx.repo);
  const lock = {
    schema_version: 1,
    goal_id: "g-fast",
    regime: 1,
    semantic_sha256,
    head_commit,
    metrics,
    approved_by: "human:dev",
    approved_at: approvedAt,
    semantic,
  };
  writePrivateFile(goalLockFile(fx.location.dir, "g-fast"), `${JSON.stringify(lock, null, 2)}\n`);
  fx.ledger.append({
    actor: "human:dev",
    type: "goal.approved",
    payload: { goal_id: "g-fast", regime: 1, semantic_sha256, head_commit, metrics },
  });
  declareBudget(fx.ledger, "g-fast", "rounds", goal.front.budget.rounds, "human:dev");
}

/** Appends the `goal.stale` event that the refresh stage (Task 10) writes, so audit tests need no tick. */
export function markStale(fx: GoalFixture, tripped: string[] = ["age"]): void {
  fx.ledger.append({
    actor: "omf",
    type: "goal.stale",
    payload: {
      goal_id: "g-fast",
      tick_id: "t-20261012T000000Z-0001",
      regime: 1,
      tripped,
      signals: { age_ms: 1_209_600_001, commits_since: null, target_move: null },
    },
  });
}

/** A tick id in the shape work items require (`origin.tick_id`). */
export const TICK = "t-20261012T090000Z-0001";

/**
 * A candidate that passes schema, scope and seed lint for the fixture goal: no digits, no metric names.
 * The title and paths decide its fingerprint, so tests make candidates distinct by title.
 */
export function makeCandidate(
  title: string,
  paths: string[],
  overrides: Partial<IntentCandidate> = {},
): IntentCandidate {
  return {
    title,
    problem: "The render path does extra work on every request.",
    proposed_outcome: "The render path reuses work it already did.",
    affected_users_systems: "Visitors of the site and the rendering code.",
    constraints: "",
    open_questions: [],
    rationale: "Reusing work keeps pages quick without changing behavior.",
    affected_paths: paths,
    ...overrides,
  };
}

/**
 * The command reconciler used by fixtures: it drains stdin, then prints the response file named by its
 * first argument. A real subprocess, but no model and no network.
 */
const STUB_SCRIPT =
  'process.stdin.on("data",()=>{});process.stdin.on("end",()=>{process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))})';

export interface TickGoalFixture extends GoalFixture {
  /** The file the command reconciler prints. Rewrite it with `stubResponse`. */
  stubFile: string;
}

/**
 * An approved goal (J1 done, regime 1) ready for the goal loop: build mode, target m-p95 <= 250 ms,
 * `max_open_work_items: 2`, `rounds: 10`. The metric runs `sh bench/p95.sh`, which prints whatever
 * `bench/p95.value` holds (312 at first), and only the script is watched, so a later turn can change the
 * value file without a regime change. `config.toml` gets a `[reconciler]` section that runs the stub
 * command. Guardrails default to none, so the success proof does not need bands.
 */
export function setupTickGoal(options: { guardrails?: string[] } = {}): TickGoalFixture {
  const fx = setupGoal({ guardrails: options.guardrails ?? [] });
  writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo $(cat bench/p95.value)\n");
  writeFileSync(join(fx.repo, "bench", "p95.value"), "312\n");
  commitAll(fx.repo, "make the p95 bench read its value from a file");
  lockGoal(fx.location, "g-fast", "human:dev");
  const stubFile = join(fx.home, "reconciler-response.json");
  writeFileSync(stubFile, JSON.stringify({ candidates: [] }));
  appendFileSync(
    join(fx.location.dir, "config.toml"),
    `\n[reconciler]\nkind = "command"\ncommand = ${JSON.stringify([process.execPath, "-e", STUB_SCRIPT, stubFile])}\n`,
  );
  return { ...fx, stubFile };
}

/** Makes the command reconciler answer with `{ candidates }`. Takes unknown items so a test can send malformed ones. */
export function stubResponse(fx: TickGoalFixture, candidates: readonly unknown[]): void {
  writeFileSync(fx.stubFile, JSON.stringify({ candidates }));
}

export interface FakeReconciler extends Reconciler {
  /** Every request, in order: how a test proves the model was or was not called. */
  calls: ReconcileRequest[];
}

/** An in-process reconciler that answers with the given outcomes in order and repeats the last one. */
export function fakeReconciler(...responses: ReconcileOutcome[]): FakeReconciler {
  const calls: ReconcileRequest[] = [];
  return {
    id: "fake",
    isolation: "host-tool-less",
    calls,
    async run(request: ReconcileRequest): Promise<ReconcileOutcome> {
      calls.push(request);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next === undefined) throw new Error("fakeReconciler needs at least one response");
      return next;
    },
  };
}

/** A successful model call whose stdout is `{ candidates }`. */
export function okResponse(candidates: readonly unknown[]): ReconcileOutcome {
  return { ok: true, stdout: JSON.stringify({ candidates }), durationMs: 5 };
}

/** The gap the fixture goal has at first: 312 against 250 is a medium decrease. */
export const MEDIUM_GAP: GapSummary = { trigger: "gap", gap: { direction: "decrease", size: "medium" }, breach: null };

/** Everything `reconcileGoal` needs, read from the approved fixture the way a tick reads it. */
export function reconcileContext(
  fx: TickGoalFixture,
  reconciler: Reconciler,
  extra: { summary?: GapSummary; store?: StateStore; tickId?: string } = {},
): ReconcileContext {
  const { front, body } = readGoal(fx.location.dir, "g-fast");
  const audit = auditGoal(fx.location, "g-fast", new Date());
  if (audit.locked === null) throw new Error("the fixture goal is not approved");
  return {
    location: fx.location,
    ledger: fx.ledger,
    store: extra.store ?? createMarkdownStore(fx.location.dir),
    reconciler,
    config: readConfig(fx.location.dir),
    goalId: "g-fast",
    tickId: extra.tickId ?? TICK,
    front,
    body,
    locked: audit.locked,
    summary: extra.summary ?? MEDIUM_GAP,
    now: () => new Date("2026-10-12T09:00:00.000Z"),
  };
}
