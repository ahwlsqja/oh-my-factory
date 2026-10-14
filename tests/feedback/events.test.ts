import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import { DECISION_CLASSES } from "../../src/decision/types.js";
import {
  FEEDBACK_EVENT_TYPES,
  type FeedbackEvent,
  feedbackEvent,
  feedbackEventsOf,
} from "../../src/feedback/events.js";
import { scorePct } from "../../src/feedback/ladder.js";
import { FeedbackError, type ReleasedCategory } from "../../src/feedback/types.js";
import { RUN_ID_PATTERN } from "../../src/work/w-events.js";
import { findForbiddenKey } from "../../src/work/work-item.js";
import { makeTempDir } from "../helpers/tmp.js";

const GOAL = "g-fast";
const WORK = "w-0123456789ab";
const RUN = "r-20261014T091500Z-ab12";
const TRAIN = "a".repeat(64);
const TEST = "b".repeat(64);
const SHA = "c".repeat(40);

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-feedback-events-"));

function category(
  name: ReleasedCategory["category"],
  n: number,
  pass: number,
  kind: ReleasedCategory["kind"],
): ReleasedCategory {
  return { category: name, n, pass, score_pct: scorePct(pass, n), kind };
}

const RELEASED: FeedbackEvent = {
  type: "feedback.released",
  payload: {
    goal_id: GOAL,
    work_id: WORK,
    run_id: RUN,
    train_digest: TRAIN,
    round: 1,
    categories: [category("interface", 10, 4, "first"), category("security", 5, 2, "first")],
    disclosure_units: 1,
  },
};
const CONSUMED: FeedbackEvent = {
  type: "feedback.test_run_consumed",
  payload: { goal_id: GOAL, work_id: WORK, run_id: RUN, test_digest: TEST, candidate_sha: SHA, test_total: 6 },
};
const COMPLETED: FeedbackEvent = {
  type: "feedback.test_run_completed",
  payload: {
    goal_id: GOAL,
    work_id: WORK,
    run_id: RUN,
    test_digest: TEST,
    candidate_sha: SHA,
    pass: 4,
    total: 6,
    flaky: 1,
  },
};
const RESEALED: FeedbackEvent = {
  type: "feedback.test_reseal_authorized",
  payload: { goal_id: GOAL, work_id: WORK, consumed_test_digest: TEST, basis: "J6" },
};

/** One valid event of each type, in FEEDBACK_EVENT_TYPES order, with the actor that may write it. */
const SAMPLES: readonly { actor: string; event: FeedbackEvent }[] = [
  { actor: "omf", event: RELEASED },
  { actor: "omf", event: CONSUMED },
  { actor: "omf", event: COMPLETED },
  { actor: "human:dev", event: RESEALED },
];

const payloadOf = (event: FeedbackEvent): Record<string, unknown> => ({ ...event.payload });

/** The event with payload keys replaced or added; deliberately loose so tests can build invalid ones. */
const mutate = (event: FeedbackEvent, patch: Record<string, unknown>): FeedbackEvent =>
  ({ type: event.type, payload: { ...event.payload, ...patch } }) as unknown as FeedbackEvent;

function failure(run: () => unknown): FeedbackError {
  try {
    run();
  } catch (err) {
    if (err instanceof FeedbackError) return err;
    throw err;
  }
  throw new Error("expected a FeedbackError, nothing was thrown");
}

interface SchemaDoc {
  $defs: Record<string, { enum?: string[]; pattern?: string }>;
}
const readSchema = (name: string): SchemaDoc => JSON.parse(readFileSync(schemaUrl(name), "utf8")) as SchemaDoc;

