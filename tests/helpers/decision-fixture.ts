import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { type DecideReport, decideReport, runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { Gate1Reason, Gate1Result } from "../../src/decision/gate1.js";
import { loadLeakContext } from "../../src/decision/leak-lint.js";
import { renderSpec, specFile } from "../../src/decision/spec-md.js";
import { foldDecisions } from "../../src/decision/state.js";
import type { DecisionClass, DecisionScope, InterfaceContract } from "../../src/decision/types.js";
import { DecisionError } from "../../src/decision/write.js";
import { approveGoal } from "../../src/goal/approve.js";
import { goalFile } from "../../src/goal/goal-file.js";
import { fingerprintOf } from "../../src/work/fingerprint.js";
import type { WorkItem } from "../../src/work/types.js";
import { CANARY } from "./canary.js";
import { omf } from "./cli.js";
import {
  type EnforcementFixture,
  type EnforcementOptions,
  ledgerEvents,
  setupEnforcementGoal,
} from "./enforcement-goal.js";
import { createRecorded, makeNewItem } from "./work.js";

/** A fixed clock for GATE-1 verdicts. Write verbs that compare against it take it as their `now`. */
export const NOW = new Date("2026-10-14T00:00:00.000Z");
export const HUMAN = "human:tester@example.invalid";

/** A valid interface decision body: argv arrays only, gates named in `required` are non-null. */
export const CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/cache.js"],
  io_contract: "Reads one JSON request on stdin and writes one JSON reply on stdout.",
  gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast"] },
  test_command: ["npm", "test"],
};

export interface DecisionFixture {
  fx: EnforcementFixture;
  /** A `ready` work item of the goal, recorded in the ledger. */
  item: WorkItem;
  workId: string;
  scope: DecisionScope;
}

/**
 * The canary goal of E2 (target 3719.25, metric m-zebra-quokka, reading 4817.39) with one `ready` work item.
 * `openQuestions` become the intent's open questions, which the first decide write seeds as decisions (F8).
 */
export function setupDecisionItem(options: EnforcementOptions & { openQuestions?: string[] } = {}): DecisionFixture {
  const { openQuestions = [], ...goalOptions } = options;
  const fx = setupEnforcementGoal(goalOptions);
  const base = makeNewItem({ goalId: fx.goalId });
  const candidate = { ...base.candidate, open_questions: openQuestions };
  const input = { ...base, candidate, fingerprint: fingerprintOf(fx.goalId, candidate) };
  const item = createRecorded(fx.ledger, createMarkdownStore(fx.location.dir), input);
  return { fx, item, workId: item.front.work_id, scope: { goal_id: fx.goalId, work_id: item.front.work_id } };
}

export function addInterface(f: DecisionFixture): void {
  runDecideAdd(
    f.fx.location,
    f.workId,
    { id: "d-interface", class: "interface", question: "How do callers use the cache?" },
    "omf",
  );
}

export function resolveInterface(f: DecisionFixture, contract: InterfaceContract = CONTRACT): void {
  runDecideResolve(
    f.fx.location,
    f.workId,
    "d-interface",
    { choice: "A command line program", rationale: "Callers already shell out.", rejected: [], interface: contract },
    HUMAN,
  );
}

/** Adds and resolves the mandatory interface decision. */
export function closeInterface(f: DecisionFixture, contract: InterfaceContract = CONTRACT): void {
  addInterface(f);
  resolveInterface(f, contract);
}

/** An open decision with a clean question. */
export function addOpen(f: DecisionFixture, id: string, cls: DecisionClass = "other"): void {
  runDecideAdd(f.fx.location, f.workId, { id, class: cls, question: "Should the cache survive a restart?" }, "omf");
}

export function resolveOpen(f: DecisionFixture, id: string): void {
  runDecideResolve(
    f.fx.location,
    f.workId,
    id,
    { choice: "Keep the current behavior", rationale: "Nothing depends on a change.", rejected: [] },
    HUMAN,
  );
}

/** Read-only fold, lint and GATE-1 verdict at `now`. */
export function reportAt(f: DecisionFixture, now: Date): DecideReport {
  return decideReport(f.fx.location, f.workId, now);
}

export function reasonsOf(gate: Gate1Result): Gate1Reason[] {
  return gate.status === "pass" ? [] : gate.reasons;
}

/** The reasons that name decision `id`. */
export function reasonsFor(gate: Gate1Result, id: string): Gate1Reason[] {
  return reasonsOf(gate).filter((reason) => "decision_id" in reason && reason.decision_id === id);
}

/** `omf decide <args...>` through the built CLI, stdin not a terminal. */
export function decideCli(f: DecisionFixture, args: string[]): { code: number; stdout: string; stderr: string } {
  return omf(["decide", ...args], f.fx.repo, f.fx.home);
}

/** Makes sure spec.md exists, so a later `lint` has no missing-file problem of its own. The exit code is not the point. */
export function settle(f: DecisionFixture): void {
  decideCli(f, ["lint", f.workId, "--render"]);
  if (!existsSync(specFile(f.item.dir))) throw new Error("decide lint --render did not write spec.md");
}

/** Writes a JSON input file next to the reconciler record (outside the repo and the host state) and returns its path. */
export function writeJson(f: DecisionFixture, name: string, data: unknown): string {
  const file = join(f.fx.record, name);
  writeFileSync(file, JSON.stringify(data));
  return file;
}

/** Appends a decision event straight into the ledger, as someone with write access would. */
export function forge(
  f: DecisionFixture,
  actor: string,
  type: string,
  decisionId: string,
  extra: Record<string, unknown>,
): LedgerEvent {
  return f.fx.ledger.append({
    actor,
    type,
    payload: { goal_id: f.scope.goal_id, work_id: f.scope.work_id, decision_id: decisionId, ...extra },
  });
}

export function decisionEvents(f: DecisionFixture): LedgerEvent[] {
  return ledgerEvents(f.fx).filter((event) => event.type.startsWith("decision."));
}

/** What spec.md must contain now: the pure render of the verified ledger. T9's run* functions use the work item title as header. */
export function expectedSpec(f: DecisionFixture): string {
  const events = f.fx.ledger.readVerified();
  const leak = loadLeakContext(f.fx.location.dir, f.fx.goalId, events);
  return renderSpec(foldDecisions(events, f.scope), { title: f.item.front.title }, leak);
}

/** The `DecisionError` code a call throws, "no error" when it returns, `other: ...` for anything else. */
export function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof DecisionError ? err.code : `other: ${String(err)}`;
  }
  return "no error";
}

/** One host measurement, so `metric.measured` holds the canary reading (the lint compares numbers with it). */
export function measureOnce(f: DecisionFixture): void {
  const run = omf(["goal", "measure", f.fx.goalId, "--runner", "host"], f.fx.repo, f.fx.home);
  if (run.code !== 0) throw new Error(`goal measure failed: ${run.stdout}${run.stderr}`);
}

/** Edits the locked target in goal.md and approves again (J1), so the goal lock holds `value`. */
export function relockTarget(f: DecisionFixture, value: number): void {
  const file = goalFile(f.fx.location.dir, f.fx.goalId);
  const text = readFileSync(file, "utf8");
  if (!text.includes(`value: ${CANARY.target}`)) throw new Error("goal.md does not hold the canary target");
  writeFileSync(file, text.replace(`value: ${CANARY.target}`, `value: ${value}`));
  if (!approveGoal(f.fx.location, f.fx.goalId, "human:dev").created)
    throw new Error("the re-approval wrote no new lock");
}
