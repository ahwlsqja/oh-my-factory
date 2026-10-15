import { rmSync } from "node:fs";
import { join } from "node:path";
import type { StateStore } from "../adapters/state-markdown.js";
import { readConfig } from "../core/config.js";
import type { OmfConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { claimStatus } from "./claim.js";
import {
  type Classification,
  type EvidenceInputs,
  type LineStop,
  classifyOutcome,
  emptyEvidenceInputs,
  resetRoundScopedInputs,
  toOutcomeInput,
} from "./classify.js";
import {
  EVIDENCE_JSON,
  EVIDENCE_MD,
  type EvidenceDoc,
  type StageTime,
  buildEvidence,
  clearEvidence,
  evidenceDecisions,
  finalizeClassification,
  writeEvidence,
} from "./evidence.js";
import { type Gate4Result, type Gate4Warning, VisitCounter, evaluateGate4, gate4Result, roundSignature } from "./gate4.js";
import { type GateResult, type GateVerdict, type Gate, GateBoard, defaultGates, injectedGateIds } from "./gates.js";
import type { GovernanceCode } from "./governance.js";
import { type HandoffRecord, buildHandoff, handoffFile, markerToRan, owedPredecessors, writeHandoff } from "./handoff.js";
import {
  type GateId,
  LINE_ORDER,
  type NodeId,
  ROUND_SCOPED_STATIONS,
  STATION_IDS,
  type StationId,
  type StationStatus,
} from "./line-types.js";
import { type Disposition, OutcomeError, type WOutcome, dispositionOf } from "./outcome.js";
import type { WorkItem } from "./types.js";
import { type OwnedAppend, WorkBudgetError, foldReentry, foldWorkBudget, microUsd, recordLimits, recordRound, recordSpend } from "./w-budget.js";
import { type ReasonCode, W_REASON_CODES, lastStateEvent } from "./w-events.js";
import { type RecheckFailure, type WRun, beginRun } from "./w-run.js";
import { WError, type WErrorCode } from "./w-verbs.js";

/**
 * The station sequencer (spec §5.0, §4.4 step 5): an in-process state machine over S1..S7 and the gates
 * between them. It owns the order and nothing else. Stations and the gates after GATE-1 are injected, so
 * nothing here calls a model, starts a container or knows what a station does (M3b2).
 */

export type StationResult =
  | { kind: "ok"; progress_digest?: string }
  | { kind: "rework"; progress_digest?: string }
  | { kind: "skipped" }
  | { kind: "blocked"; reason_code: ReasonCode }
  | { kind: "manual"; reason_code: ReasonCode };

export interface StationContext {
  readonly runId: string;
  readonly workId: string;
  readonly goalId: string;
  /** 0 before S3 of the first round. */
  readonly round: number;
  /** The item was already in_progress at entry. */
  readonly resumed: boolean;
  /** A station that seals (M3c S2) must not re-seal after the fact when this is "in_progress" (spec 5.3). */
  readonly entryState: "ready" | "in_progress";
  readonly item: WorkItem;
  readonly now: () => Date;
  /** Stations write their outputs here; the round-scoped fields are reset when a round opens. */
  readonly inputs: EvidenceInputs;
  /** Appends work.spend under the claim; null = vendor cost unknown. */
  recordSpend(microUsd: number | null): void;
}

export interface Station {
  readonly id: StationId;
  run(ctx: StationContext): StationResult | Promise<StationResult>;
}

export interface LineOptions {
  location: ProjectLocation;
  workId: string;
  /** A missing station is "skipped", which a full line cannot pass. */
  stations: Partial<Record<StationId, Station>>;
  /**
   * Merged over defaultGates(); an absent key keeps the default. "GATE-1" is not accepted: a caller cannot
   * swap out the item's governance gate. A gate given here is recorded as injected in the evidence (M3b2-D20).
   */
  gates?: Partial<Record<"GATE-2" | "GATE-3", Gate>>;
  now?: () => Date;
  newRunId?: (at: Date) => string;
  store?: StateStore;
}

export type LineResult =
  | {
      kind: "finished";
      run_id: string;
      outcome: WOutcome;
      disposition: Disposition;
      reason_code: ReasonCode | null;
      evidence: EvidenceDoc;
      handoff: HandoffRecord | null;
    }
  | {
      kind: "aborted";
      run_id: string;
      reason: RecheckFailure | "run_error";
      code: GovernanceCode | null;
      wcode: WErrorCode | null;
      at: NodeId | "finish";
    };

type LineGates = Record<Exclude<GateId, "GATE-4">, Gate>;

/** No re-entry facts at a node: they are checked once, at line entry (Task 8). */
const NO_REENTRY = { same_reason: 0, kills: 0 } as const;
const NO_STALL = { current: null, rework: false } as const;
const REASON_SHAPE = /^[a-z0-9_]{1,40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** Thrown inside the line and caught in runLine: the run ends as `aborted`, with closed codes only. */
class RunAbort extends Error {
  constructor(
    readonly reason: RecheckFailure | "run_error",
    readonly code: GovernanceCode | null,
    readonly wcode: WErrorCode | null,
  ) {
    super(`run aborted: ${reason}`);
    this.name = "RunAbort";
  }
}

/** The one place a WError or an OutcomeError from the run object becomes a RunAbort. */
function guard<T>(act: () => T): T {
  try {
    return act();
  } catch (err) {
    if (err instanceof WError) throw new RunAbort("run_error", null, err.code);
    if (err instanceof OutcomeError) throw new RunAbort("run_error", null, "outcome_invalid");
    // The own-claim appends of Task 2 refuse with their own error; the code is all that leaves, never the message.
    if (err instanceof WorkBudgetError) throw new RunAbort("run_error", null, err.code === "claim_lost" ? "claim_lost" : "malformed");
    throw err;
  }
}

function isStation(node: NodeId): node is StationId {
  return (STATION_IDS as readonly string[]).includes(node);
}

function gateError(gate: GateId): GateResult {
  return { gate, verdict: "not_run", reasons: ["gate_error"] };
}

/**
 * A gate is code from outside. Anything but a result for this gate with a known verdict and closed-code
 * reasons is a gate error, so a free-text reason can never reach evidence, a handoff or the ledger.
 */
function checkedResult(id: Exclude<GateId, "GATE-4">, raw: unknown): GateResult {
  const r = raw as { gate?: unknown; verdict?: unknown; reasons?: unknown } | null;
  if (r === null || typeof r !== "object" || r.gate !== id) return gateError(id);
  const { verdict, reasons } = r;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "not_run") return gateError(id);
  if (!Array.isArray(reasons) || !reasons.every((x): x is string => typeof x === "string" && REASON_SHAPE.test(x))) return gateError(id);
  return { gate: id, verdict, reasons: [...reasons] };
}

type Reading =
  | { status: "ok" | "rework"; digest: string | null }
  | { status: "skipped" }
  | { status: "error" }
  | { status: "blocked" | "manual"; reason_code: ReasonCode };

/**
 * A station result as a closed status. `rework` is the one status that is not a stop, and only S6 may ask for it
 * (spec 5.0); from any other station, an unknown reason code, a digest that is not 64 hex, and a non-result are all
 * `error`. Nothing the station wrote is copied except a valid digest (M3b2-D19).
 */
function interpret(id: StationId, raw: unknown): Reading {
  const r = raw as { kind?: unknown; reason_code?: unknown; progress_digest?: unknown } | null;
  if (r === null || typeof r !== "object") return { status: "error" };
  const digest = r.progress_digest;
  if (digest !== undefined && !(typeof digest === "string" && DIGEST.test(digest))) return { status: "error" };
  const progress = typeof digest === "string" ? digest : null;
  if (r.kind === "ok") return { status: "ok", digest: progress };
  if (r.kind === "rework") return id === "S6" ? { status: "rework", digest: progress } : { status: "error" };
  if (r.kind === "skipped") return { status: "skipped" };
  if (
    (r.kind === "blocked" || r.kind === "manual") &&
    typeof r.reason_code === "string" &&
    (W_REASON_CODES as readonly string[]).includes(r.reason_code)
  ) {
    return { status: r.kind, reason_code: r.reason_code as ReasonCode };
  }
  return { status: "error" };
}

/** M3b2-D10: a handoff for every stop that needs a person (blocked, manual) and for a failed item. */
function needsPerson(c: Classification, d: Disposition): boolean {
  return c.outcome === "blocked" || c.outcome === "manual" || d.action === "fail";
}

/**
 * Takes back what THIS run wrote, and nothing else. The handoff file name carries the run id, so it is always ours.
 * The evidence pair has a fixed name, so it is removed only when this run wrote it (`wroteEvidence`) and the abort is
 * not a lost claim: after a lost claim another run may own the item, and its evidence or its temp files in flight
 * must stay. Temp files are never swept here (`clearEvidence` at line entry does that, while the claim is ours).
 */
function removeOwnFiles(itemDir: string, runId: string, evidence: boolean): void {
  if (evidence) {
    rmSync(join(itemDir, EVIDENCE_JSON), { force: true });
    rmSync(join(itemDir, EVIDENCE_MD), { force: true });
  }
  rmSync(handoffFile(itemDir, runId, "outcome"), { force: true });
}

/**
 * The handoff's `ran`: the LAST result of each visited node, in LINE_ORDER. `this.ran` holds one entry per visit
 * (rounds and the GATE-2 loop revisit nodes), which can be far more than the 11 nodes the schema allows; the schema
 * cap stays tied to the node list, not to the visit cap.
 */
function stopNode(stop: LineStop): NodeId | null {
  switch (stop.kind) {
    case "station":
      return stop.station;
    case "gate":
      return stop.gate;
    case "gate4":
      return "GATE-4";
    default:
      return null;
  }
}

function lastPerNode(entries: readonly { node: NodeId; result: string }[]): { node: NodeId; result: string }[] {
  const last = new Map<NodeId, string>();
  for (const entry of entries) last.set(entry.node, entry.result);
  return LINE_ORDER.filter((node) => last.has(node)).map((node) => ({ node, result: last.get(node) as string }));
}

interface LineEnv {
  run: WRun;
  options: LineOptions;
  gates: LineGates;
  injected: GateId[];
  ledger: Ledger;
  itemDir: string;
  own: OwnedAppend;
  config: OmfConfig;
  now: () => Date;
}

class Line {
  readonly inputs: EvidenceInputs = emptyEvidenceInputs();
  readonly board = new GateBoard();
  readonly visits = new VisitCounter();
  readonly stations = Object.fromEntries(STATION_IDS.map((id) => [id, "not_run"])) as Record<StationId, StationStatus>;
  /** The node being worked on, for `aborted`. */
  at: NodeId | "finish" = "S1";
  private readonly ran: { node: NodeId; result: string }[] = [];
  /** True once `writeEvidence` returned for this run: only then may an abort remove `evidence.json` and `evidence.md`. */
  wroteEvidence = false;
  private readonly times: Partial<Record<NodeId, StageTime>> = {};
  private readonly warnings = new Set<Gate4Warning>();
  private stop: LineStop = { kind: "none" };
  /** The round's `[node, status, digest]` list; its hash is the stall signature (M3b2-D7). Emptied when a round opens. */
  private readonly trail: { node: NodeId; status: StationStatus | GateVerdict; digest: string | null }[] = [];
  /** The signature of the round that just ended in a rework request; the next `work.round` carries it. */
  private lastSignature: string | null = null;
  private reworkAsked = false;
  /** Set when `ctx.recordSpend` aborted the run; raised after the station returns, so a station cannot swallow it. */
  private spendAbort: RunAbort | null = null;

  constructor(
    private readonly env: LineEnv,
    private item: WorkItem,
  ) {}

  /** Visits LINE_ORDER once. A recheck before every node: a veto, a lost claim or a drifted config ends the run. */
  async walk(): Promise<void> {
    if (!this.guardEntry()) return;
    let index = 0;
    while (index < LINE_ORDER.length && this.stop.kind === "none") {
      const node = LINE_ORDER[index];
      if (node === undefined) break;
      this.at = node;
      const checked = this.env.run.recheck();
      if (!checked.ok) throw new RunAbort(checked.reason, checked.code, null);
      this.item = checked.item;
      index = await this.visit(node, index);
    }
  }

  /**
   * Line entry, before S1 (M3b2-D17): may one more round start? Rounds, spend, ledger anomalies and the re-entry
   * facts (the same park reason three times, or three killed runs, since the last person's act). A fail is put on
   * the board and ends the line here, before any station runs, so a repeating blocker costs nothing to repeat.
   * Every count is read from the ledger as it is now, so a restart cannot reset it (M3b2-D3). Returns whether the line goes on.
   */
  private guardEntry(): boolean {
    const events = this.env.ledger.readVerified();
    const { run } = this.env;
    return this.settle(
      evaluateGate4({
        budget: foldWorkBudget(events, run.workId),
        visits: { in_round: 0, total: 0, entering: null },
        next_round_wanted: true,
        stall: NO_STALL,
        reentry: foldReentry(events, run.goalId, run.workId),
      }),
      "fail",
    );
  }

  private budget() {
    return foldWorkBudget(this.env.ledger.readVerified(), this.env.run.workId);
  }

  /** Returns the index of the next node. A node that stopped the line returns its own index and sets `stop`. */
  private async visit(node: NodeId, index: number): Promise<number> {
    if (node === "S3" && !this.opensRound()) return index;
    const counts = this.visits.enter(node);
    if (node === "GATE-4") return this.afterS6(counts) ? LINE_ORDER.indexOf("S3") : index + 1;
    // Gates count as visits: the same GATE-4 rule that caps stations caps the S2/GATE-2 loop (M3b2-D6).
    const guarded = evaluateGate4({
      budget: this.budget(),
      visits: { ...counts, entering: node },
      next_round_wanted: false,
      stall: NO_STALL,
      reentry: NO_REENTRY,
    });
    if (!this.settle(guarded, "fail")) return index;
    if (isStation(node)) {
      await this.runStation(node);
      return index + 1;
    }
    return this.runGate(node, index);
  }

  /**
   * Takes a GATE-4 answer. Warnings are kept. A fail goes on the board and stops the line; a pass goes on the
   * board only when `record` is "always", which only the check after S6 asks for. Returns whether the line goes on.
   */
  private settle(result: Gate4Result, record: "fail" | "always"): boolean {
    for (const warning of result.warnings) this.warnings.add(warning);
    if (result.verdict === "pass") {
      if (record === "always") this.board.record(gate4Result(result));
      return true;
    }
    this.board.record(gate4Result(result));
    // A fail with severity "none" cannot happen; reading it as an integrity fail keeps the line closed if it ever does.
    const severity = result.severity === "none" ? "integrity" : result.severity;
    this.stop = { kind: "gate4", severity, reasons: result.reasons, round: this.visits.round };
    return false;
  }

  /**
   * S3 entry (skeleton 4.8 step 7): GATE-4 with a next round wanted (rounds, spend, ledger anomalies), then
   * one step that opens the round. `work.round` is appended before `work.started` and before the work, like
   * budget.consumed (M3b2-D3). Everything round-scoped goes back to "not run" in the same step (M3b2-D5).
   */
  private opensRound(): boolean {
    const answer = evaluateGate4({
      budget: this.budget(),
      visits: { in_round: 0, total: 0, entering: null },
      next_round_wanted: true,
      stall: NO_STALL,
      reentry: NO_REENTRY,
    });
    if (!this.settle(answer, "fail")) return false;
    guard(() => recordRound(this.env.own, this.lastSignature));
    if (!this.env.run.resumed) guard(() => this.env.run.start());
    this.visits.startRound();
    this.board.startRound();
    for (const id of ROUND_SCOPED_STATIONS) this.stations[id] = "not_run";
    resetRoundScopedInputs(this.inputs);
    this.trail.length = 0;
    this.reworkAsked = false;
    return true;
  }

  /**
   * The GATE-4 node: the one check that goes on the board whatever it says. A rework request asks for another
   * round, so rounds and spend are checked as for a round that would start, and a round whose signature equals the
   * one recorded when it opened (the previous round's) is a stall (M3b2-D7). Returns whether the walk goes back to S3.
   */
  private afterS6(counts: { in_round: number; total: number }): boolean {
    const started = this.now();
    const current = roundSignature(this.trail);
    const answer = evaluateGate4({
      budget: this.budget(),
      visits: { ...counts, entering: "GATE-4" },
      next_round_wanted: this.reworkAsked,
      stall: { current, rework: this.reworkAsked },
      reentry: NO_REENTRY,
    });
    this.clock("GATE-4", started);
    this.ran.push({ node: "GATE-4", result: answer.verdict });
    if (!this.settle(answer, "always") || !this.reworkAsked) return false;
    this.lastSignature = current;
    return true;
  }

  private async runStation(id: StationId): Promise<void> {
    const round = this.visits.round;
    // The store accepts a progress marker only for an in_progress item, which is true from the round open on.
    if (round >= 1) guard(() => this.env.run.progress({ station: id, step: "entered" }));
    const station = this.env.options.stations[id];
    const started = this.now();
    let reading: Reading;
    if (station === undefined) {
      reading = { status: "skipped" };
    } else {
      try {
        reading = interpret(id, await station.run(this.stationContext(id)));
      } catch (err) {
        if (err instanceof RunAbort) throw err;
        reading = { status: "error" }; // the message is dropped: it may hold anything
      }
    }
    if (this.spendAbort !== null) throw this.spendAbort;
    this.clock(id, started);
    this.stations[id] = reading.status;
    this.ran.push({ node: id, result: reading.status });
    this.trail.push({ node: id, status: reading.status, digest: "digest" in reading ? reading.digest : null });
    if (id === "S6") this.reworkAsked = reading.status === "rework";
    if (reading.status === "ok" || reading.status === "rework") {
      if (round >= 1) guard(() => this.env.run.progress({ station: id, step: "handed_off" }));
      return;
    }
    if (reading.status === "skipped") return;
    const reason = "reason_code" in reading ? reading.reason_code : "station_error";
    this.stop = { kind: "station", station: id, result: reading.status, reason_code: reason };
  }

  private stationContext(id: StationId): StationContext {
    const { run } = this.env;
    return {
      runId: run.runId,
      workId: run.workId,
      goalId: run.goalId,
      round: this.visits.round,
      resumed: run.resumed,
      entryState: run.resumed ? "in_progress" : "ready",
      item: this.item,
      now: this.env.now,
      inputs: this.inputs,
      recordSpend: (micro) => {
        try {
          guard(() => recordSpend(this.env.own, id, micro));
        } catch (err) {
          if (err instanceof RunAbort) this.spendAbort ??= err;
          throw err;
        }
      },
    };
  }

  private async runGate(id: Exclude<GateId, "GATE-4">, index: number): Promise<number> {
    const started = this.now();
    // GATE-1 ran before start() (M3b2-D12). An item that is already in_progress was past it, and `decide`
    // refuses it, so a time-based failure now would park an item with no way out but veto or cancel.
    const result: GateResult =
      id === "GATE-1" && this.env.run.resumed
        ? { gate: id, verdict: "pass", reasons: ["already_started"] }
        : await this.evaluate(id);
    this.clock(id, started);
    this.board.record(result);
    this.trail.push({ node: id, status: result.verdict, digest: null });
    this.ran.push({ node: id, result: result.verdict });
    if (result.verdict === "pass") return index + 1;
    // GATE-2 fail goes back to S2; the visit guard in `visit` bounds the loop. Anything else stops the line.
    if (id === "GATE-2" && result.verdict === "fail") return LINE_ORDER.indexOf("S2");
    this.stop = { kind: "gate", gate: id, verdict: result.verdict, reasons: result.reasons };
    return index;
  }

  private async evaluate(id: Exclude<GateId, "GATE-4">): Promise<GateResult> {
    try {
      const raw = await this.env.gates[id].evaluate({
        location: this.env.options.location,
        item: this.item,
        events: this.env.ledger.readVerified(),
        now: this.now(),
        runId: this.env.run.runId,
        round: this.visits.round,
        resumed: this.env.run.resumed,
        inputs: this.inputs,
      });
      return checkedResult(id, raw);
    } catch {
      return gateError(id);
    }
  }

  private now(): Date {
    return this.env.now();
  }

  private clock(node: NodeId, started: Date): void {
    const time = (this.times[node] ??= { visits: 0, total_ms: 0 });
    time.visits += 1;
    // A wall clock that steps back must not make a negative time: the schema refuses it and the line would throw.
    time.total_ms += Math.max(0, this.now().getTime() - started.getTime());
  }

  /**
   * Classify, write the evidence, write the handoff if a person is needed, then finish (skeleton 4.8 step 8).
   * Files come first: a crash before `finish` leaves a file with no finishing event of this run id, which
   * `trustedRecommendation` reads as absent (M3b2-D8). Any throw from here (a WError, a ledger or evidence error)
   * becomes `aborted` `run_error` in runLine, which removes this run's own files.
   */
  finalize(): LineResult {
    this.at = "finish";
    const { run, ledger, itemDir, own, injected } = this.env;
    const events = ledger.readVerified();
    const decisions = evidenceDecisions(this.env.options.location, this.item, events);
    const classified = classifyOutcome({
      stop: this.stop,
      stations: this.stations,
      gates: this.board.aggregate(),
      inputs: this.inputs,
      decisions_unmeasured: decisions.list.map((decision) => decision.id),
      gate4_warnings: [...this.warnings],
      injected_gates: injected,
      declared_level: this.env.config.isolation.declared,
    });
    const budget = foldWorkBudget(events, own.scope.work_id);
    // Evidence-level areas and the recommendation, once, so the ledger event and the file state the same thing.
    const classification = finalizeClassification({ classification: classified, decisions, injected_gates: injected, budget, inputs: this.inputs });
    const input = toOutcomeInput(classification);
    const disposition = guard(() => dispositionOf(input));

    const evidence = buildEvidence({
      scope: own.scope,
      classification,
      stations: this.stations,
      gates: this.board,
      inputs: this.inputs,
      decisions,
      injected_gates: injected,
      stage_times: this.times,
      budget,
      now: this.now(),
    });
    writeEvidence(itemDir, evidence);
    this.wroteEvidence = true;

    let handoff: HandoffRecord | null = null;
    if (needsPerson(classification, disposition)) {
      // One entry per node, not per visit: a stall in round 2 has 16 visits and the schema allows 11 entries.
      const ran = lastPerNode(this.ran);
      const visited = new Set(ran.map((entry) => entry.node));
      // The node that stopped the line is still to be resolved by a person, so it leads `remaining`
      // (consistent with killed_predecessor, which includes the node the dead run reached).
      const stopped = stopNode(this.stop);
      handoff = buildHandoff({
        kind: "outcome",
        predecessor_seq: null,
        scope: own.scope,
        classification,
        ran,
        remaining: LINE_ORDER.filter((node) => node === stopped || !visited.has(node)),
        now: this.now(),
      });
      writeHandoff(itemDir, handoff);
    }

    const done = guard(() => run.finish(input));
    if (!done.applied) throw new RunAbort(done.reason, done.code, null);
    return {
      kind: "finished",
      run_id: run.runId,
      outcome: classification.outcome,
      disposition: done.disposition,
      reason_code: classification.reason_code,
      evidence,
      handoff,
    };
  }
}

/**
 * Throws what beginRun throws before a run exists: a WError (claim_held, wrong_state, needs_human, governance,
 * malformed; a ledger already corrupt at entry is `governance`) or, rarely, another error from its own reads and
 * writes (a LedgerCorruptError if the chain breaks between its governance read and its sweep, w-run.ts repairGoal);
 * and TypeError for a GATE-1 key. After beginRun every end is a LineResult: a station or gate exception is a
 * station error or gate_error; a veto, a lost claim, a drifted config, or any WError from the run object
 * removes this run's evidence and handoff and returns `aborted` (M3b2-D11). Any other exception after beginRun
 * (a ledger or evidence error, a clock fault) is also `aborted` `run_error` with no code: the run object is
 * never left holding files with no LineResult (skeleton 4.8).
 */
export async function runLine(options: LineOptions): Promise<LineResult> {
  const defaults = defaultGates();
  const gates: LineGates = { ...defaults };
  if (options.gates !== undefined) {
    if (Object.keys(options.gates).includes("GATE-1")) throw new TypeError("GATE-1 cannot be replaced: it is the item's governance gate");
    for (const id of ["GATE-2", "GATE-3"] as const) {
      const given = options.gates[id];
      if (given !== undefined) gates[id] = given;
    }
  }
  const injected = injectedGateIds(gates, defaults);
  const now = options.now ?? ((): Date => new Date());
  const run = beginRun({ location: options.location, workId: options.workId, now, newRunId: options.newRunId, store: options.store });

  let itemDir = null as string | null;
  let line = undefined as Line | undefined;
  try {
    // First: a config edit made after beginRun's baseline must not be copied into the ledger as the limit.
    const entry = run.recheck();
    if (!entry.ok) throw new RunAbort(entry.reason, entry.code, null);
    itemDir = entry.item.dir;
    // Read with the recheck, before clearEvidence and the ledger read: the limits written below are the ones it validated.
    const config = readConfig(options.location.dir);
    const owner = claimStatus(itemDir).owner;
    if (owner === null || owner.pid !== process.pid) throw new RunAbort("claim_lost", null, null);

    const ledger = new Ledger(options.location.dir, now);
    const own: OwnedAppend = { ledger, itemDir, claim: owner, scope: { goal_id: run.goalId, work_id: run.workId, run_id: run.runId } };
    clearEvidence(itemDir); // a killed run leaves none, and a stale file is never current

    // A killed run leaves no result, so the ledger is asked who died (M3b2-D21): a work.claim_reclaimed after the
    // item's last state event that no handoffs/*.predecessor.json covers. That also finds a reclaim `repairGoal`
    // did while another item was entered, where `run.reclaimed` is null here. One record covers every owed reclaim
    // (its seq is the newest). It sits after the entry recheck: a run that aborts there leaves the debt owed for the
    // next entry instead of writing a record for an item nobody may run.
    const history = ledger.readVerified();
    const owed = owedPredecessors(itemDir, history, run.workId).at(-1);
    if (owed !== undefined) {
      // The progress marker is the killed run's only while the last state event is the item's start. After a park it
      // belongs to the run that parked, and a killed run that never reached S3 wrote none.
      const lastState = lastStateEvent(history, run.workId);
      const reached = run.resumed && lastState?.event.type === "work.started" ? markerToRan(entry.item.progress) : [];
      writeHandoff(
        itemDir,
        buildHandoff({
          kind: "killed_predecessor",
          scope: own.scope,
          predecessor_seq: owed.seq,
          classification: { outcome: "blocked", reason_code: "run_killed", unverified_areas: [] },
          ran: reached,
          remaining: LINE_ORDER.slice(LINE_ORDER.indexOf(reached[0]?.node ?? "S1")),
          now: now(),
        }),
      );
    }
    guard(() => recordLimits(own, { max_rounds: config.w.max_rounds, max_model_micro_usd: microUsd(config.w.max_model_usd) }));

    line = new Line({ run, options, gates, injected, ledger, itemDir, own, config, now }, entry.item);
    await line.walk();
    return line.finalize();
  } catch (caught) {
    const err = caught instanceof RunAbort ? caught : new RunAbort("run_error", null, null);
    const lost = err.reason === "claim_lost" || err.wcode === "claim_lost";
    if (itemDir !== null) removeOwnFiles(itemDir, run.runId, line?.wroteEvidence === true && !lost);
    return { kind: "aborted", run_id: run.runId, reason: err.reason, code: err.code, wcode: err.wcode, at: line?.at ?? "S1" };
  } finally {
    run.abandon();
  }
}
