import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LockOwner } from "../../src/core/lock.js";
import { claimFile } from "../../src/work/claim.js";
import type { ReasonCode } from "../../src/work/w-events.js";
import {
  WError,
  failItem,
  parkItem,
  repairItem,
  setItemProgress,
  startItem,
  submitForReview,
} from "../../src/work/w-verbs.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { W_RUN, type WFixture, setupW, wCodeOf, wMessageOf } from "../helpers/w-verbs-fixture.js";
import { appendWorkEvent } from "../helpers/work.js";

/** A fixture whose item is already in_progress. */
function startedFixture(): WFixture {
  const fx = setupW();
  startItem(fx.ctx, fx.claim, fx.workId, W_RUN);
  return fx;
}

describe("startItem", () => {
  it("appends one omf work.started, then rewrites the file, and the item verifies", () => {
    const fx = setupW();
    const started = startItem(fx.ctx, fx.claim, fx.workId, W_RUN);
    expect(started.front.state).toBe("in_progress");
    expect(fx.fresh().front.state).toBe("in_progress");
    expect(fx.events().map((event) => event.type)).toEqual(["work.created", "work.started"]);
    expect(fx.events().at(-1)).toMatchObject({
      actor: "omf",
      type: "work.started",
      payload: { ...fx.scope, from: "ready" },
    });
    expect(fx.verdict()).toEqual({ ok: true });
  });

  it("has the event in the ledger before the store verb runs", () => {
    const fx = setupW();
    const seen: number[] = [];
    const spying = {
      ...fx.store,
      startWorkItem: (id: string, now: Date) => {
        seen.push(fx.events().length);
        return fx.store.startWorkItem(id, now);
      },
    };
    startItem({ ...fx.ctx, store: spying }, fx.claim, fx.workId, W_RUN);
    expect(seen).toEqual([2]);
  });

  it("leaves a ledger the verifier accepts when the file write loses a race with a veto", () => {
    const fx = setupW();
    const racing = {
      ...fx.store,
      startWorkItem: (id: string, now: Date) => {
        appendWorkEvent(fx.ledger, "work.vetoed", "human:dev", fx.item, { reason: "stop" });
        fx.store.vetoWorkItem(id, "human:dev", "stop", now);
        return fx.store.startWorkItem(id, now);
      },
    };
    expect(() => startItem({ ...fx.ctx, store: racing }, fx.claim, fx.workId, W_RUN)).toThrow();
    expect(fx.fresh().front.state).toBe("vetoed");
    expect(fx.events().map((event) => event.type)).toEqual(["work.created", "work.started", "work.vetoed"]);
    expect(fx.verdict()).toEqual({ ok: true });
  });

  for (const [type, actor, extra] of [
    ["work.vetoed", "human:dev", { reason: "no" }],
    ["work.cancelled", "omf", { cause: "goal_cancelled" }],
  ] as const) {
    it(`refuses an item whose ${type} is in the ledger but not yet in item.md`, () => {
      const fx = setupW();
      appendWorkEvent(fx.ledger, type, actor, fx.item, extra);
      const before = fx.ledgerText();
      expect(() => startItem(fx.ctx, fx.claim, fx.workId, W_RUN)).toThrow(WError);
      expect(fx.ledgerText()).toBe(before);
      expect(fx.fresh().front.state).toBe("ready");

      const running = startedFixture();
      appendWorkEvent(running.ledger, type, actor, running.item, extra);
      const runningBefore = running.ledgerText();
      expect(() => submitForReview(running.ctx, running.claim, running.workId, W_RUN, "success")).toThrow(WError);
      expect(running.ledgerText()).toBe(runningBefore);
      expect(running.fresh().front.state).toBe("in_progress");
    });
  }
});

