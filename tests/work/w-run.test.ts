import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { runVeto } from "../../src/cli/work.js";
import { claimFile, claimItem, claimStatus, releaseItem } from "../../src/work/claim.js";
import { OUTCOME_ROWS, type OutcomeInput } from "../../src/work/outcome.js";
import type { WorkItem } from "../../src/work/types.js";
import { wEvent } from "../../src/work/w-events.js";
import { beginRun } from "../../src/work/w-run.js";
import { WError } from "../../src/work/w-verbs.js";
import { setupTickGoal } from "../helpers/goal.js";
import { appendEscalation } from "../helpers/loop-events.js";
import { appendWorkEvent, createRecorded, makeNewItem, rewriteItem } from "../helpers/work.js";

const PERSON = "human:dev@example.com";
const SUCCESS: OutcomeInput = { outcome: "success", exhausted: false, reason_code: null };

/** An approved, running goal g-fast with one ready item. `begin` enters it, `more` adds another. */
function fixture() {
  const fx = setupTickGoal();
  const store = createMarkdownStore(fx.location.dir);
  const item = createRecorded(fx.ledger, store, makeNewItem());
  const id = item.front.work_id;
  const begin = (workId: string = id) => beginRun({ location: fx.location, workId });
  const more = (title: string): WorkItem => createRecorded(fx.ledger, store, makeNewItem({ title }));
  const typesOf = (): string[] => fx.ledger.readVerified().map((event) => event.type);
  const count = (type: string): number => typesOf().filter((t) => t === type).length;
  const stateOf = (workId: string = id) => store.fetchWorkItemsByIds([workId])[0]?.front.state;
  return { ...fx, store, item, id, begin, more, typesOf, count, stateOf };
}
type Fixture = ReturnType<typeof fixture>;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof WError ? err.code : `not a WError: ${String(err)}`;
  }
  return "no error";
}

/** A run that started an item, plus a `work.submitted` event whose file write never happened. */
function crashAfterSubmit(fx: Fixture, title: string): WorkItem {
  const item = fx.more(title);
  const run = fx.begin(item.front.work_id);
  run.start();
  run.abandon();
  fx.ledger.append(
    wEvent({
      type: "work.submitted",
      payload: {
        goal_id: "g-fast",
        work_id: item.front.work_id,
        run_id: run.runId,
        outcome: "success",
        recommendation: "merge_recommended",
      },
    }),
  );
  return item;
}

describe("beginRun and start", () => {
  it("takes the claim and leaves a ready item ready; start() starts it once", () => {
    const fx = fixture();
    const run = fx.begin();
    expect(claimStatus(fx.item.dir)).toMatchObject({ held: true, owner: { pid: process.pid } });
    expect(fx.stateOf()).toBe("ready");
    expect(fx.count("work.started")).toBe(0);
    expect([run.resumed, run.reclaimed, run.repaired]).toEqual([false, null, []]);
    expect(run.runId).toMatch(/^r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/);

    run.start();
    run.start();
    expect(fx.count("work.started")).toBe(1);
    expect(fx.stateOf()).toBe("in_progress");

    run.abandon();
    run.abandon();
    expect(claimStatus(fx.item.dir).held).toBe(false);
  });

  it("refuses a second run while the first lives, and appends nothing", () => {
    const fx = fixture();
    const first = fx.begin();
    const before = fx.typesOf().length;
    expect(codeOf(() => fx.begin())).toBe("claim_held");
    expect(fx.typesOf()).toHaveLength(before);
    expect(first.recheck().ok).toBe(true);
    first.abandon();
  });

  it("writes S3 working into the progress region", () => {
    const fx = fixture();
    const run = fx.begin();
    run.start();
    run.progress({ station: "S3", step: "working" });
    expect(readFileSync(join(fx.item.dir, "item.md"), "utf8")).toContain("S3 working");
    run.abandon();
  });
});

