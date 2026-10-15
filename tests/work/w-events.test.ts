import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import {
  RUN_ID_PATTERN,
  W_EVENT_TYPES,
  W_REASON_CODES,
  type WEvent,
  classifyWEvent,
  lastStateEvent,
  newRunId,
  targetOf,
  wEvent,
} from "../../src/work/w-events.js";
import { findForbiddenKey } from "../../src/work/work-item.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-w-events-"));

const scope = { goal_id: "g-fast", work_id: "w-0123456789ab", run_id: "r-20261014T091500Z-ab12" };
const other = { ...scope, work_id: "w-ba9876543210" };

/** One valid event of each type, in W_EVENT_TYPES order. */
const SAMPLES: readonly WEvent[] = [
  { type: "work.started", payload: { ...scope, from: "ready" } },
  { type: "work.submitted", payload: { ...scope, outcome: "success", recommendation: "merge_recommended" } },
  { type: "work.failed", payload: { ...scope, outcome: "blocked", reason_code: "budget_exhausted" } },
  { type: "work.parked", payload: { ...scope, outcome: "manual", reason_code: "manual_required" } },
  { type: "work.repaired", payload: { ...scope, from: "ready", to: "in_progress", source_seq: 7 } },
  {
    type: "work.claim_reclaimed",
    payload: { ...scope, previous_pid: 4242, previous_acquired_at: "2026-10-14T09:00:00.000Z" },
  },
  { type: "work.resumed", payload: scope },
];

const accepts = (type: string, payload: object): boolean => validate("work-event.schema.json", { type, payload }).ok;

interface SchemaDoc {
  $defs: Record<string, { enum?: string[]; properties?: Record<string, Record<string, unknown>> }>;
}
const schemaDoc = (): SchemaDoc =>
  JSON.parse(readFileSync(schemaUrl("work-event.schema.json"), "utf8")) as SchemaDoc;