describe("feedback event schema", () => {
  it("has one sample for each of the four event types", () => {
    expect(SAMPLES.map((s) => s.event.type)).toEqual([...FEEDBACK_EVENT_TYPES]);
  });

  it("lists exactly the decision classes as categories", () => {
    expect(readSchema("feedback-event.schema.json").$defs.category?.enum).toEqual([...DECISION_CLASSES]);
  });

  it("copies the id definitions of the work events", () => {
    const feedback = readSchema("feedback-event.schema.json").$defs;
    const work = readSchema("work-event.schema.json").$defs;
    for (const id of ["goal_id", "work_id", "run_id"]) {
      expect(feedback[id], id).toEqual(work[id]);
    }
    expect(new RegExp(feedback.run_id?.pattern ?? "").source).toBe(RUN_ID_PATTERN.source);
  });

  it("holds no key that could carry a measured value, a target or a query", () => {
    expect(findForbiddenKey(readSchema("feedback-event.schema.json"))).toBeNull();
    for (const { event } of SAMPLES) expect(findForbiddenKey(event.payload), event.type).toBeNull();
  });
});

describe("feedbackEvent (the writer)", () => {
  for (const { actor, event } of SAMPLES) {
    it(`${event.type} builds as ${actor}, validates and round-trips through the ledger`, () => {
      const built = feedbackEvent(event, actor);
      expect(built.actor).toBe(actor);
      expect(validate("feedback-event.schema.json", { type: built.type, payload: built.payload }).ok).toBe(true);
      const ledger = newLedger();
      const stored = ledger.append(built);
      expect(feedbackEventsOf(ledger.readVerified(), GOAL)).toEqual([
        { kind: "feedback", seq: stored.seq, actor, event },
      ]);
    });
  }

  const refused: [string, FeedbackEvent, string, "forbidden" | "invalid_input"][] = [
    ["a release by a person", RELEASED, "human:dev", "forbidden"],
    ["a test consumption by an agent", CONSUMED, "agent:codex", "forbidden"],
    ["a reseal authorization by omf", RESEALED, "omf", "forbidden"],
    ["an extra payload key", mutate(RELEASED, { scenario_id: "canary-7731" }), "omf", "invalid_input"],
    ["a short train digest", mutate(RELEASED, { train_digest: "a".repeat(63) }), "omf", "invalid_input"],
    ["an uppercase test digest", mutate(CONSUMED, { test_digest: "B".repeat(64) }), "omf", "invalid_input"],
    ["a short candidate_sha", mutate(CONSUMED, { candidate_sha: "c".repeat(39) }), "omf", "invalid_input"],
    ["a malformed goal id", mutate(CONSUMED, { goal_id: "G-Fast" }), "omf", "invalid_input"],
    [
      "score_pct 101",
      mutate(RELEASED, { categories: [{ ...category("interface", 10, 10, "first"), score_pct: 101 }] }),
      "omf",
      "invalid_input",
    ],
    [
      "pass above n",
      mutate(RELEASED, { categories: [{ ...category("interface", 5, 4, "first"), pass: 6, score_pct: 100 }] }),
      "omf",
      "invalid_input",
    ],
    [
      "a score_pct that does not match pass and n",
      mutate(RELEASED, { categories: [{ ...category("interface", 10, 4, "first"), score_pct: 41 }] }),
      "omf",
      "invalid_input",
    ],
    [
      "an unknown category",
      mutate(RELEASED, { categories: [{ ...category("interface", 10, 4, "first"), category: "scenarios" }] }),
      "omf",
      "invalid_input",
    ],
    [
      "categories out of class order",
      mutate(RELEASED, { categories: [category("security", 5, 2, "first"), category("interface", 10, 4, "first")] }),
      "omf",
      "invalid_input",
    ],
    [
      "a duplicated category",
      mutate(RELEASED, { categories: [category("interface", 10, 4, "first"), category("interface", 10, 4, "first")] }),
      "omf",
      "invalid_input",
    ],
    ["an empty category list", mutate(RELEASED, { categories: [] }), "omf", "invalid_input"],
    ["units 0 with a new score", mutate(RELEASED, { disclosure_units: 0 }), "omf", "invalid_input"],
    [
      "units 1 with only repeats",
      mutate(RELEASED, { categories: [category("interface", 10, 4, "repeat")], disclosure_units: 1 }),
      "omf",
      "invalid_input",
    ],
    ["a completion with flaky above total minus pass", mutate(COMPLETED, { flaky: 3 }), "omf", "invalid_input"],
    ["a completion with pass above total", mutate(COMPLETED, { pass: 7, flaky: 0 }), "omf", "invalid_input"],
    ["a basis other than J3 or J6", mutate(RESEALED, { basis: "J7" }), "human:dev", "invalid_input"],
  ];
  for (const [name, event, actor, code] of refused) {
    it(`refuses ${name} with ${code}`, () => {
      expect(failure(() => feedbackEvent(event, actor)).code).toBe(code);
    });
  }

  it("never repeats a rejected key or value in the message", () => {
    const err = failure(() => feedbackEvent(mutate(RELEASED, { scenario_id: "canary-7731" }), "omf"));
    expect(err.message).not.toContain("canary-7731");
    expect(err.message).not.toContain("scenario_id");
  });
});