describe("finish", () => {
  it.each([...OUTCOME_ROWS])("applies the table row $outcome / exhausted $exhausted and releases the claim", (row) => {
    const fx = fixture();
    const input: OutcomeInput = {
      outcome: row.outcome,
      exhausted: row.exhausted,
      reason_code: row.outcome === "success" ? null : "station_error",
    };
    const result = fx.begin().finish(input);
    const d = row.disposition;
    expect(result).toMatchObject({ applied: true, disposition: d });
    expect(fx.stateOf()).toBe(d.item_state === "unchanged" ? "ready" : d.item_state);
    const event = d.action === "submit" ? "work.submitted" : d.action === "fail" ? "work.failed" : "work.parked";
    expect(fx.typesOf().at(-1)).toBe(event);
    // a submit or fail on a still-ready item starts it first; a park never does
    expect(fx.count("work.started")).toBe(d.action === "park" ? 0 : 1);
    expect(claimStatus(fx.item.dir).held).toBe(false);
  });

  it("refuses an outcome the table has no row for, and still releases the claim", () => {
    const fx = fixture();
    const run = fx.begin();
    expect(codeOf(() => run.finish({ outcome: "success", exhausted: true, reason_code: null }))).toBe("outcome_invalid");
    expect(claimStatus(fx.item.dir).held).toBe(false);
  });
});

describe("recheck", () => {
  it("reports a veto and a cancel, also before item.md is rewritten, and finish then applies nothing", () => {
    const fx = fixture();
    const run = fx.begin();
    run.start();
    runVeto(fx.location, fx.id, PERSON, "not needed"); // item.lock only, so it succeeds under our claim
    expect(run.recheck()).toEqual({ ok: false, reason: "vetoed", code: null });
    expect(run.finish(SUCCESS)).toEqual({ applied: false, reason: "vetoed", code: null });
    expect(claimStatus(fx.item.dir).held).toBe(false);
    expect(fx.stateOf()).toBe("vetoed");

    // the window: the event reached the ledger and the file write has not happened yet
    const vetoed = fx.more("Trim the logs");
    const second = fx.begin(vetoed.front.work_id);
    appendWorkEvent(fx.ledger, "work.vetoed", PERSON, vetoed, { reason: "late" });
    expect(second.recheck()).toEqual({ ok: false, reason: "vetoed", code: null });
    expect(fx.stateOf(vetoed.front.work_id)).toBe("ready");
    second.abandon();

    const cancelled = fx.more("Warm the cache");
    const third = fx.begin(cancelled.front.work_id);
    appendWorkEvent(fx.ledger, "work.cancelled", "omf", cancelled, { cause: "goal_cancelled" });
    expect(third.recheck()).toEqual({ ok: false, reason: "cancelled", code: null });
    third.abandon();
  });

  it("reports claim_lost when the claim file was replaced, and finish and abandon leave the foreign claim alone", () => {
    const fx = fixture();
    const run = fx.begin();
    run.start();
    const foreign = JSON.stringify({ pid: process.ppid, start_time: null, acquired_at: "2026-10-14T00:00:00.000Z" });
    writeFileSync(claimFile(fx.item.dir), foreign);
    expect(run.recheck()).toEqual({ ok: false, reason: "claim_lost", code: null });
    expect(run.finish(SUCCESS)).toEqual({ applied: false, reason: "claim_lost", code: null });
    run.abandon();
    expect(readFileSync(claimFile(fx.item.dir), "utf8")).toBe(foreign);
    expect(fx.stateOf()).toBe("in_progress");
  });

  it("reports governance after a config edit (no code) and after the config disappears (closed code)", () => {
    const fx = fixture();
    const run = fx.begin();
    appendFileSync(join(fx.location.dir, "config.toml"), "\n# edited by a person\n");
    expect(run.recheck()).toEqual({ ok: false, reason: "governance", code: null });
    rmSync(join(fx.location.dir, "config.toml"));
    expect(run.recheck()).toEqual({ ok: false, reason: "governance", code: "config_unreadable" });
    run.abandon();
  });

  it("reports malformed after a hand edit that the ledger cannot account for", () => {
    const fx = fixture();
    const run = fx.begin();
    run.start();
    rewriteItem(fx.item, { state: "awaiting_review" });
    expect(run.recheck()).toEqual({ ok: false, reason: "malformed", code: null });
    run.abandon();
  });
});

