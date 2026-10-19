import { canonicalize, sha256Hex } from "../core/canonical-json.js";

/**
 * Design decision model (spec §4.6, §5.2, §6.2). A decision is a chain of `decision.*` ledger events folded
 * into one record; these are the shapes of the events' inputs and of the folded result. The matching JSON
 * Schema is schemas/decision.schema.json.
 */

export const DECISION_CLASSES = [
  "interface",
  "compatibility",
  "latency",
  "throughput",
  "memory",
  "durability",
  "queue_bound",
  "data_model",
  "error_semantics",
  "security",
  "other",
] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

/**
 * Classes that need a numeric response_measure when resolved (spec §5.2). Not linkable to CLI scenarios in v0.1. The spec does not list the set: this list is a choice made here, and `durability` is the contestable member.
 */
export const QUANTITATIVE_CLASSES: readonly DecisionClass[] = [
  "latency",
  "throughput",
  "memory",
  "durability",
  "queue_bound",
];

export function isQuantitative(cls: DecisionClass): boolean {
  return QUANTITATIVE_CLASSES.includes(cls);
}

export const DECISION_ID_PATTERN = /^d-[a-z0-9]+(-[a-z0-9]+)*$/;
/** The only id with class "interface"; at most one per work item. */
export const INTERFACE_DECISION_ID = "d-interface";
/** d-intent-q1, d-intent-q2 ... one per open question of the intent, so F8 does not depend on someone adding them. */
export const INTENT_QUESTION_ID_PREFIX = "d-intent-q";

export type DecisionStatus = "open" | "resolved" | "deferred" | "na";

export interface Qas {
  source: string;
  stimulus: string;
  environment: string;
  artifact: string;
  response: string;
}

export type MeasureOp = "<" | "<=" | ">" | ">=" | "==";
export interface ResponseMeasure {
  metric: string;
  op: MeasureOp;
  threshold: number;
  unit: string;
  percentile: number | null;
  window: string | null;
}

/** In the order a person reads them, and the order the judge-config digest uses. */
export const GATE_NAMES = ["fast", "full", "deep"] as const;
export type GateName = (typeof GATE_NAMES)[number];

/**
 * Argv arrays, never shell strings (no injection ambiguity). Stored in the ledger by a human-signed resolution and
 * run as declared; never read from package.json or a Makefile, which a candidate can edit.
 */
export interface InterfaceContract {
  kind: "cli" | "http"; // http is parsed; scenarios for it are refused for now
  build: string[];
  run: string[];
  io_contract: string;
  gates: { fast: string[] | null; full: string[] | null; deep: string[] | null; required: GateName[] };
  test_command: string[]; // what prove-test runs
}

/**
 * "Judge config" as defined here: the gate definitions and test_command. The audit adds the files these resolve to at the
 * base sha (src/audit/judge-files.ts); the harness image digest is not part of this value: the judge events pin it per run (src/judge/events.ts).
 */
export interface JudgeConfigDecl {
  gates: InterfaceContract["gates"];
  test_command: string[];
}

/**
 * Copies out the judge-config fields. `required` is put in gate order so that listing the same gates differently
 * does not change the digest; `build`, `run`, `kind` and `io_contract` are deliberately not part of it.
 */
export function judgeConfigDecl(contract: InterfaceContract): JudgeConfigDecl {
  const { gates } = contract;
  return {
    gates: {
      fast: gates.fast === null ? null : [...gates.fast],
      full: gates.full === null ? null : [...gates.full],
      deep: gates.deep === null ? null : [...gates.deep],
      required: GATE_NAMES.filter((name) => gates.required.includes(name)),
    },
    test_command: [...contract.test_command],
  };
}

/** sha256Hex(canonicalize(judgeConfigDecl(c))): stable across key order, changes with any gate or test_command edit. */
export function judgeConfigSha256(contract: InterfaceContract): string {
  return sha256Hex(canonicalize(judgeConfigDecl(contract)));
}

export interface Resolution {
  choice: string;
  rationale: string;
  rejected: string[];
  by: string;
  at: string;
}
export interface Deferral {
  owner: string;
  reason: string;
  revisit_trigger: string;
  default: string;
  signed_by: string;
  expires_at: string;
}

export interface DecisionScope {
  goal_id: string;
  work_id: string;
}

/** Inputs of the write verbs: what a person or agent supplies. OMF fills by, at and signed_by. */
export interface AddInput {
  id: string;
  class: DecisionClass;
  question: string;
  qas?: Qas;
  response_measure?: ResponseMeasure;
}
export interface ResolveInput {
  choice: string;
  rationale: string;
  rejected?: string[];
  response_measure?: ResponseMeasure;
  interface?: InterfaceContract;
}
export interface DeferInput {
  owner: string;
  reason: string;
  revisit_trigger: string;
  default: string;
  expires_at: string;
}
export interface NaInput {
  rationale: string;
}

export interface DecisionRecord {
  id: string;
  class: DecisionClass;
  question: string;
  qas: Qas | null;
  response_measure: ResponseMeasure | null;
  status: DecisionStatus;
  resolution: Resolution | null;
  deferral: Deferral | null;
  interface: InterfaceContract | null;
  na: { rationale: string; by: string; at: string } | null;
  added_by: string;
  added_seq: number;
  closed_seq: number | null;
  /** Seq of the event that wrote `response_measure` (the add, or the resolve that supplied it); null when there is none. */
  measure_seq: number | null;
}

export type AnomalyCode =
  | "malformed_event"
  | "duplicate_add"
  | "unknown_decision"
  | "already_closed"
  | "resolution_not_human"
  | "deferral_unsigned"
  | "na_not_human"
  | "interface_misplaced";
export interface Anomaly {
  code: AnomalyCode;
  decision_id: string | null;
  seq: number;
}

export interface DecisionState {
  scope: DecisionScope;
  decisions: DecisionRecord[]; // ordered by added_seq
  anomalies: Anomaly[];
}
