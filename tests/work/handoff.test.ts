import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { validate } from "../../src/core/schema.js";
import type { Classification } from "../../src/work/classify.js";
import {
  HANDOFF_ROUTES,
  buildHandoff,
  handoffFile,
  markerToRan,
  owedPredecessors,
  remainingAfter,
  writeHandoff,
} from "../../src/work/handoff.js";
import {
  GATE_IDS,
  LINE_ORDER,
  STATION_IDS,
  type NodeId,
  type UnverifiedArea,
  type UnverifiedCode,
} from "../../src/work/line-types.js";
import { type ReasonCode, W_REASON_CODES } from "../../src/work/w-events.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { makeTempDir } from "../helpers/tmp.js";
import { T0, recordW } from "../helpers/work.js";

const GOAL = "g-fast";
const WORK = "w-0123456789ab";
const RUN = "r-20261014T090000Z-ab12";
const OTHER_RUN = "r-20261014T091000Z-cd34";
const NOW = new Date("2026-10-14T09:00:00.000Z");
const scope = { work_id: WORK, goal_id: GOAL, run_id: RUN };
const item = { front: { goal_id: GOAL, work_id: WORK } };
const OUTCOMES = ["flawed", "blocked", "manual"] as const;

type Class = Pick<Classification, "outcome" | "reason_code" | "unverified_areas">;
const classification = (
  outcome: Class["outcome"],
  reason_code: ReasonCode | null,
  unverified_areas: UnverifiedArea[] = [],
): Class => ({
  outcome,
  reason_code,
  unverified_areas,
});

const outcomeRecord = (code: ReasonCode, outcome: (typeof OUTCOMES)[number] = "blocked") =>
  buildHandoff({
    kind: "outcome",
    scope,
    predecessor_seq: null,
    classification: classification(outcome, code),
    ran: [{ node: "S3", result: "working" }],
    remaining: ["S4", "S5"],
    now: NOW,
  });

const predecessorRecord = (seq: number, runId: string = RUN) =>
  buildHandoff({
    kind: "killed_predecessor",
    scope: { ...scope, run_id: runId },
    predecessor_seq: seq,
    classification: classification("blocked", "run_killed"),
    ran: [],
    remaining: [],
    now: NOW,
  });

/** Every command a handoff option may name. Written out here, not derived from the source, so a new command is a visible edit. */
const ALLOWED_OPTIONS: readonly RegExp[] = [
  /^omf work show w-[0-9a-f]{12}$/,
  /^omf decide show w-[0-9a-f]{12}$/,
  /^omf decide resolve w-[0-9a-f]{12} <decision_id> --file <resolution\.json>$/,
  /^omf veto w-[0-9a-f]{12}$/,
  /^omf budget raise w-[0-9a-f]{12} --rounds <n>$/,
  /^omf budget raise w-[0-9a-f]{12} --usd <amount>$/,
  /^omf budget (declare|raise) g-[a-z0-9]+(-[a-z0-9]+)* disclosure <n>$/,
  /^after M3h: omf run w-[0-9a-f]{12}$/,
];

