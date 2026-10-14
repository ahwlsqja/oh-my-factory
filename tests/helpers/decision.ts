import { Ledger } from "../../src/core/ledger.js";
import type { LedgerEvent, NewEvent } from "../../src/core/ledger.js";
import type {
  DecisionClass,
  DecisionScope,
  InterfaceContract,
  Qas,
  ResponseMeasure,
} from "../../src/decision/types.js";
import { makeTempDir } from "./tmp.js";

export const SCOPE: DecisionScope = { goal_id: "g-fast", work_id: "w-0a1b2c3d4e5f" };
/** Same goal, other item; used to prove the fold ignores events of other work items. */
export const OTHER_SCOPE: DecisionScope = { goal_id: "g-fast", work_id: "w-ffffffffffff" };
export const HUMAN = "human:dev@example.com";
export const DECISION_AT = "2026-10-12T10:00:00.000Z";
export const DEFERRAL_EXPIRES = "2026-12-01T00:00:00.000Z";

export const QAS: Qas = {
  source: "a caller of the render module",
  stimulus: "renders the same input twice",
  environment: "warm process, no concurrent writers",
  artifact: "the render module",
  response: "the second call reuses the first layout",
};

export const MEASURE: ResponseMeasure = {
  metric: "warm render time",
  op: "<=",
  threshold: 250,
  unit: "ms",
  percentile: 95,
  window: null,
};

export const CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/cli/main.js"],
  io_contract: "Reads a layout file on stdin and writes the rendered text on stdout; exit 0 on success.",
  gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast"] },
  test_command: ["npm", "test"],
};

/** An event the fold must skip: it is not a `decision.*` event. */
export const NOISE: NewEvent = { actor: "omf", type: "goal.measured", payload: { goal_id: SCOPE.goal_id } };

/** A `decision.*` event with the scope fields filled in. `payload` is written as given, so tests can forge bad shapes. */
export function rawDecisionEvent(
  type: string,
  payload: Record<string, unknown>,
  options: { scope?: DecisionScope; actor?: string } = {},
): NewEvent {
  const scope = options.scope ?? SCOPE;
  return {
    actor: options.actor ?? "omf",
    type,
    payload: { goal_id: scope.goal_id, work_id: scope.work_id, ...payload },
  };
}

export interface AddedOptions {
  class?: DecisionClass;
  question?: string;
  qas?: Qas;
  response_measure?: ResponseMeasure;
  actor?: string;
  scope?: DecisionScope;
}

export function addedEvent(id: string, options: AddedOptions = {}): NewEvent {
  return rawDecisionEvent(
    "decision.added",
    {
      decision_id: id,
      class: options.class ?? "other",
      question: options.question ?? `Question for ${id}?`,
      ...(options.qas !== undefined ? { qas: options.qas } : {}),
      ...(options.response_measure !== undefined ? { response_measure: options.response_measure } : {}),
    },
    { scope: options.scope, actor: options.actor ?? "omf" },
  );
}

export interface ResolvedOptions {
  actor?: string;
  /** Written into `resolution.by`; defaults to the actor. Set it to forge a signature that differs from the actor. */
  by?: string;
  at?: string;
  choice?: string;
  rationale?: string;
  rejected?: string[];
  response_measure?: ResponseMeasure;
  interface?: InterfaceContract;
  scope?: DecisionScope;
}

export function resolvedEvent(id: string, options: ResolvedOptions = {}): NewEvent {
  const actor = options.actor ?? HUMAN;
  return rawDecisionEvent(
    "decision.resolved",
    {
      decision_id: id,
      resolution: {
        choice: options.choice ?? "memoize per input",
        rationale: options.rationale ?? "Repeated layout work dominates the slow path.",
        rejected: options.rejected ?? ["no cache"],
        by: options.by ?? actor,
        at: options.at ?? DECISION_AT,
      },
      ...(options.response_measure !== undefined ? { response_measure: options.response_measure } : {}),
      ...(options.interface !== undefined ? { interface: options.interface } : {}),
    },
    { scope: options.scope, actor },
  );
}

export interface DeferredOptions {
  actor?: string;
  /** Written into `deferral.signed_by`; defaults to the actor. */
  signed_by?: string;
  owner?: string;
  reason?: string;
  revisit_trigger?: string;
  default?: string;
  expires_at?: string;
  scope?: DecisionScope;
}

export function deferredEvent(id: string, options: DeferredOptions = {}): NewEvent {
  const actor = options.actor ?? HUMAN;
  return rawDecisionEvent(
    "decision.deferred",
    {
      decision_id: id,
      deferral: {
        owner: options.owner ?? "dev@example.com",
        reason: options.reason ?? "needs production traffic numbers",
        revisit_trigger: options.revisit_trigger ?? "after the first week in production",
        default: options.default ?? "no cache",
        signed_by: options.signed_by ?? actor,
        expires_at: options.expires_at ?? DEFERRAL_EXPIRES,
      },
    },
    { scope: options.scope, actor },
  );
}

export interface NaOptions {
  actor?: string;
  by?: string;
  at?: string;
  rationale?: string;
  scope?: DecisionScope;
}

export function naEvent(id: string, options: NaOptions = {}): NewEvent {
  const actor = options.actor ?? HUMAN;
  return rawDecisionEvent(
    "decision.marked_na",
    {
      decision_id: id,
      rationale: options.rationale ?? "This item has no such concern.",
      by: options.by ?? actor,
      at: options.at ?? DECISION_AT,
    },
    { scope: options.scope, actor },
  );
}

/** A `decision.rejected` audit event. `id: null` records the hashed form used when the id itself leaked. */
export function rejectedEvent(
  id: string | null,
  options: { op?: "add" | "resolve" | "defer" | "na"; sha12?: string; scope?: DecisionScope } = {},
): NewEvent {
  return rawDecisionEvent(
    "decision.rejected",
    {
      op: options.op ?? "add",
      findings: [{ rule: "metric-name", field: "question" }],
      ...(id !== null ? { decision_id: id } : { decision_id_sha12: options.sha12 ?? "0123456789ab" }),
    },
    { scope: options.scope },
  );
}

/** Appends `events` to a fresh ledger with a fixed clock and returns the verified events, so seq, prev_hash and hash are real. */
export function eventsOf(...events: NewEvent[]): LedgerEvent[] {
  const ledger = new Ledger(makeTempDir("omf-decision-"), () => new Date(DECISION_AT));
  for (const event of events) ledger.append(event);
  return ledger.readVerified();
}
