import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ReconcileFailureCode,
  ReconcileOutcome,
  ReconcileRequest,
  Reconciler,
} from "../../src/adapters/reconciler.js";
import { type StateStore, createMarkdownStore, workItemDir } from "../../src/adapters/state-markdown.js";
import { CONFIG_DEFAULTS, type OmfConfig } from "../../src/core/config.js";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { bandsFile } from "../../src/goal/bands.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { type TickOptions, type TickResult, tickGoal } from "../../src/goal/tick.js";
import { fingerprintOf, workIdOf } from "../../src/work/fingerprint.js";
import { wEvent } from "../../src/work/w-events.js";
import type { IntentCandidate, RiskAssessment, WorkState } from "../../src/work/types.js";
import { type GoalFixture, setupGoal } from "./goal.js";
import { commitAll } from "./tmp.js";
import { recordW } from "./work.js";

export const TICK_GOAL = "g-fast";

/** The fixture goal sets `prereg.min_observation` to this, so a fake clock can step past it. */
export const MIN_OBSERVATION_MS = 10 * 60_000;

export interface FakeClock {
  now: () => Date;
  advance: (ms: number) => void;
}

export function fakeClock(start: Date = new Date()): FakeClock {
  let at = start.getTime();
  return {
    now: (): Date => new Date(at),
    advance: (ms: number): void => {
      at += ms;
    },
  };
}

/** `t-<yyyymmdd>T<hhmmss>Z-<4 hex>`, the shape the work item schema requires, with a counter instead of randomness. */
function tickIds(): (at: Date) => string {
  let n = 0;
  return (at: Date): string => {
    n += 1;
    const stamp = at
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/[-:]/g, "");
    return `t-${stamp}-${n.toString(16).padStart(4, "0")}`;
  };
}

export interface FakeReconciler extends Reconciler {
  /** How many times the tick called the model. */
  calls: number;
  prompts: string[];
  /** Every later call answers with these candidates (raw JSON, like a `command` reconciler). */
  reply: (candidates: readonly IntentCandidate[]) => void;
  /** Every later call fails with this code. */
  fail: (code: ReconcileFailureCode) => void;
}

/** An in-process reconciler. Tests never reach a real model (design §0). */
export function fakeReconciler(): FakeReconciler {
  let next: ReconcileOutcome = { ok: true, stdout: JSON.stringify({ candidates: [] }), durationMs: 1 };
  const fake: FakeReconciler = {
    id: "command:fake",
    isolation: "host-tool-less",
    calls: 0,
    prompts: [],
    reply: (candidates): void => {
      next = { ok: true, stdout: JSON.stringify({ candidates }), durationMs: 1 };
    },
    fail: (code): void => {
      next = { ok: false, code, reason: `fake ${code}`, durationMs: 1 };
    },
    run: async (request: ReconcileRequest): Promise<ReconcileOutcome> => {
      fake.calls += 1;
      fake.prompts.push(request.prompt);
      return next;
    },
  };
  return fake;
}

/** A candidate that passes the schema and seed lint for the fixture goal and is `normal` risk unless `paths` says otherwise. */
export function candidateOf(title: string, paths: string[] = ["src/render"]): IntentCandidate {
  return {
    title,
    problem: "Repeat visits redo the same rendering work.",
    proposed_outcome: "Repeat visits reuse earlier rendering work.",
    affected_users_systems: "Visitors and the render path.",
    constraints: "",
    open_questions: [],
    rationale: "The same pages are rendered again and again.",
    affected_paths: paths,
  };
}

export interface TickSetup {
  mode?: "build" | "watch";
  /** Default 10 (the template value). */
  rounds?: number;
  /** `budget.max_open_work_items`, default 2 (the template value). */
  maxOpen?: number;
  /** What `bench/p95.value` holds at approval; the target is `<= 250`. Default 312 (unmet). */
  p95?: number;
  /** `none`: no guardrail. `no-bands`: guardrail m-errors without a bands file. `bands`: guardrail m-errors with bands. */
  guardrail?: "none" | "no-bands" | "bands";
  /** Bands on the target metric whose 3sigma action is `propose` (for watch mode breaches). */
  targetBands?: boolean;
  /** Default true. False leaves the goal a draft. */
  approve?: boolean;
}

export interface TickFixture extends GoalFixture {
  clock: FakeClock;
  reconciler: FakeReconciler;
  config: OmfConfig;
  store: StateStore;
  /** Reads and writes with the fake clock. */
  ledger: Ledger;
  tick: (options?: Partial<TickOptions>) => Promise<TickResult>;
}

function writeBands(fx: GoalFixture, metricId: string, tiers: string): void {
  const file = bandsFile(fx.location.dir, TICK_GOAL, metricId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `metric: ${metricId}\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n${tiers}\n`);
}

/** Writes `bench/p95.value` and commits it. The metric script is watched; this file is not. */
export function setP95(fx: GoalFixture, value: number): void {
  writeFileSync(join(fx.repo, "bench", "p95.value"), `${value}\n`);
  commitAll(fx.repo, `p95 is ${value}`);
}

