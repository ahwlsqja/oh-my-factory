import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declareBudget } from "../../src/core/budget.js";
import { Ledger, type NewEvent } from "../../src/core/ledger.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import { DECISION_CLASSES } from "../../src/decision/types.js";
import {
  FEEDBACK_EVENT_TYPES,
  type FeedbackEvent,
  exposureCountFor,
  exposureUnitsOf,
  feedbackEvent,
  feedbackEventsOf,
  ladderStateFromEvents,
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

const OTHER_WORK = "w-ba9876543210";
const TRAIN_2 = "d".repeat(64);
const TRAIN_3 = "e".repeat(64);

const FIRST = [category("interface", 10, 4, "first"), category("security", 5, 2, "first")];
const REPEAT = [category("interface", 10, 4, "repeat"), category("security", 5, 2, "repeat")];
const BIG_FIRST = [category("interface", 110, 1, "first")];

/** A disclosure ledger: the budget is declared by a person, as releaseFeedback (Task 5) requires. */
function openLedger(): Ledger {
  const ledger = newLedger();
  declareBudget(ledger, GOAL, "disclosure", 50, "human:dev");
  return ledger;
}

interface Release {
  round: number;
  categories: ReleasedCategory[];
  digest?: string;
  work?: string;
  goal?: string;
  units?: 0 | 1;
  /** Write the budget.consumed unit right before the release (default: iff units is 1). */
  paid?: boolean;
}

/**
 * Writes one feedback.released event the way releaseFeedback will (the disclosure unit first, adjacent, in one
 * append), but through raw NewEvents, so a test can also plant a forged one the writer would refuse.
 */
function release(ledger: Ledger, r: Release): void {
  const goal = r.goal ?? GOAL;
  const units = r.units ?? (r.categories.some((c) => c.kind !== "repeat") ? 1 : 0);
  const event: NewEvent = {
    actor: "omf",
    type: "feedback.released",
    payload: {
      goal_id: goal,
      work_id: r.work ?? WORK,
      run_id: RUN,
      train_digest: r.digest ?? TRAIN,
      round: r.round,
      categories: r.categories,
      disclosure_units: units,
    },
  };
  const unit: NewEvent = { actor: "omf", type: "budget.consumed", payload: { goal_id: goal, kind: "disclosure", amount: 1 } };
  ledger.appendWithMany(() => ((r.paid ?? units === 1) ? [unit, event] : [event]));
}

const stateOf = (ledger: Ledger, digest = TRAIN) => ladderStateFromEvents(ledger.readVerified(), GOAL, digest);

describe("ladderStateFromEvents", () => {
  it("is empty on an empty ledger", () => {
    expect(ladderStateFromEvents([], GOAL, TRAIN)).toEqual({ best: new Map(), releases: 0, layout: null });
  });

  it("folds first, repeat and new releases into best, count and layout", () => {
    const ledger = openLedger();
    release(ledger, { round: 1, categories: FIRST });
    release(ledger, { round: 2, categories: REPEAT });
    // interface 4 -> 8 of 10: d = 4, 10*4 >= 10 and 4*4 >= 10, so new; security stays a repeat.
    release(ledger, { round: 3, categories: [category("interface", 10, 8, "new"), category("security", 5, 2, "repeat")] });
    const state = stateOf(ledger);
    expect(state.releases).toBe(3);
    expect([...state.best]).toEqual([
      ["interface", { pass: 8, n: 10 }],
      ["security", { pass: 2, n: 5 }],
    ]);
    expect(state.layout).toEqual({
      work_id: WORK,
      categories: [
        { category: "interface", n: 10 },
        { category: "security", n: 5 },
      ],
    });
  });

  it("accepts the smallest passing gain at n=110 (d=11; d=10 is refused below)", () => {
    const ok = openLedger();
    release(ok, { round: 1, categories: BIG_FIRST });
    release(ok, { round: 2, categories: [category("interface", 110, 12, "new")] }); // d = 11
    expect(stateOf(ok).best.get("interface")).toEqual({ pass: 12, n: 110 });
  });

  it("does not mix another goal or another digest into the state", () => {
    const ledger = openLedger();
    release(ledger, { round: 1, categories: FIRST });
    release(ledger, { round: 1, categories: FIRST, digest: TRAIN_2 });
    release(ledger, { round: 1, categories: FIRST, goal: "g-other" });
    expect(stateOf(ledger).releases).toBe(1);
    expect(stateOf(ledger, TRAIN_2).releases).toBe(1);
    expect(stateOf(ledger, TRAIN_3)).toEqual({ best: new Map(), releases: 0, layout: null });
  });

  it("gives the same state after a restart (a new Ledger over the same directory)", () => {
    const ledger = openLedger();
    release(ledger, { round: 1, categories: FIRST });
    release(ledger, { round: 2, categories: REPEAT });
    expect(ladderStateFromEvents(new Ledger(ledger.dir).readVerified(), GOAL, TRAIN)).toEqual(stateOf(ledger));
  });

  const forged: [string, (ledger: Ledger) => void][] = [
    [
      "a round gap",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 3, categories: REPEAT });
      },
    ],
    [
      "a new score below the margin (n=110, d=10)",
      (l) => {
        release(l, { round: 1, categories: BIG_FIRST });
        release(l, { round: 2, categories: [category("interface", 110, 11, "new")] });
      },
    ],
    [
      "a new score that is a decrease",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: [category("interface", 10, 2, "new"), category("security", 5, 2, "repeat")] });
      },
    ],
    [
      "a repeat with a different pass",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: [category("interface", 10, 5, "repeat"), category("security", 5, 2, "repeat")] });
      },
    ],
    [
      "a first when a best exists",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: FIRST });
      },
    ],
    [
      "disclosure_units 1 on a release of only repeats",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: REPEAT, units: 1 });
      },
    ],
    [
      "disclosure_units 0 on a release with a new score",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: [category("interface", 10, 8, "new"), category("security", 5, 2, "repeat")], units: 0 });
      },
    ],
    ["a new score without its consumption", (l) => release(l, { round: 1, categories: FIRST, paid: false })],
    [
      "a consumption that is not adjacent",
      (l) => {
        l.append({ actor: "omf", type: "budget.consumed", payload: { goal_id: GOAL, kind: "disclosure", amount: 1 } });
        l.append({ actor: "omf", type: "note.added", payload: {} });
        release(l, { round: 1, categories: FIRST, paid: false });
      },
    ],
    [
      "a different work item under one digest",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: REPEAT, work: OTHER_WORK });
      },
    ],
    [
      "a different category set under one digest",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: [category("interface", 10, 4, "repeat")] });
      },
    ],
    [
      "a different n under one digest",
      (l) => {
        release(l, { round: 1, categories: FIRST });
        release(l, { round: 2, categories: [category("interface", 11, 4, "repeat"), category("security", 5, 2, "repeat")] });
      },
    ],
  ];
  for (const [name, setup] of forged) {
    it(`throws invalid_event for ${name}`, () => {
      const ledger = openLedger();
      setup(ledger);
      expect(failure(() => stateOf(ledger)).code).toBe("invalid_event");
    });
  }
});