describe("HANDOFF_ROUTES", () => {
  it("has a route for every reason code and for nothing else", () => {
    expect(Object.keys(HANDOFF_ROUTES).sort()).toEqual([...W_REASON_CODES].sort());
  });

  it("sends each reason code to its J act", () => {
    const j = Object.fromEntries(W_REASON_CODES.map((code) => [code, HANDOFF_ROUTES[code].j]));
    expect(j).toEqual({
      j2_open: "J2",
      gate2_exhausted: "J3",
      scenarios_need_review: "J3",
      audit_flag: "J4",
      sealed_failed: "J4",
      flaky_scenario: "J4",
      within_variance: "J4",
      budget_exhausted: "J8",
      gate_blocked: "J7",
      manual_required: "J7",
      run_killed: "J6",
      visit_cap: "J6",
      stalled: "J6",
      reentry_loop: "J6",
      gate_not_run: "J6",
      station_error: "J6",
      station_skipped: "J6",
      evidence_incomplete: "J6",
      infra_failure: "J6",
      test_run_incomplete: "J6",
      test_reseal_required: "J3",
      noise_unverified: "J4",
      scenarios_exhausted: "J3",
      gates_failed: "J4",
      disclosure_unavailable: "J8",
    });
  });

  it("offers only commands from the closed allowlist, and only the work id varies", () => {
    for (const code of W_REASON_CODES) {
      const options = HANDOFF_ROUTES[code].options(WORK, GOAL);
      expect(options.length, code).toBeGreaterThan(0);
      expect(new Set(options).size, code).toBe(options.length);
      for (const option of options) {
        expect(
          ALLOWED_OPTIONS.some((pattern) => pattern.test(option)),
          `${code}: ${option}`,
        ).toBe(true);
      }
      const other = "w-aaaaaaaaaaaa";
      const otherGoal = "g-other";
      expect(
        HANDOFF_ROUTES[code].options(other, otherGoal).join("\n").replaceAll(other, "ID").replaceAll(otherGoal, "GOAL"),
        code,
      ).toBe(options.join("\n").replaceAll(WORK, "ID").replaceAll(GOAL, "GOAL"));
    }
  });

  it("offers scenarios_need_review no rerun, because a rerun reuses the standing seal and stops again", () => {
    const options = HANDOFF_ROUTES.scenarios_need_review.options(WORK, GOAL);
    expect(options).toEqual([`omf work show ${WORK}`, `omf veto ${WORK}`]);
    expect(options.join("\n")).not.toContain(" run ");
  });

  it("offers no rerun for the states a rerun cannot clear", () => {
    for (const code of [
      "scenarios_need_review",
      "scenarios_exhausted",
      "test_reseal_required",
      "test_run_incomplete",
    ] as const) {
      const options = HANDOFF_ROUTES[code].options(WORK, GOAL);
      expect(options, code).toEqual([`omf work show ${WORK}`, `omf veto ${WORK}`]);
      expect(options.join("\n"), code).not.toContain(" run ");
    }
  });

  it("names a command that runs the line again only with the 'after M3h' prefix", () => {
    for (const code of W_REASON_CODES) {
      for (const option of HANDOFF_ROUTES[code].options(WORK, GOAL)) {
        if (option.includes(" run ")) expect(option.startsWith("after M3h: omf run "), `${code}: ${option}`).toBe(true);
      }
    }
  });
});

describe("buildHandoff", () => {
  it("validates for every reason code and every outcome that needs a person", () => {
    for (const code of W_REASON_CODES) {
      for (const outcome of OUTCOMES) {
        const record = outcomeRecord(code, outcome);
        expect(validate("handoff.schema.json", record), `${outcome}/${code}`).toEqual({ ok: true });
        expect(record.decision_required.j).toBe(HANDOFF_ROUTES[code].j);
        expect(record.decision_required.question).toBe(HANDOFF_ROUTES[code].question);
        expect(record.decision_required.options).toEqual(HANDOFF_ROUTES[code].options(WORK, GOAL));
        expect(record).toMatchObject({
          schema_version: 1,
          kind: "outcome",
          predecessor_seq: null,
          resume: "not_available_until_m4",
        });
      }
    }
  });

  it("builds the state from the fixed sentence and the next node, nothing else", () => {
    const withNext = outcomeRecord("visit_cap");
    expect(withNext.state).toBe(`${HANDOFF_ROUTES.visit_cap.state} Next in line: S4.`);
    const done = buildHandoff({
      kind: "outcome",
      scope,
      predecessor_seq: null,
      classification: classification("blocked", "gate_not_run"),
      ran: [],
      remaining: [],
      now: NOW,
    });
    expect(done.state).toBe(HANDOFF_ROUTES.gate_not_run.state);
  });

  it("keeps the unverified codes and drops their decision ids", () => {
    const areas: UnverifiedArea[] = [
      { code: "decision_unmeasured", decision_id: CANARY.metricId },
      { code: "decision_unmeasured", decision_id: "d-other" },
      { code: "injected_gate", decision_id: null },
    ];
    const record = buildHandoff({
      kind: "outcome",
      scope,
      predecessor_seq: null,
      classification: classification("flawed", "audit_flag", areas),
      ran: [{ node: "S5", result: "handed_off" }],
      remaining: ["GATE-3", "S6"],
      now: NOW,
    });
    expect(record.risks).toEqual(["decision_unmeasured", "injected_gate"]);
    expect(canaryHits(JSON.stringify(record))).toEqual([]);
  });

  it("refuses text it cannot template: a free-form result, an unknown node, a success", () => {
    const base = {
      kind: "outcome" as const,
      scope,
      predecessor_seq: null,
      classification: classification("blocked", "station_error"),
      ran: [] as { node: NodeId; result: string }[],
      remaining: [] as NodeId[],
      now: NOW,
    };
    expect(() => buildHandoff({ ...base, ran: [{ node: "S3", result: CANARY.metricId }] })).toThrow(/invalid handoff/);
    expect(() => buildHandoff({ ...base, ran: [{ node: "S9" as NodeId, result: "working" }] })).toThrow(
      /invalid handoff/,
    );
    expect(() => buildHandoff({ ...base, remaining: ["S9" as NodeId] })).toThrow(/invalid handoff/);
    expect(() =>
      buildHandoff({ ...base, classification: { outcome: "success", reason_code: null, unverified_areas: [] } }),
    ).toThrow("a handoff needs a flawed, blocked or manual outcome with a reason code");
    expect(() => buildHandoff({ ...base, classification: classification("blocked", null) })).toThrow(
      "a handoff needs a flawed, blocked or manual outcome with a reason code",
    );
  });

  it("ties the kind to the predecessor seq and to run_killed", () => {
    const base = { scope, ran: [], remaining: [], now: NOW };
    const killed = classification("blocked", "run_killed");
    expect(() =>
      buildHandoff({ ...base, kind: "killed_predecessor", predecessor_seq: null, classification: killed }),
    ).toThrow(/invalid handoff/);
    expect(() =>
      buildHandoff({
        ...base,
        kind: "killed_predecessor",
        predecessor_seq: 4,
        classification: classification("blocked", "station_error"),
      }),
    ).toThrow(/invalid handoff/);
    expect(() => buildHandoff({ ...base, kind: "outcome", predecessor_seq: 4, classification: killed })).toThrow(
      /invalid handoff/,
    );
    expect(predecessorRecord(4)).toMatchObject({
      kind: "killed_predecessor",
      predecessor_seq: 4,
      outcome: "blocked",
      reason_code: "run_killed",
    });
  });
});