describe("feedbackEventsOf", () => {
  it("returns this goal's feedback events in ledger order and nothing else", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "note.added", payload: { goal_id: GOAL } });
    for (const { actor, event } of SAMPLES) ledger.append(feedbackEvent(event, actor));
    ledger.append(feedbackEvent(mutate(RELEASED, { goal_id: "g-other" }), "omf"));
    const found = feedbackEventsOf(ledger.readVerified(), GOAL);
    expect(found.map((f) => f.event.type)).toEqual([...FEEDBACK_EVENT_TYPES]);
    expect(found.map((f) => f.seq)).toEqual([2, 3, 4, 5]);
  });

  it("ignores an unknown feedback type and a payload whose goal_id is not a string", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "feedback.future_probe", payload: { goal_id: GOAL, junk: 1 } });
    ledger.append({ actor: "omf", type: "feedback.released", payload: { goal_id: 7 } });
    expect(feedbackEventsOf(ledger.readVerified(), GOAL)).toEqual([]);
  });

  it("stops the line of the goal that owns a bad event, and only that goal", () => {
    const ledger = newLedger();
    ledger.append({ actor: "human:dev", type: "feedback.released", payload: { ...payloadOf(RELEASED), goal_id: "g-other" } });
    const events = ledger.readVerified();
    expect(feedbackEventsOf(events, GOAL)).toEqual([]);
    const err = failure(() => feedbackEventsOf(events, "g-other"));
    expect(err.code).toBe("invalid_event");
    expect(err.message).toContain("feedback.released");
    expect(err.message).toContain("seq 1");
  });

  it("throws invalid_event for a wrong actor and for a payload that fails the schema", () => {
    const wrongActor = newLedger();
    wrongActor.append({ actor: "agent:codex", type: "feedback.test_run_consumed", payload: payloadOf(CONSUMED) });
    expect(failure(() => feedbackEventsOf(wrongActor.readVerified(), GOAL)).code).toBe("invalid_event");

    const resealByOmf = newLedger();
    resealByOmf.append({ actor: "omf", type: "feedback.test_reseal_authorized", payload: payloadOf(RESEALED) });
    expect(failure(() => feedbackEventsOf(resealByOmf.readVerified(), GOAL)).code).toBe("invalid_event");

    const extraKey = newLedger();
    extraKey.append({ actor: "omf", type: "feedback.test_run_consumed", payload: { ...payloadOf(CONSUMED), input: "x" } });
    expect(failure(() => feedbackEventsOf(extraKey.readVerified(), GOAL)).code).toBe("invalid_event");

    const badCounts = newLedger();
    badCounts.append({ actor: "omf", type: "feedback.test_run_completed", payload: { ...payloadOf(COMPLETED), flaky: 3 } });
    expect(failure(() => feedbackEventsOf(badCounts.readVerified(), GOAL)).code).toBe("invalid_event");
  });
});