describe("exposureUnitsOf", () => {
  const reseal = (basis: "J3" | "J6", consumed: string | null): NewEvent =>
    feedbackEvent(
      { type: "feedback.test_reseal_authorized", payload: { goal_id: GOAL, work_id: WORK, consumed_test_digest: consumed, basis } },
      "human:dev",
    );
  const count = (ledger: Ledger, work = WORK): number => exposureUnitsOf(ledger.readVerified(), GOAL, work);

  it("counts new-score releases of one work item across digests, and restarts only after a J3 act", () => {
    const ledger = openLedger();
    expect(count(ledger)).toBe(0);
    release(ledger, { round: 1, categories: FIRST }); // units 1
    release(ledger, { round: 2, categories: REPEAT }); // units 0: a repeat costs no exposure
    expect(count(ledger)).toBe(1);

    // A digest change alone (a scenario was added or retired) must not reset the count.
    release(ledger, { round: 1, categories: FIRST, digest: TRAIN_2 });
    expect(count(ledger)).toBe(2);

    // Another work item of the same goal has its own count.
    release(ledger, { round: 1, categories: FIRST, work: OTHER_WORK, digest: TRAIN_3 });
    expect(count(ledger)).toBe(2);
    expect(count(ledger, OTHER_WORK)).toBe(1);

    // J6 (the budget was raised) does not restart it; J3 (fresh scenarios) does.
    ledger.append(reseal("J6", TEST));
    expect(count(ledger)).toBe(2);
    ledger.append(reseal("J3", null));
    expect(count(ledger)).toBe(0);
    expect(count(ledger, OTHER_WORK)).toBe(1);

    release(ledger, { round: 2, categories: [category("interface", 10, 8, "new"), category("security", 5, 2, "repeat")], digest: TRAIN_2 });
    expect(count(ledger)).toBe(1);
  });

  it("gives the same count after a restart", () => {
    const ledger = openLedger();
    release(ledger, { round: 1, categories: FIRST });
    expect(exposureUnitsOf(new Ledger(ledger.dir).readVerified(), GOAL, WORK)).toBe(1);
  });
});

describe("exposureCountFor", () => {
  const reseal = (basis: "J3" | "J6", consumed: string | null): NewEvent =>
    feedbackEvent(
      { type: "feedback.test_reseal_authorized", payload: { goal_id: GOAL, work_id: WORK, consumed_test_digest: consumed, basis } },
      "human:dev",
    );

  it("supplies M3c's ExposureCount: the (goal, work item) count for any split and digest", () => {
    const ledger = openLedger();
    const countFor = (work = WORK) => exposureCountFor(ledger.readVerified(), GOAL, work);
    expect(countFor()({ split: "train", digest: TRAIN })).toBe(0);
    release(ledger, { round: 1, categories: FIRST });
    release(ledger, { round: 1, categories: FIRST, digest: TRAIN_2 });
    release(ledger, { round: 2, categories: REPEAT, digest: TRAIN_2 }); // a repeat costs no exposure
    const count = countFor();
    expect(count({ split: "train", digest: TRAIN })).toBe(2);
    expect(count({ split: "train", digest: TRAIN_2 })).toBe(2);
    expect(count({ split: "test", digest: TEST })).toBe(2);
    expect(count({ split: "train", digest: "f".repeat(64) })).toBe(2);
    expect(countFor(OTHER_WORK)({ split: "train", digest: TRAIN })).toBe(0);
    expect(count({ split: "train", digest: TRAIN })).toBe(exposureUnitsOf(ledger.readVerified(), GOAL, WORK));
    ledger.append(reseal("J3", null));
    expect(countFor()({ split: "train", digest: TRAIN })).toBe(0);
  });

  it("is a snapshot: a later release does not change a function already built", () => {
    const ledger = openLedger();
    const before = exposureCountFor(ledger.readVerified(), GOAL, WORK);
    release(ledger, { round: 1, categories: FIRST });
    expect(before({ split: "train", digest: TRAIN })).toBe(0);
    expect(exposureCountFor(ledger.readVerified(), GOAL, WORK)({ split: "train", digest: TRAIN })).toBe(1);
  });
});