describe("handoff schema", () => {
  it("lists exactly the node ids, reason codes and unverified codes the code knows", () => {
    const schema = JSON.parse(readFileSync(new URL("../../schemas/handoff.schema.json", import.meta.url), "utf8")) as {
      $defs: { node: { enum: string[] }; reason_code: { enum: string[] }; risk: { enum: string[] } };
    };
    expect(schema.$defs.node.enum).toEqual([...STATION_IDS, ...GATE_IDS]);
    expect(schema.$defs.reason_code.enum).toEqual([...W_REASON_CODES]);
    // A Record over the union fails to compile when a code is added to UnverifiedCode and not here.
    const risks: Record<UnverifiedCode, true> = {
      decision_unmeasured: true,
      model_spend_unverifiable: true,
      noise_check_not_run: true,
      noise_check_not_evaluated: true,
      high_risk_paths_not_run: true,
      high_risk_paths_touched: true,
      decisions_masked: true,
      injected_gate: true,
    };
    expect([...schema.$defs.risk.enum].sort()).toEqual(Object.keys(risks).sort());
  });
});

describe("markerToRan and remainingAfter", () => {
  it("parses a progress marker into one ran entry, and anything else into none", () => {
    expect(markerToRan("S3 working")).toEqual([{ node: "S3", result: "working" }]);
    expect(markerToRan("S5 handed_off\n")).toEqual([{ node: "S5", result: "handed_off" }]);
    for (const bad of [null, "", "S8 working", "S3", "S3 Working", "S3 working extra", "<!-- omf:progress -->"]) {
      expect(markerToRan(bad), String(bad)).toEqual([]);
    }
  });

  it("lists what is left in line order after the last node that ran", () => {
    expect(remainingAfter(null)).toEqual([...LINE_ORDER]);
    expect(remainingAfter("S5")).toEqual(["GATE-3", "S6", "GATE-4", "S7"]);
    expect(remainingAfter("S7")).toEqual([]);
  });
});

