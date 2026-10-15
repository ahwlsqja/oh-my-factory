import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDef } from "../../src/core/schema.js";
import type { Gate1Reason, Gate1Result } from "../../src/decision/gate1.js";
import {
  clearNeedsHuman,
  needsHumanFile,
  needsHumanFor,
  persistNeedsHuman,
  readNeedsHuman,
  syncNeedsHuman,
} from "../../src/decision/needs-human.js";
import type { DecisionScope } from "../../src/decision/types.js";
import { makeTempDir } from "../helpers/tmp.js";

const SCOPE: DecisionScope = { goal_id: "g-demo", work_id: "w-0123456789ab" };
const T1 = new Date("2026-10-14T10:00:00.000Z");
const T2 = new Date("2026-10-14T11:00:00.000Z");

type Blocked = Extract<Gate1Result, { status: "blocked_on_user" }>;
const blocked = (...reasons: Gate1Reason[]): Blocked => ({ status: "blocked_on_user", j: "J2", reasons });

/** One reason of every code, so the schema check covers each shape the gate can produce. */
const ALL_REASONS: Gate1Reason[] = [
  { code: "interface_missing" },
  { code: "interface_unresolved" },
  { code: "intent_question_missing", decision_id: "d-intent-q1" },
  { code: "required_open", decision_id: "d-a" },
  { code: "resolution_not_human", decision_id: "d-b" },
  { code: "deferral_unsigned", decision_id: "d-c" },
  { code: "deferral_expired", decision_id: "d-d", expires_at: "2026-10-01T00:00:00.000Z" },
  { code: "record_invalid", decision_id: "d-e", problem: "leak" },
  { code: "ledger_anomaly", decision_id: null, anomaly: "malformed_event" },
];

describe("needsHumanFor", () => {
  it("builds a record that matches the schema and never approves by default", () => {
    const record = needsHumanFor(SCOPE, blocked(...ALL_REASONS), T1);
    expect(validateDef("decision.schema.json", "needs_human", record)).toEqual({ ok: true });
    expect(record).toMatchObject({
      schema_version: 1,
      j: "J2",
      work_id: "w-0123456789ab",
      goal_id: "g-demo",
      default: null,
    });
    expect(record.id).toMatch(/^nh-[0-9a-f]{12}$/);
    expect(record.resume_token).toMatch(/^[0-9a-f]{32}$/);
    expect(record.created_at).toBe("2026-10-14T10:00:00.000Z");
  });

  it("derives the token from the reasons only: same block, same token", () => {
    const a = needsHumanFor(SCOPE, blocked({ code: "required_open", decision_id: "d-a" }), T1);
    const again = needsHumanFor(SCOPE, blocked({ code: "required_open", decision_id: "d-a" }), T2);
    const other = needsHumanFor(SCOPE, blocked({ code: "required_open", decision_id: "d-b" }), T1);
    expect(again.resume_token).toBe(a.resume_token);
    expect(again.id).toBe(a.id);
    expect(other.resume_token).not.toBe(a.resume_token);
  });

  it("states the question with counts and ids only", () => {
    const record = needsHumanFor(
      SCOPE,
      blocked(
        { code: "required_open", decision_id: "d-a" },
        { code: "required_open", decision_id: "d-b" },
        { code: "interface_missing" },
      ),
      T1,
    );
    expect(record.question).toBe(
      "Work item w-0123456789ab cannot pass GATE-1: 3 reason(s) need a person (J2). Reasons: interface_missing x1, required_open x2. Decisions: d-a, d-b.",
    );
  });

  it("lists the add and resolve verbs for a missing interface, in that order", () => {
    const record = needsHumanFor(SCOPE, blocked({ code: "interface_missing" }), T1);
    expect(record.options).toEqual([
      "omf decide add w-0123456789ab --file <entry.json>  (id d-interface, class interface)",
      "omf decide resolve w-0123456789ab d-interface --file <resolution.json>",
    ]);
  });

  it("points an unseeded intent question at show first, then resolve", () => {
    const record = needsHumanFor(
      SCOPE,
      blocked(
        { code: "intent_question_missing", decision_id: "d-intent-q1" },
        { code: "intent_question_missing", decision_id: "d-intent-q2" },
      ),
      T1,
    );
    expect(record.options).toEqual([
      "omf decide show w-0123456789ab",
      "omf decide resolve w-0123456789ab d-intent-q1 --file <resolution.json>",
      "omf decide resolve w-0123456789ab d-intent-q2 --file <resolution.json>",
    ]);
  });

  it("tells a person to cancel or veto when no decision verb can clear the block (A17)", () => {
    const record = needsHumanFor(
      SCOPE,
      blocked(
        { code: "record_invalid", decision_id: "d-e", problem: "measure_missing" },
        { code: "required_open", decision_id: "d-a" },
        { code: "ledger_anomaly", decision_id: null, anomaly: "already_closed" },
      ),
      T1,
    );
    expect(record.options).toEqual([
      "omf decide resolve w-0123456789ab d-a --file <resolution.json>",
      "cancel or veto the work item (a closed or forged record cannot be reopened in v0.1)",
    ]);
  });

  it("never copies the id of a record_invalid or ledger_anomaly reason", () => {
    const record = needsHumanFor(
      SCOPE,
      blocked(
        { code: "record_invalid", decision_id: "d-leaky-phrase", problem: "leak" },
        { code: "ledger_anomaly", decision_id: "d-leaky-phrase", anomaly: "malformed_event" },
      ),
      T1,
    );
    expect(JSON.stringify(record)).not.toContain("leaky-phrase");
    expect(record.reasons).toEqual([
      { code: "record_invalid", decision_id: null, problem: "leak" },
      { code: "ledger_anomaly", decision_id: null, anomaly: "malformed_event" },
    ]);
  });
});