describe("W events", () => {
  it("has one sample for each of the seven event types", () => {
    expect(SAMPLES.map((s) => s.type)).toEqual([...W_EVENT_TYPES]);
  });

  for (const sample of SAMPLES) {
    it(`${sample.type} builds as actor omf, validates and round-trips through the ledger`, () => {
      const built = wEvent(sample);
      expect(built.actor).toBe("omf");
      expect(accepts(built.type, built.payload)).toBe(true);
      const stored = newLedger().append(built);
      expect(classifyWEvent(stored)).toEqual({ kind: "w", seq: stored.seq, event: sample });
    });
  }

  it("refuses to build an event whose ids are malformed", () => {
    expect(() => wEvent({ type: "work.resumed", payload: { ...scope, work_id: "w-1" } })).toThrow(/invalid work.resumed event/);
  });

  it("ignores a W type written by anyone but omf, and any other type", () => {
    const ledger = newLedger();
    const forged = ledger.append({ actor: "human:dev", type: "work.started", payload: { ...scope, from: "ready" } });
    const agent = ledger.append({ actor: "agent:codex", type: "work.failed", payload: { ...scope, outcome: "blocked", reason_code: "station_error" } });
    const approved = ledger.append({ actor: "omf", type: "work.approved", payload: { ...scope } });
    for (const event of [forged, agent, approved]) expect(classifyWEvent(event)).toEqual({ kind: "none" });
  });

  it("classifies an omf W event with a missing or extra field as invalid and names the ids", () => {
    const ledger = newLedger();
    const missing = ledger.append({ actor: "omf", type: "work.started", payload: { ...scope } });
    const extra = ledger.append({ actor: "omf", type: "work.started", payload: { ...scope, from: "ready", note: "x" } });
    const garbled = ledger.append({ actor: "omf", type: "work.resumed", payload: { goal_id: "G X", work_id: "nope", run_id: 1 } });
    expect(classifyWEvent(missing)).toEqual({ kind: "invalid", goal_id: "g-fast", work_id: "w-0123456789ab" });
    expect(classifyWEvent(extra)).toEqual({ kind: "invalid", goal_id: "g-fast", work_id: "w-0123456789ab" });
    expect(classifyWEvent(garbled)).toEqual({ kind: "invalid", goal_id: null, work_id: null });
  });

  it("accepts only closed reason codes, and the schema enum is the list", () => {
    for (const reason_code of W_REASON_CODES) {
      expect(accepts("work.failed", { ...scope, outcome: "blocked", reason_code })).toBe(true);
      expect(accepts("work.parked", { ...scope, outcome: "blocked", reason_code })).toBe(true);
    }
    for (const reason_code of ["station error", "STATION_ERROR", "p95_over_40ms", "", "j2_open "]) {
      expect(accepts("work.failed", { ...scope, outcome: "blocked", reason_code }), reason_code).toBe(false);
      expect(accepts("work.parked", { ...scope, outcome: "blocked", reason_code }), reason_code).toBe(false);
    }
    expect(schemaDoc().$defs.reason_code?.enum).toEqual([...W_REASON_CODES]);
  });

  it("keeps each outcome and field with the event that owns it", () => {
    const good = { ...scope, outcome: "flawed", recommendation: "not_recommended" };
    expect(accepts("work.submitted", good)).toBe(true);
    expect(accepts("work.submitted", { ...good, reason_code: "station_error" })).toBe(false);
    expect(accepts("work.submitted", { ...good, outcome: "blocked" })).toBe(false);
    expect(accepts("work.submitted", { ...good, recommendation: "ship_it" })).toBe(false);
    expect(accepts("work.failed", { ...scope, outcome: "blocked" })).toBe(false);
    expect(accepts("work.failed", { ...scope, outcome: "success", reason_code: "station_error" })).toBe(false);
    expect(accepts("work.parked", { ...scope, outcome: "flawed", reason_code: "station_error" })).toBe(false);
    expect(accepts("work.started", { ...scope, from: "in_progress" })).toBe(false);
    expect(accepts("work.repaired", { ...scope, from: "ready", to: "in_progress", source_seq: 0 })).toBe(false);
  });

  it("lets claim_reclaimed say the previous owner was unreadable", () => {
    expect(accepts("work.claim_reclaimed", { ...scope, previous_pid: null, previous_acquired_at: "" })).toBe(true);
    expect(accepts("work.claim_reclaimed", { ...scope, previous_pid: 0, previous_acquired_at: "" })).toBe(false);
    expect(accepts("work.claim_reclaimed", { ...scope, previous_pid: 9, previous_acquired_at: "yesterday" })).toBe(false);
  });

  it("makes run ids that match the pattern, and refuses a generator that does not", () => {
    const at = new Date("2026-10-14T09:15:00.123Z");
    expect(newRunId(at, () => "ab12")).toBe("r-20261014T091500Z-ab12");
    expect(newRunId(at)).toMatch(RUN_ID_PATTERN);
    expect(() => newRunId(at, () => "AB12")).toThrow(/four lowercase hex digits/);
    expect(accepts("work.resumed", { ...scope, run_id: "r-1" })).toBe(false);
  });

  it("maps each event type to the state it moves the item to", () => {
    expect(Object.fromEntries(W_EVENT_TYPES.map((type) => [type, targetOf(type)]))).toEqual({
      "work.started": "in_progress",
      "work.submitted": "awaiting_review",
      "work.failed": "failed",
      "work.parked": null,
      "work.repaired": null,
      "work.claim_reclaimed": null,
      "work.resumed": null,
    });
  });

  it("finds the last state-bearing event of one item and skips the rest", () => {
    const ledger = newLedger();
    expect(lastStateEvent(ledger.readVerified(), scope.work_id)).toBeNull();
    const started = ledger.append(wEvent(SAMPLES[0] as WEvent));
    ledger.append(wEvent({ type: "work.started", payload: { ...other, from: "ready" } }));
    ledger.append(wEvent(SAMPLES[4] as WEvent));
    ledger.append(wEvent(SAMPLES[5] as WEvent));
    ledger.append(wEvent(SAMPLES[6] as WEvent));
    expect(lastStateEvent(ledger.readVerified(), scope.work_id)).toMatchObject({ seq: started.seq, event: { type: "work.started" } });
    const parked = ledger.append(wEvent(SAMPLES[3] as WEvent));
    ledger.append({ actor: "human:dev", type: "work.failed", payload: { ...scope, outcome: "blocked", reason_code: "station_error" } });
    expect(lastStateEvent(ledger.readVerified(), scope.work_id)).toMatchObject({ seq: parked.seq, event: { type: "work.parked" } });
  });

  it("carries no key a metric value or query could hide under, and no free-text string", () => {
    for (const sample of SAMPLES) expect(findForbiddenKey(sample.payload), sample.type).toBeNull();
    const doc = schemaDoc();
    expect(findForbiddenKey(doc)).toBeNull();
    for (const [name, def] of Object.entries(doc.$defs)) {
      for (const [key, prop] of Object.entries(def.properties ?? {})) {
        const closed = ["const", "enum", "$ref", "anyOf", "minimum"].some((k) => k in prop);
        expect(closed, `${name}.${key} must be an id, a number or a closed list`).toBe(true);
      }
    }
  });
});