describe("writeHandoff", () => {
  it("names the file by run and kind, so the two kinds never collide", () => {
    const dir = makeTempDir("omf-handoff-");
    expect(handoffFile(dir, RUN, "outcome")).toBe(join(dir, "handoffs", `${RUN}.json`));
    expect(handoffFile(dir, RUN, "killed_predecessor")).toBe(join(dir, "handoffs", `${RUN}.predecessor.json`));
    expect(() => handoffFile(dir, "../x", "outcome")).toThrow("handoff file names need a run id");
  });

  it("writes the record atomically at 0600 and leaves no temp file", () => {
    const dir = makeTempDir("omf-handoff-");
    const record = outcomeRecord("station_error");
    writeHandoff(dir, record);
    writeHandoff(dir, predecessorRecord(3));
    const file = handoffFile(dir, RUN, "outcome");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "handoffs")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, "handoffs")).sort()).toEqual([`${RUN}.json`, `${RUN}.predecessor.json`]);
  });

  it("never overwrites: the same run and kind is refused, another run gets its own file", () => {
    const dir = makeTempDir("omf-handoff-");
    const first = outcomeRecord("station_error");
    writeHandoff(dir, first);
    const before = readFileSync(handoffFile(dir, RUN, "outcome"), "utf8");
    expect(() => writeHandoff(dir, outcomeRecord("gate_not_run"))).toThrow(/already exists/);
    expect(readFileSync(handoffFile(dir, RUN, "outcome"), "utf8")).toBe(before);
    writeHandoff(dir, { ...first, run_id: OTHER_RUN });
    expect(readdirSync(join(dir, "handoffs")).sort()).toEqual([`${RUN}.json`, `${OTHER_RUN}.json`]);
  });

  it("refuses an invalid record and writes nothing", () => {
    const dir = makeTempDir("omf-handoff-");
    expect(() => writeHandoff(dir, { ...outcomeRecord("station_error"), resume: "later" } as never)).toThrow(
      /invalid handoff/,
    );
    expect(existsSync(join(dir, "handoffs"))).toBe(false);
  });
});

describe("owedPredecessors", () => {
  const fresh = () => {
    const dir = makeTempDir("omf-handoff-");
    return { dir, ledger: new Ledger(dir, () => T0) };
  };
  const owed = (f: { dir: string; ledger: Ledger }, workId: string = WORK) =>
    owedPredecessors(f.dir, f.ledger.readVerified(), workId);

  it("owes nothing on an empty ledger", () => {
    expect(owed(fresh())).toEqual([]);
  });

  it("owes a reclaim that came after the last state event, until a predecessor file covers it", () => {
    const f = fresh();
    recordW(f.ledger, "work.started", item); // seq 1
    recordW(f.ledger, "work.claim_reclaimed", item); // seq 2
    expect(owed(f)).toEqual([{ seq: 2 }]);
    writeHandoff(f.dir, predecessorRecord(2));
    expect(owed(f)).toEqual([]);
  });

  it("ignores a reclaim that came before the item's last state event", () => {
    const f = fresh();
    recordW(f.ledger, "work.started", item); // 1
    recordW(f.ledger, "work.claim_reclaimed", item); // 2
    recordW(f.ledger, "work.parked", item); // 3: a later run finished
    expect(owed(f)).toEqual([]);
  });

  it("returns only the newest of several reclaims, and one file covers every older one", () => {
    const f = fresh();
    recordW(f.ledger, "work.claim_reclaimed", item); // 1
    recordW(f.ledger, "work.claim_reclaimed", item); // 2
    expect(owed(f)).toEqual([{ seq: 2 }]);
    writeHandoff(f.dir, predecessorRecord(1));
    expect(owed(f)).toEqual([{ seq: 2 }]);
    writeHandoff(f.dir, predecessorRecord(2, OTHER_RUN));
    expect(owed(f)).toEqual([]);
  });

  it("owes a later kill again after an earlier one was covered", () => {
    const f = fresh();
    recordW(f.ledger, "work.claim_reclaimed", item); // 1
    writeHandoff(f.dir, predecessorRecord(1));
    recordW(f.ledger, "work.claim_reclaimed", item); // 2
    expect(owed(f)).toEqual([{ seq: 2 }]);
  });

  it("looks at its own item only", () => {
    const f = fresh();
    recordW(f.ledger, "work.claim_reclaimed", { front: { goal_id: GOAL, work_id: "w-ffffffffffff" } });
    expect(owed(f)).toEqual([]);
    expect(owed(f, "w-ffffffffffff")).toEqual([{ seq: 1 }]);
  });

  it("is not satisfied by a corrupt file or by an outcome handoff", () => {
    const f = fresh();
    recordW(f.ledger, "work.claim_reclaimed", item);
    mkdirSync(join(f.dir, "handoffs"), { recursive: true });
    writeFileSync(join(f.dir, "handoffs", `${RUN}.predecessor.json`), "{not json");
    writeHandoff(f.dir, outcomeRecord("station_error", "blocked"));
    expect(owed(f)).toEqual([{ seq: 1 }]);
  });
});