export function setupTick(setup: TickSetup = {}): TickFixture {
  const guardrail = setup.guardrail ?? "none";
  const base = setupGoal({ guardrails: guardrail === "none" ? [] : ["m-errors"] });
  writeFileSync(join(base.repo, "bench", "p95.sh"), "cat bench/p95.value\n");
  writeFileSync(join(base.repo, "bench", "p95.value"), `${setup.p95 ?? 312}\n`);
  commitAll(base.repo, "p95 script reads p95.value");
  writeFileSync(
    base.goalFile,
    readFileSync(base.goalFile, "utf8")
      .replace("mode: build", `mode: ${setup.mode ?? "build"}`)
      .replace("rounds: 10", `rounds: ${setup.rounds ?? 10}`)
      .replace("max_open_work_items: 2", `max_open_work_items: ${setup.maxOpen ?? 2}`)
      .replace("min_observation: 7d", "min_observation: 10m"),
  );
  if (guardrail === "bands") writeBands(base, "m-errors", "  3sigma: { action: log }");
  if (setup.targetBands === true) writeBands(base, "m-p95", "  3sigma: { action: propose, routes: [pull_request] }");

  const clock = fakeClock();
  if (setup.approve !== false) lockGoal(base.location, TICK_GOAL, "human:dev", clock.now);
  const reconciler = fakeReconciler();
  const config: OmfConfig = {
    ...CONFIG_DEFAULTS,
    reconciler: { ...CONFIG_DEFAULTS.reconciler, kind: "command", command: ["fake-reconciler"] },
  };
  const newTickId = tickIds();
  return {
    ...base,
    clock,
    reconciler,
    config,
    store: createMarkdownStore(base.location.dir),
    ledger: new Ledger(base.location.dir, clock.now),
    tick: (options = {}): Promise<TickResult> =>
      tickGoal(base.location, TICK_GOAL, { runner: "host", reconciler, config, now: clock.now, newTickId, ...options }),
  };
}

export function ledgerEvents(fx: TickFixture): LedgerEvent[] {
  return fx.ledger.readVerified();
}

/** The events from the latest `goal.tick_started` to the end of the ledger. */
export function lastTickEvents(fx: TickFixture): LedgerEvent[] {
  const all = ledgerEvents(fx);
  return all.slice(all.map((event) => event.type).lastIndexOf("goal.tick_started"));
}

export function lastTickTypes(fx: TickFixture): string[] {
  return lastTickEvents(fx).map((event) => event.type);
}

/**
 * A work item that verifies against the ledger: `work.created` first (as `reconcileGoal` does, D30), then the
 * store write. A W state also gets the W trail a run would have left (`recordW`): `in_progress` has
 * `work.started`, `awaiting_review` and `failed` add `work.submitted` / `work.failed`, because the verifier
 * rejects a W state without its event (M3b1-D4). item.md is then rewritten to that state, the way the store
 * would have left it. `done` has no writer before M4, so it cannot be seeded.
 */
export function seedWorkItem(
  fx: TickFixture,
  spec: { title: string; paths?: string[]; state?: WorkState; risk?: RiskAssessment },
): string {
  const paths = spec.paths ?? ["src/seeded"];
  const candidate = candidateOf(spec.title, paths);
  const fingerprint = fingerprintOf(TICK_GOAL, candidate);
  const workId = workIdOf(fingerprint);
  const risk: RiskAssessment = spec.risk ?? { class: "normal", rules: [], paths };
  const created: WorkState = risk.class === "high" ? "awaiting_approval" : "ready";
  const tickId = "t-20200101T000000Z-0000";
  fx.ledger.append({
    actor: "omf",
    type: "work.created",
    payload: {
      goal_id: TICK_GOAL,
      work_id: workId,
      tick_id: tickId,
      fingerprint,
      state: created,
      risk_class: risk.class,
      risk_rules: risk.rules,
      item: `goals/${TICK_GOAL}/work/${workId}/item.md`,
    },
  });
  fx.store.createWorkItem(
    { goal_id: TICK_GOAL, tick_id: tickId, trigger: "gap", candidate, fingerprint, risk },
    fx.clock.now(),
  );
  const state = spec.state ?? created;
  if (state === "done") throw new Error("seedWorkItem cannot seed done: nothing writes it before M4");
  if (state !== created) {
    const item = { front: { goal_id: TICK_GOAL, work_id: workId } };
    if (state === "in_progress" || state === "awaiting_review" || state === "failed") {
      recordW(fx.ledger, "work.started", item);
      if (state === "awaiting_review")
        recordW(fx.ledger, "work.submitted", item, { outcome: "flawed", recommendation: "not_recommended" });
      if (state === "failed") recordW(fx.ledger, "work.failed", item);
    }
    const file = join(workItemDir(fx.location.dir, TICK_GOAL, workId), "item.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^state: .*$/m, `state: ${state}`));
  }
  return workId;
}

/**
 * An item whose ledger is one W edge ahead of item.md, as a crash between the event and the file leaves it:
 * `in_progress` is a `ready` file whose ledger says `work.started`; `awaiting_review` is an `in_progress` file
 * whose ledger says `work.submitted`. The verifier reports it as `w_repairable` and nothing here repairs it.
 */
export function seedRepairable(fx: TickFixture, title: string, to: "in_progress" | "awaiting_review"): string {
  const workId = seedWorkItem(fx, { title, state: to === "in_progress" ? "ready" : "in_progress" });
  const scope = { goal_id: TICK_GOAL, work_id: workId, run_id: "r-20261014T091500Z-ab12" };
  fx.ledger.append(
    wEvent(
      to === "in_progress"
        ? { type: "work.started", payload: { ...scope, from: "ready" } }
        : { type: "work.submitted", payload: { ...scope, outcome: "flawed", recommendation: "not_recommended" } },
    ),
  );
  return workId;
}