const M3B1_CODES = ["j2_open", "gate_blocked", "budget_exhausted", "infra_failure", "manual_required", "station_error"] as const;
/** The twelve codes M3b2 adds (D19): each one is the reason of exactly one classifier row or handoff route. */
const M3B2_CODES = [
  "visit_cap",
  "stalled",
  "gate_not_run",
  "station_skipped",
  "evidence_incomplete",
  "run_killed",
  "audit_flag",
  "sealed_failed",
  "flaky_scenario",
  "within_variance",
  "gate2_exhausted",
  "reentry_loop",
] as const;

describe("M3b2 reason codes", () => {
  it("keeps the six M3b1 codes first, then the twelve M3b2 ones (later milestones append after them), and repeats none", () => {
    expect([...W_REASON_CODES].slice(0, M3B1_CODES.length + M3B2_CODES.length)).toEqual([...M3B1_CODES, ...M3B2_CODES]);
    expect(new Set(W_REASON_CODES).size).toBe(W_REASON_CODES.length);
  });

  it("is accepted by the schema itself, not only by the list, on a failed and a parked event", () => {
    const enumValues = schemaDoc().$defs.reason_code?.enum ?? [];
    for (const code of M3B2_CODES) {
      expect(enumValues, code).toContain(code);
      expect(accepts("work.failed", { ...scope, outcome: "flawed", reason_code: code }), code).toBe(true);
      expect(accepts("work.parked", { ...scope, outcome: "blocked", reason_code: code }), code).toBe(true);
    }
  });

  it("builds an omf event for each new code", () => {
    for (const code of M3B2_CODES) {
      const built = wEvent({ type: "work.parked", payload: { ...scope, outcome: "blocked", reason_code: code } });
      expect(built.actor).toBe("omf");
      expect(built.payload.reason_code).toBe(code);
    }
  });

  it("still refuses a near miss of a new code", () => {
    for (const reason_code of ["visit-cap", "Visit_Cap", "visit_cap ", "gate2exhausted", "reentry loop"]) {
      expect(accepts("work.failed", { ...scope, outcome: "blocked", reason_code }), reason_code).toBe(false);
    }
  });
});

describe("scenarios_need_review", () => {
  it("is appended after the M3b2 codes, in the list and in the schema, and the schema accepts it", () => {
    expect(W_REASON_CODES.at(-1)).toBe("scenarios_need_review");
    expect(schemaDoc().$defs.reason_code?.enum ?? []).toContain("scenarios_need_review");
    expect(accepts("work.parked", { ...scope, outcome: "blocked", reason_code: "scenarios_need_review" })).toBe(true);
  });
});
