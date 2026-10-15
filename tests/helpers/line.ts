import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { EvidenceInputs } from "../../src/work/classify.js";
import type { Gate, GateVerdict } from "../../src/work/gates.js";
import { type GateId, STATION_IDS, type StationId } from "../../src/work/line-types.js";
import type { LineOptions, LineResult, Station, StationContext, StationResult } from "../../src/work/sequencer.js";
import type { WorkItem, WorkState } from "../../src/work/types.js";
import { type DecisionFixture, closeInterface, setupDecisionItem } from "./decision-fixture.js";
import { type FakeClock, fakeClock } from "./tick.js";

/** Text no real id, code or path contains; tests plant it in errors and reasons and search every file for it. */
export const PLANTED = "planted-canary-7731";

/**
 * What a clean round leaves in the inputs (M3b2-D9): each station writes only its own share. Without `id` every
 * share is written at once, for a test that lets one station stand in for the whole round.
 */
export function fillClean(inputs: EvidenceInputs, id?: StationId): void {
  if (id === undefined || id === "S3") {
    inputs.plan_summary = "Plan: reuse the layout already computed.";
    inputs.implementer_notes = "Implemented as planned.";
  }
  if (id === undefined || id === "S4") {
    inputs.sealed = { train: { pass: 3, total: 3, flaky: 0 }, test: { pass: 2, total: 2 } };
  }
  if (id === undefined || id === "S5") {
    inputs.audit = { canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false };
    inputs.isolation_level = "L2";
    inputs.high_risk_paths_touched = [];
    inputs.gate_line = "OMF_GATES fast=pass";
    inputs.gate_verdict = "GREEN";
  }
  if (id === undefined || id === "S6") {
    inputs.noise_check = "ok";
  }
}

/** A station that fills its clean share of the inputs, then does `run` (default: returns ok). */
export function station(
  id: StationId,
  run: (ctx: StationContext) => StationResult | Promise<StationResult> = () => ({ kind: "ok" }),
): Station {
  return {
    id,
    run: (ctx) => {
      fillClean(ctx.inputs, id);
      return run(ctx);
    },
  };
}

/** All seven stations, clean. `override` replaces some, `omit` leaves some out, `trace` collects the ids in the order they ran. */
export function cleanStations(
  options: { override?: Partial<Record<StationId, Station>>; omit?: readonly StationId[]; trace?: string[] } = {},
): Partial<Record<StationId, Station>> {
  const stations: Partial<Record<StationId, Station>> = {};
  for (const id of STATION_IDS) {
    if (options.omit?.includes(id)) continue;
    const given = options.override?.[id];
    stations[id] =
      given ??
      station(id, () => {
        options.trace?.push(id);
        return { kind: "ok" };
      });
  }
  return stations;
}

/** The result of a station that did its work and has nothing to add. */
export const OK: StationResult = { kind: "ok" };
export type StationBody = (ctx: StationContext) => StationResult | Promise<StationResult>;

/**
 * All seven stations, scripted: each logs its id when it is entered and then runs its body from `bodies` (default:
 * returns ok and writes nothing, so the inputs stay "not run" unless a body calls `fillClean`). Tasks 8 and 9 use it.
 */
export function stationsOf(
  log: string[],
  bodies: Partial<Record<StationId, StationBody>> = {},
): Partial<Record<StationId, Station>> {
  const stations: Partial<Record<StationId, Station>> = {};
  for (const id of STATION_IDS) {
    stations[id] = {
      id,
      run: (ctx) => {
        log.push(id);
        return (bodies[id] ?? (() => OK))(ctx);
      },
    };
  }
  return stations;
}

/** A GATE-2 or GATE-3 that logs its id and answers `verdict` (default pass) with closed `reasons`. */
export function fakeGate(
  id: "GATE-2" | "GATE-3",
  options: { log?: string[]; verdict?: GateVerdict; reasons?: string[] } = {},
): Gate {
  return {
    id,
    evaluate: () => {
      options.log?.push(id);
      return { gate: id, verdict: options.verdict ?? "pass", reasons: options.reasons ?? [] };
    },
  };
}

export function passGate(id: Exclude<GateId, "GATE-4">, trace?: string[]): Gate {
  return {
    id,
    evaluate: () => {
      trace?.push(id);
      return { gate: id, verdict: "pass", reasons: [] };
    },
  };
}

