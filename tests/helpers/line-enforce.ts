import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { ProjectLocation } from "../../src/core/paths.js";
import { type ClassifierInput, type EvidenceInputs } from "../../src/work/classify.js";
import { type Gate, aggregateGates } from "../../src/work/gates.js";
import { STATION_IDS, type StationId, type StationStatus } from "../../src/work/line-types.js";
import {
  type LineOptions,
  type LineResult,
  type Station,
  type StationContext,
  type StationResult,
  runLine,
} from "../../src/work/sequencer.js";
import type { WorkState } from "../../src/work/types.js";
import { type DecisionFixture, closeInterface, setupDecisionItem } from "./decision-fixture.js";

/** A station body. The helper wraps it so the test can see which stations ran, in order. */
export type Script = (ctx: StationContext) => StationResult | Promise<StationResult>;

/** Every input a real S2 to S5 will produce, filled with a clean value. A line that stops here is a success. */
export function cleanInputs(): EvidenceInputs {
  return {
    audit: { canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false },
    sealed: { train: { pass: 5, total: 5, flaky: 0 }, test: { pass: 3, total: 3 } },
    isolation_level: "L2",
    high_risk_paths_touched: [],
    noise_check: "ok",
    gate_line: "OMF_GATES fast=pass full=pass",
    plan_summary: "A plan.",
    implementer_notes: "Notes.",
  };
}

export function okStatuses(): Record<StationId, StationStatus> {
  return Object.fromEntries(STATION_IDS.map((id) => [id, "ok"])) as Record<StationId, StationStatus>;
}

/** A clean, complete classifier input; tests overwrite the one thing they probe. */
export function classifierInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    stop: { kind: "none" },
    stations: okStatuses(),
    gates: aggregateGates({ "GATE-1": "pass", "GATE-2": "pass", "GATE-3": "pass", "GATE-4": "pass" }),
    inputs: cleanInputs(),
    decisions_unmeasured: [],
    gate4_warnings: [],
    injected_gates: [],
    declared_level: "L2",
    ...overrides,
  };
}

export function passGate(id: "GATE-2" | "GATE-3"): Gate {
  return { id, evaluate: () => ({ gate: id, verdict: "pass", reasons: [] }) };
}

/** Stand-ins for the real GATE-2 and GATE-3 (M3c, M3e). They are injected, so a success stays human_needed. */
export function injectedGates(): NonNullable<LineOptions["gates"]> {
  return { "GATE-2": passGate("GATE-2"), "GATE-3": passGate("GATE-3") };
}

/** S5 stands in for the stations that will fill the inputs: every other station is plainly ok. */
export function cleanScripts(): Partial<Record<StationId, Script>> {
  return {
    S5: (ctx) => {
      Object.assign(ctx.inputs, cleanInputs());
      return { kind: "ok" };
    },
  };
}

export function finished(result: LineResult): Extract<LineResult, { kind: "finished" }> {
  if (result.kind !== "finished") throw new Error(`expected a finished run, got ${JSON.stringify(result)}`);
  return result;
}

export interface ExecOptions {
  /** Replaces the body of single stations; the rest keep `cleanScripts()` or plain ok. */
  scripts?: Partial<Record<StationId, Script>>;
  gates?: LineOptions["gates"];
  /** Stations left out of the map entirely. */
  omit?: StationId[];
}

export interface LineFx {
  f: DecisionFixture;
  workId: string;
  location: ProjectLocation;
  itemDir: string;
  events: () => LedgerEvent[];
  /** The work.* event types of this item, in ledger order. */
  types: () => string[];
  /** The `round` of every work.round event of this item. */
  rounds: () => unknown[];
  state: () => WorkState;
  /** One `runLine` with scripted stations; `ran` lists the stations whose body started, in order. */
  exec: (options?: ExecOptions) => Promise<{ result: LineResult; ran: StationId[] }>;
}

/** Replaces the [w] table of a config text, whatever `omf init` wrote there. */
function withWLimits(text: string, rounds: number, usd: number): string {
  const kept: string[] = [];
  let inW = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) inW = line.trim() === "[w]";
    if (!inW) kept.push(line);
  }
  return `${kept.join("\n").trimEnd()}\n\n[w]\nmax_rounds = ${rounds}\nmax_model_usd = ${usd}\n`;
}

/**
 * The canary goal with one `ready` item whose only decision (interface) is closed by a person, so the real
 * GATE-1 passes. Defaults match config: 3 rounds, 5 USD.
 */
export function setupLine(limits: { maxRounds?: number; maxUsd?: number } = {}): LineFx {
  const f = setupDecisionItem();
  closeInterface(f);
  const { location } = f.fx;
  writeFileSync(join(location.dir, "config.toml"), withWLimits(f.fx.baseConfig, limits.maxRounds ?? 3, limits.maxUsd ?? 5));
  const workId = f.workId;
  const events = (): LedgerEvent[] => f.fx.ledger.readVerified();
  const mine = (): LedgerEvent[] => events().filter((e) => e.type.startsWith("work.") && e.payload.work_id === workId);
  return {
    f,
    workId,
    location,
    itemDir: f.item.dir,
    events,
    types: () => mine().map((e) => e.type),
    rounds: () => mine().filter((e) => e.type === "work.round").map((e) => e.payload.round),
    state: () => {
      const item = createMarkdownStore(location.dir).fetchWorkItemsByIds([workId])[0];
      if (item === undefined) throw new Error("the item vanished");
      return item.front.state;
    },
    exec: async (options = {}) => {
      const ran: StationId[] = [];
      const scripts = { ...cleanScripts(), ...options.scripts };
      const stations: Partial<Record<StationId, Station>> = {};
      for (const id of STATION_IDS) {
        if (options.omit?.includes(id) === true) continue;
        stations[id] = {
          id,
          run: (ctx) => {
            ran.push(id);
            return scripts[id]?.(ctx) ?? { kind: "ok" };
          },
        };
      }
      const result = await runLine({
        location,
        workId,
        stations,
        ...(options.gates === undefined ? {} : { gates: options.gates }),
      });
      return { result, ran };
    },
  };
}