describe("persistNeedsHuman and readNeedsHuman", () => {
  it("writes needs-human.json at 0600 and reads it back", () => {
    const dir = makeTempDir();
    const record = needsHumanFor(SCOPE, blocked({ code: "interface_missing" }), T1);
    persistNeedsHuman(dir, record);
    expect(needsHumanFile(dir)).toBe(join(dir, "needs-human.json"));
    expect((statSync(needsHumanFile(dir)).mode & 0o777).toString(8)).toBe("600");
    expect(readNeedsHuman(dir)).toEqual(record);
    expect(readFileSync(needsHumanFile(dir), "utf8")).toContain('"default": null');
  });

  it("leaves the file untouched when the same block is persisted again, and rewrites a different one", () => {
    const dir = makeTempDir();
    const reasons: Gate1Reason[] = [{ code: "required_open", decision_id: "d-a" }];
    persistNeedsHuman(dir, needsHumanFor(SCOPE, blocked(...reasons), T1));
    const first = readFileSync(needsHumanFile(dir), "utf8");
    persistNeedsHuman(dir, needsHumanFor(SCOPE, blocked(...reasons), T2));
    expect(readFileSync(needsHumanFile(dir), "utf8")).toBe(first);
    persistNeedsHuman(dir, needsHumanFor(SCOPE, blocked({ code: "required_open", decision_id: "d-b" }), T2));
    expect(readNeedsHuman(dir)?.created_at).toBe("2026-10-14T11:00:00.000Z");
  });

  it("reads a missing, unparsable or schema-invalid file as null", () => {
    const dir = makeTempDir();
    expect(readNeedsHuman(dir)).toBeNull();
    writeFileSync(needsHumanFile(dir), "{not json");
    expect(readNeedsHuman(dir)).toBeNull();
    writeFileSync(needsHumanFile(dir), JSON.stringify({ schema_version: 1, j: "J2" }));
    expect(readNeedsHuman(dir)).toBeNull();
  });

  it("replaces an invalid file by the new block instead of trusting its token", () => {
    const dir = makeTempDir();
    writeFileSync(needsHumanFile(dir), "{not json");
    const record = needsHumanFor(SCOPE, blocked({ code: "interface_missing" }), T1);
    persistNeedsHuman(dir, record);
    expect(readNeedsHuman(dir)).toEqual(record);
  });
});

describe("clearNeedsHuman and syncNeedsHuman", () => {
  it("clear removes the file and tolerates a missing one", () => {
    const dir = makeTempDir();
    persistNeedsHuman(dir, needsHumanFor(SCOPE, blocked({ code: "interface_missing" }), T1));
    clearNeedsHuman(dir);
    expect(existsSync(needsHumanFile(dir))).toBe(false);
    expect(() => clearNeedsHuman(dir)).not.toThrow();
  });

  it("persists on a block and clears on a pass", () => {
    const dir = makeTempDir();
    syncNeedsHuman(dir, SCOPE, blocked({ code: "required_open", decision_id: "d-a" }), T1);
    expect(readNeedsHuman(dir)?.reasons).toEqual([{ code: "required_open", decision_id: "d-a" }]);
    syncNeedsHuman(dir, SCOPE, { status: "pass" }, T2);
    expect(existsSync(needsHumanFile(dir))).toBe(false);
    expect(() => syncNeedsHuman(dir, SCOPE, { status: "pass" }, T2)).not.toThrow();
  });
});
