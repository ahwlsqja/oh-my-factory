import type { LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { gate1ForItem } from "../decision/gate1-item.js";
import { syncNeedsHuman } from "../decision/needs-human.js";
import { gate2Gate } from "../scenario/gate2-gate.js";
import type { EvidenceInputs } from "./classify.js";
import { GATE_IDS, type GateId, ROUND_SCOPED_GATES } from "./line-types.js";
import type { WorkItem } from "./types.js";

export type GateVerdict = "pass" | "fail" | "not_run";
export type GateStatus = GateVerdict | "not_visited";

/** Where a GATE-2 fail sends the item instead of looping back to S2: J2 (a design question), J3 (the scenarios) or J7 (a person looks). */
export type GateStop = "J2" | "J3" | "J7";

/** `reasons` are closed codes matching /^[a-z0-9_]+$/; never text, never an error message. */
export interface GateResult {
  gate: GateId;
  verdict: GateVerdict;
  reasons: readonly string[];
  /** GATE-2 with verdict `fail` only: the line stops at this J act instead of returning to S2. */
  stop?: GateStop;
}

export interface GateAggregate {
  /** "pass" only when every required gate's status is "pass". */
  verdict: "pass" | "fail";
  per_gate: Record<GateId, GateStatus>;
  /** Every required gate whose status is not "pass". */
  failing: GateId[];
}

export const REQUIRED_GATES: readonly GateId[] = GATE_IDS;

const VERDICTS: readonly string[] = ["pass", "fail", "not_run"];
const REASON_CODE = /^[a-z0-9_]+$/;

/**
 * Pure (E7). A gate absent from `statuses` is "not_visited" and fails like `not_run`; an empty `required` list is a
 * fail too, so a caller that forgets to name the required gates never gets a vacuous pass.
 */
export function aggregateGates(
  statuses: Partial<Record<GateId, GateStatus>>,
  required: readonly GateId[] = REQUIRED_GATES,
): GateAggregate {
  const perGate = {} as Record<GateId, GateStatus>;
  for (const id of GATE_IDS) perGate[id] = statuses[id] ?? "not_visited";
  const failing = required.filter((id) => perGate[id] !== "pass");
  return { verdict: failing.length === 0 && required.length > 0 ? "pass" : "fail", per_gate: perGate, failing };
}

/** A result a gate returned that is not a verdict plus closed reason codes is a broken gate: it becomes not_run, never a pass. */
function wellFormed(result: GateResult): boolean {
  return (
    VERDICTS.includes(result.verdict) &&
    Array.isArray(result.reasons) &&
    result.reasons.every((reason) => typeof reason === "string" && REASON_CODE.test(reason))
  );
}

/**
 * The gate results of one run. The last result per gate wins for the aggregate; the history keeps every result so
 * evidence can show a GATE-2 fail followed by a pass.
 */
export class GateBoard {
  readonly #last = new Map<GateId, GateResult>();
  readonly #history: GateResult[] = [];

  record(result: GateResult): void {
    if (!(GATE_IDS as readonly string[]).includes(result.gate)) throw new TypeError("not a gate id");
    const stored: GateResult = wellFormed(result)
      ? { gate: result.gate, verdict: result.verdict, reasons: [...result.reasons] }
      : { gate: result.gate, verdict: "not_run", reasons: ["gate_error"] };
    this.#last.set(stored.gate, stored);
    this.#history.push(stored);
  }

  /** Opens a round: GATE-3 and GATE-4 go back to "not_visited" so a round-1 pass cannot satisfy round 2 (M3b2-D5). */
  startRound(): void {
    for (const gate of ROUND_SCOPED_GATES) this.#last.delete(gate);
  }

  status(gate: GateId): GateStatus {
    return this.#last.get(gate)?.verdict ?? "not_visited";
  }

  aggregate(required: readonly GateId[] = REQUIRED_GATES): GateAggregate {
    const statuses: Partial<Record<GateId, GateStatus>> = {};
    for (const id of GATE_IDS) statuses[id] = this.status(id);
    return aggregateGates(statuses, required);
  }

  history(): readonly GateResult[] {
    return this.#history.map((result) => ({ ...result, reasons: [...result.reasons] }));
  }
}

export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Read-only. The real GATE-2 (null implementation against the scenarios) and GATE-3 (canary, prove_test, judge
 * config, isolation) read what S2 to S5 wrote; they never write it.
 */
export interface GateContext {
  location: ProjectLocation;
  item: WorkItem;
  events: readonly LedgerEvent[];
  now: Date;
  runId: string;
  round: number;
  resumed: boolean;
  inputs: DeepReadonly<EvidenceInputs>;
}

/** May be async. The sequencer turns a throw or a rejection into `{ verdict: "not_run", reasons: ["gate_error"] }` and drops the message. */
export interface Gate {
  readonly id: Exclude<GateId, "GATE-4">;
  evaluate(ctx: GateContext): GateResult | Promise<GateResult>;
}

/**
 * GATE-1: evaluates `evaluateGate1` over the events in the context and syncs `needs-human.json` the way
 * `omf decide lint` does (persist-and-exit, M3-D7). pass -> pass; blocked_on_user -> fail ["j2_open"]; a throw (missing
 * goal lock, unreadable record) -> not_run ["gate_error"], never a pass. The sequencer calls it only for an item that
 * is still `ready` and records pass ["already_started"] itself for a resumed one (M3b2-D12).
 */
export function gate1(): Gate {
  return {
    id: "GATE-1",
    evaluate(ctx) {
      try {
        const { scope, result } = gate1ForItem(ctx.location, ctx.item, ctx.events, ctx.now);
        syncNeedsHuman(ctx.item.dir, scope, result, ctx.now);
        return result.status === "pass"
          ? { gate: "GATE-1", verdict: "pass", reasons: [] }
          : { gate: "GATE-1", verdict: "fail", reasons: ["j2_open"] };
      } catch {
        return { gate: "GATE-1", verdict: "not_run", reasons: ["gate_error"] };
      }
    },
  };
}

/** GATE-3 until M3f registers it: always not_run, so a default full run fails closed. */
export function unimplementedGate(id: "GATE-2" | "GATE-3"): Gate {
  return { id, evaluate: () => ({ gate: id, verdict: "not_run", reasons: ["not_implemented"] }) };
}

/** A fresh set on every call; the sequencer calls it once and compares the merged set against that same object. */
export function defaultGates(): Record<Exclude<GateId, "GATE-4">, Gate> {
  return { "GATE-1": gate1(), "GATE-2": gate2Gate(), "GATE-3": unimplementedGate("GATE-3") };
}

/** The gates that did not come from `defaults`, in line order; evidence lists them and a success is capped at human_needed (M3b2-D20). */
export function injectedGateIds(merged: Record<string, Gate>, defaults: Record<string, Gate>): GateId[] {
  return GATE_IDS.filter((id) => merged[id] !== defaults[id]);
}