describe("submitForReview", () => {
  const cases: [string, "success" | "flawed", boolean, string][] = [
    ["success", "success", false, "merge_recommended"],
    ["flawed", "flawed", false, "not_recommended"],
    ["success that needs a person", "success", true, "human_needed"],
  ];
  for (const [name, outcome, humanNeeded, recommendation] of cases) {
    it(`derives ${recommendation} from a ${name}`, () => {
      const fx = startedFixture();
      const submitted = submitForReview(fx.ctx, fx.claim, fx.workId, W_RUN, outcome, humanNeeded);
      expect(submitted.front.state).toBe("awaiting_review");
      const event = fx.events().at(-1);
      expect(event).toMatchObject({
        actor: "omf",
        type: "work.submitted",
        payload: { ...fx.scope, outcome, recommendation },
      });
      expect(event?.payload).not.toHaveProperty("reason_code");
      expect(fx.verdict()).toEqual({ ok: true });
    });
  }

  it("refuses human_needed on a flawed outcome and an outcome that is not a submission", () => {
    const fx = startedFixture();
    const before = fx.ledgerText();
    expect(wCodeOf(() => submitForReview(fx.ctx, fx.claim, fx.workId, W_RUN, "flawed", true))).toBe("outcome_invalid");
    expect(wCodeOf(() => submitForReview(fx.ctx, fx.claim, fx.workId, W_RUN, "blocked" as unknown as "flawed"))).toBe(
      "outcome_invalid",
    );
    expect(fx.ledgerText()).toBe(before);
    expect(fx.fresh().front.state).toBe("in_progress");
  });
});

describe("failItem and parkItem", () => {
  it("failItem records the closed reason code and moves in_progress to failed", () => {
    const fx = startedFixture();
    const failed = failItem(fx.ctx, fx.claim, fx.workId, W_RUN, { outcome: "blocked", reason_code: "infra_failure" });
    expect(failed.front.state).toBe("failed");
    expect(fx.events().at(-1)).toMatchObject({
      actor: "omf",
      type: "work.failed",
      payload: { ...fx.scope, outcome: "blocked", reason_code: "infra_failure" },
    });
    expect(fx.verdict()).toEqual({ ok: true });
  });

  it("failItem refuses a ready item, because a failure needs a started item", () => {
    const fx = setupW();
    const before = fx.ledgerText();
    expect(
      wCodeOf(() =>
        failItem(fx.ctx, fx.claim, fx.workId, W_RUN, { outcome: "flawed", reason_code: "budget_exhausted" }),
      ),
    ).toBe("wrong_state");
    expect(fx.ledgerText()).toBe(before);
  });

  it("parkItem appends only an event and leaves item.md byte-identical, from ready and from in_progress", () => {
    const ready = setupW();
    const readyText = ready.itemText();
    const parked = parkItem(ready.ctx, ready.claim, ready.workId, W_RUN, {
      outcome: "blocked",
      reason_code: "j2_open",
    });
    expect(parked.front.state).toBe("ready");
    expect(ready.itemText()).toBe(readyText);
    expect(ready.events().at(-1)).toMatchObject({
      actor: "omf",
      type: "work.parked",
      payload: { ...ready.scope, outcome: "blocked", reason_code: "j2_open" },
    });
    expect(ready.verdict()).toEqual({ ok: true });

    const running = startedFixture();
    const runningText = running.itemText();
    parkItem(running.ctx, running.claim, running.workId, W_RUN, { outcome: "manual", reason_code: "manual_required" });
    expect(running.itemText()).toBe(runningText);
    expect(running.fresh().front.state).toBe("in_progress");
    expect(running.verdict()).toEqual({ ok: true });
  });
});