export function passGates(trace?: string[]): Record<"GATE-2" | "GATE-3", Gate> {
  return { "GATE-2": passGate("GATE-2", trace), "GATE-3": passGate("GATE-3", trace) };
}

export interface LineFixture {
  f: DecisionFixture;
  /** `f.fx`: the project, ledger and goal the item lives in. */
  fx: DecisionFixture["fx"];
  clock: FakeClock;
  workId: string;
  itemDir: string;
  /** Options for `runLine`: this item, the fake clock, clean stations. A test adds `gates` (the defaults fail closed). */
  options: (extra?: Partial<LineOptions>) => LineOptions;
  events: () => LedgerEvent[];
  /** The item's `work.*` event types except `work.created`, in ledger order. */
  workTypes: () => string[];
  stateOf: () => WorkState;
  item: () => WorkItem;
  /** `item()` under the name Tasks 8 and 9 use: the item as the store reads it now. */
  fresh: () => WorkItem;
  /** `workTypes()` under the name Tasks 8 and 9 use. */
  trail: () => string[];
  /** The evidence, handoff and leftover temp files of the item, as paths under the item directory, sorted. */
  files: () => string[];
  /** `runLine(options(extra))`; the sequencer is imported on first use, so this file loads before it exists. */
  go: (extra?: Partial<LineOptions>) => Promise<LineResult>;
}

/**
 * The canary goal with one `ready` item. By default its interface decision is closed, so GATE-1 passes;
 * `interface: false` leaves it open (GATE-1 blocks with J2). The clock starts at the real time, because the
 * goal was approved at the real time and governance reads the goal's age.
 */
export function setupLine(setup: { interface?: boolean } = {}): LineFixture {
  const f = setupDecisionItem();
  if (setup.interface !== false) closeInterface(f);
  const clock = fakeClock();
  const store = createMarkdownStore(f.fx.location.dir);
  const item = (): WorkItem => {
    const [read] = store.fetchWorkItemsByIds([f.workId]);
    if (read === undefined) throw new Error("fixture item vanished");
    return read;
  };
  const events = (): LedgerEvent[] => f.fx.ledger.readVerified();
  return {
    f,
    fx: f.fx,
    clock,
    workId: f.workId,
    itemDir: f.item.dir,
    options: (extra = {}) => ({
      location: f.fx.location,
      workId: f.workId,
      stations: cleanStations(),
      now: clock.now,
      ...extra,
    }),
    events,
    workTypes: () =>
      events()
        .map((event) => event.type)
        .filter((type) => type.startsWith("work.") && type !== "work.created"),
    stateOf: () => item().front.state,
    item,
    fresh: item,
    trail: () =>
      events()
        .map((event) => event.type)
        .filter((type) => type.startsWith("work.") && type !== "work.created"),
    files: () => {
      const found: string[] = [];
      for (const name of ["evidence.json", "evidence.md"]) if (existsSync(join(f.item.dir, name))) found.push(name);
      for (const dir of [".", "handoffs"]) {
        const base = join(f.item.dir, dir);
        if (!existsSync(base)) continue;
        for (const name of readdirSync(base)) {
          if (dir === "handoffs" || name.endsWith(".tmp")) found.push(dir === "." ? name : `${dir}/${name}`);
        }
      }
      return found.sort();
    },
    go: async (extra = {}) => {
      const { runLine } = await import("../../src/work/sequencer.js");
      return runLine({
        location: f.fx.location,
        workId: f.workId,
        stations: cleanStations(),
        now: clock.now,
        ...extra,
      });
    },
  };
}

export function finished(result: LineResult): Extract<LineResult, { kind: "finished" }> {
  if (result.kind !== "finished") throw new Error(`expected a finished line, got ${JSON.stringify(result)}`);
  return result;
}

/** The result, the ledger, evidence.json, evidence.md and every handoff as one string, for canary searches. */
export function textOf(fx: LineFixture, result: LineResult): string {
  const parts = [JSON.stringify(result), readFileSync(fx.f.fx.ledger.file, "utf8")];
  for (const name of ["evidence.json", "evidence.md"]) {
    const file = join(fx.itemDir, name);
    if (existsSync(file)) parts.push(readFileSync(file, "utf8"));
  }
  const handoffs = join(fx.itemDir, "handoffs");
  if (existsSync(handoffs))
    for (const name of readdirSync(handoffs)) parts.push(readFileSync(join(handoffs, name), "utf8"));
  return parts.join("\n");
}