describe("beginRun entry rules", () => {
  it("stops on a goal that is not running, and holds no claim afterwards", () => {
    const fx = fixture();
    appendEscalation(fx.ledger, "g-fast", "J6", "no_progress");
    let message = "";
    try {
      fx.begin();
    } catch (err) {
      expect(err).toBeInstanceOf(WError);
      expect((err as WError).code).toBe("governance");
      message = (err as WError).message;
    }
    expect(message).toContain("goal_stopped");
    expect(claimStatus(fx.item.dir).held).toBe(false);
  });

  it("refuses submitted items and manual parks, and releases the claim each time", () => {
    const fx = fixture();
    fx.begin().finish(SUCCESS);
    expect(codeOf(() => fx.begin())).toBe("wrong_state");
    expect(claimStatus(fx.item.dir).held).toBe(false);

    const parked = fx.more("Trim the logs");
    fx.begin(parked.front.work_id).finish({ outcome: "manual", exhausted: false, reason_code: "manual_required" });
    const before = fx.typesOf().length;
    expect(codeOf(() => fx.begin(parked.front.work_id))).toBe("needs_human");
    expect(claimStatus(parked.dir).held).toBe(false);
    expect(fx.typesOf()).toHaveLength(before);
  });

  it("resumes an item parked after it started: work.resumed with the new run id, no second work.started", () => {
    const fx = fixture();
    const first = fx.begin();
    first.start();
    first.finish({ outcome: "blocked", exhausted: false, reason_code: "budget_exhausted" });
    expect(fx.stateOf()).toBe("in_progress");

    const second = fx.begin();
    expect(second.resumed).toBe(true);
    expect(fx.count("work.started")).toBe(1);
    const resumed = fx.ledger.readVerified().filter((event) => event.type === "work.resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.payload.run_id).toBe(second.runId);
    second.abandon();
  });

  it("reclaims a claim whose process is gone, and the trace survives a later refusal", () => {
    const fx = fixture();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(dead).toBeTypeOf("number");
    const stale = JSON.stringify({ pid: dead, start_time: "x", acquired_at: "2026-10-14T00:00:00.000Z" });
    writeFileSync(claimFile(fx.item.dir), stale);

    const run = fx.begin();
    expect(run.reclaimed).toEqual({ pid: dead });
    const event = fx.ledger.readVerified().filter((e) => e.type === "work.claim_reclaimed");
    expect(event).toHaveLength(1);
    expect(event[0]?.payload).toMatchObject({ previous_pid: dead, previous_acquired_at: "2026-10-14T00:00:00.000Z" });
    run.finish(SUCCESS);

    writeFileSync(claimFile(fx.item.dir), stale); // a second killed run on an item that can no longer be entered
    expect(codeOf(() => fx.begin())).toBe("wrong_state");
    expect(fx.count("work.claim_reclaimed")).toBe(2);
    expect(claimStatus(fx.item.dir).held).toBe(false);
  });

  it("reclaims an unreadable claim file once its grace is over, with a null previous pid", () => {
    const fx = fixture();
    const file = claimFile(fx.item.dir);
    writeFileSync(file, "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(file, old, old);
    const run = fx.begin();
    expect(run.reclaimed).toEqual({ pid: null });
    expect(fx.ledger.readVerified().find((e) => e.type === "work.claim_reclaimed")?.payload).toMatchObject({
      previous_pid: null,
      previous_acquired_at: "",
    });
    run.abandon();
  });
});

describe("the sweep", () => {
  it("heals the goal's other repairable items before it enters, and skips an item under a live claim", () => {
    const fx = fixture();
    const crashed = crashAfterSubmit(fx, "Warm the cache");
    expect(fx.stateOf(crashed.front.work_id)).toBe("in_progress"); // the ledger is one edge ahead

    claimItem(crashed.dir); // a live run owns it: the sweep must leave it alone
    const skipped = fx.begin();
    expect(skipped.repaired).toEqual([]);
    expect(fx.stateOf(crashed.front.work_id)).toBe("in_progress");
    skipped.abandon();
    releaseItem(crashed.dir);

    const healer = fx.begin(); // a different item of the same goal: nobody names the crashed one
    expect(healer.repaired).toEqual([crashed.front.work_id]);
    expect(fx.stateOf(crashed.front.work_id)).toBe("awaiting_review");
    expect(fx.count("work.repaired")).toBe(1);
    expect(claimStatus(crashed.dir).held).toBe(false);
    healer.abandon();
  });
});

describe("closed output", () => {
  it("no WError, Recheck or FinishResult text carries a metric id or a watched path", () => {
    const fx = fixture();
    const other = fx.more("Trim the logs");
    const texts: string[] = [];
    const run = fx.begin();
    try {
      fx.begin();
    } catch (err) {
      texts.push((err as Error).message);
    }
    runVeto(fx.location, fx.id, PERSON, "not needed");
    texts.push(JSON.stringify(run.recheck()), JSON.stringify(run.finish(SUCCESS)));
    appendEscalation(fx.ledger, "g-fast", "J6", "no_progress");
    try {
      fx.begin(other.front.work_id);
    } catch (err) {
      texts.push((err as Error).message);
    }
    expect(texts).toHaveLength(4);
    expect(texts.join("\n")).not.toMatch(/p95|bench|m-errors/);
  });
});