describe("claim proof", () => {
  const calls: [string, (fx: WFixture, claim: LockOwner) => unknown][] = [
    ["startItem", (fx, claim) => startItem(fx.ctx, claim, fx.workId, W_RUN)],
    ["submitForReview", (fx, claim) => submitForReview(fx.ctx, claim, fx.workId, W_RUN, "success")],
    [
      "failItem",
      (fx, claim) => failItem(fx.ctx, claim, fx.workId, W_RUN, { outcome: "blocked", reason_code: "infra_failure" }),
    ],
    [
      "parkItem",
      (fx, claim) => parkItem(fx.ctx, claim, fx.workId, W_RUN, { outcome: "blocked", reason_code: "j2_open" }),
    ],
    ["repairItem", (fx, claim) => repairItem(fx.ctx, claim, fx.workId, W_RUN)],
    ["setItemProgress", (fx, claim) => setItemProgress(fx.ctx, claim, fx.workId, { station: "S3", step: "working" })],
  ];
  const lost: [string, (fx: WFixture) => LockOwner][] = [
    ["a token that differs from the claim file", (fx) => ({ ...fx.claim, acquired_at: "2026-10-12T00:00:00.000Z" })],
    [
      "a claim file that is gone",
      (fx) => {
        rmSync(claimFile(fx.item.dir));
        return fx.claim;
      },
    ],
  ];
  for (const [verb, call] of calls) {
    it(`${verb} throws claim_lost and writes nothing without a valid claim`, () => {
      for (const [name, forge] of lost) {
        const fx = setupW();
        const token = forge(fx);
        const ledgerBefore = fx.ledgerText();
        const itemBefore = fx.itemText();
        expect(
          wCodeOf(() => call(fx, token)),
          name,
        ).toBe("claim_lost");
        expect(fx.ledgerText(), name).toBe(ledgerBefore);
        expect(fx.itemText(), name).toBe(itemBefore);
      }
    });
  }
});

describe("setItemProgress", () => {
  const bad = (station: string, step: string): Parameters<typeof setItemProgress>[3] =>
    ({ station, step }) as unknown as Parameters<typeof setItemProgress>[3];

  it("renders OMF's own marker without a ledger event and refuses anything outside the closed lists", () => {
    const fx = startedFixture();
    const length = fx.events().length;
    setItemProgress(fx.ctx, fx.claim, fx.workId, { station: "S3", step: "working" });
    expect(fx.fresh().progress.trim()).toBe("S3 working");
    expect(fx.events()).toHaveLength(length);
    for (const progress of [
      bad("S3", CANARY.metricId),
      bad("S9", "working"),
      bad("S3", "p95 over 40"),
      bad("S3", "working\nS4"),
    ]) {
      expect(wCodeOf(() => setItemProgress(fx.ctx, fx.claim, fx.workId, progress))).toBe("outcome_invalid");
    }
    expect(fx.fresh().progress.trim()).toBe("S3 working");
  });

  it("refuses an item that is not in_progress", () => {
    const fx = setupW();
    expect(wCodeOf(() => setItemProgress(fx.ctx, fx.claim, fx.workId, { station: "S1", step: "entered" }))).toBe(
      "wrong_state",
    );
  });
});

describe("error text", () => {
  it("never copies a planted string into an error message", () => {
    const fx = setupW();
    const planted: string = CANARY.metricId;
    const calls: (() => unknown)[] = [
      () => startItem(fx.ctx, fx.claim, planted, W_RUN),
      () => startItem(fx.ctx, fx.claim, fx.workId, planted),
      () => failItem(fx.ctx, fx.claim, fx.workId, W_RUN, { outcome: "blocked", reason_code: planted as ReasonCode }),
      () => parkItem(fx.ctx, fx.claim, fx.workId, W_RUN, { outcome: "manual", reason_code: planted as ReasonCode }),
      () => setItemProgress(fx.ctx, fx.claim, fx.workId, { station: "S3", step: planted as "working" }),
      () => setItemProgress(fx.ctx, fx.claim, fx.workId, { station: planted as "S3", step: "working" }),
    ];
    const ledgerBefore = fx.ledgerText();
    for (const call of calls) {
      expect(wCodeOf(call)).not.toBe("no error");
      expect(wCodeOf(call)).not.toBe("other error");
      expect(canaryHits(wMessageOf(call))).toEqual([]);
    }
    expect(fx.ledgerText()).toBe(ledgerBefore);
  });
});
