import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimItem, claimStatus, releaseItem } from "../../src/work/claim.js";
import { verifiedItems } from "../../src/work/ledger-verify.js";
import { omf } from "../helpers/cli.js";
import { TICK_GOAL, ledgerEvents, seedWorkItem, setupTick } from "../helpers/tick.js";
import { begin, crashAfter, itemDirOf, startOnly, stateOf, verdictOf, wTrail } from "../helpers/w-flow.js";

// Spec §6.2 and §8, D27: the ledger event is written before the file, so a crash leaves a file exactly one
// W edge behind the ledger. That is the one mismatch the verifier repairs; every W entry heals it, nobody
// has to name the item. The read-only commands only report it. (The label `work list` prints for it is
// covered in tests/cli/work-cli.test.ts; here only the exit code and the id are pinned.)
describe("W-ledger-ahead-repair", () => {
  it("work list flags a file behind the ledger, exits 1 and changes nothing", () => {
    const fx = setupTick();
    const workId = seedWorkItem(fx, { title: "Crashed after submit" });
    startOnly(fx, workId);
    crashAfter(fx, workId, "submitted");
    const itemFile = join(itemDirOf(fx, workId), "item.md");
    const bytes = readFileSync(itemFile, "utf8");
    const events = ledgerEvents(fx).length;

    const run = omf(["work", "list", TICK_GOAL], fx.repo, fx.home);

    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain(workId);
    expect(readFileSync(itemFile, "utf8")).toBe(bytes);
    expect(ledgerEvents(fx).length).toBe(events);
    expect(verifiedItems(fx.store, ledgerEvents(fx), TICK_GOAL).repairable).toMatchObject([
      { work_id: workId, file_state: "in_progress", repair_to: "awaiting_review" },
    ]);
  });

  it("a run on another item of the goal heals it under its own claim, without anyone naming it", () => {
    const fx = setupTick();
    const crashed = seedWorkItem(fx, { title: "Crashed after submit" });
    startOnly(fx, crashed);
    const seq = crashAfter(fx, crashed, "submitted");
    const other = seedWorkItem(fx, { title: "Unrelated item" });
    expect(stateOf(fx, crashed)).toBe("in_progress"); // before: the file is behind the ledger

    const run = begin(fx, other);
    run.abandon();

    expect(run.repaired).toEqual([crashed]);
    expect(stateOf(fx, crashed)).toBe("awaiting_review");
    const trail = wTrail(fx, crashed);
    expect(trail.map((event) => event.type)).toEqual(["work.started", "work.submitted", "work.repaired"]);
    expect(trail[2]?.payload).toMatchObject({ from: "in_progress", to: "awaiting_review", source_seq: seq });
    expect(verdictOf(fx, crashed)).toEqual({ ok: true });
    expect(claimStatus(itemDirOf(fx, crashed)).held).toBe(false);

    // Healing is idempotent: the next entry finds nothing to do.
    const again = begin(fx, other);
    again.abandon();
    expect(again.repaired).toEqual([]);
    expect(wTrail(fx, crashed)).toHaveLength(3);
  });

  it("a run on the item itself repairs it, records work.repaired, then continues", () => {
    const fx = setupTick();
    const workId = seedWorkItem(fx, { title: "Crashed after start" });
    crashAfter(fx, workId, "started");
    expect(stateOf(fx, workId)).toBe("ready"); // before: the ledger says in_progress

    const run = begin(fx, workId);

    expect(run.repaired).toEqual([workId]);
    expect(run.resumed).toBe(true);
    expect(wTrail(fx, workId).map((event) => event.type)).toEqual(["work.started", "work.repaired", "work.resumed"]);
    expect(stateOf(fx, workId)).toBe("in_progress");
    expect(verdictOf(fx, workId)).toEqual({ ok: true });
    run.abandon();
  });

  it("leaves a repairable item alone while a live claim holds it, and heals it once the claim is gone", () => {
    const fx = setupTick();
    const crashed = seedWorkItem(fx, { title: "Crashed after submit" });
    startOnly(fx, crashed);
    crashAfter(fx, crashed, "submitted");
    const other = seedWorkItem(fx, { title: "Unrelated item" });
    claimItem(itemDirOf(fx, crashed)); // this process is alive, so the claim is live

    const first = begin(fx, other);
    first.abandon();

    expect(first.repaired).toEqual([]);
    expect(stateOf(fx, crashed)).toBe("in_progress");
    expect(wTrail(fx, crashed).map((event) => event.type)).toEqual(["work.started", "work.submitted"]);

    releaseItem(itemDirOf(fx, crashed));
    const second = begin(fx, other);
    second.abandon();
    expect(second.repaired).toEqual([crashed]);
    expect(stateOf(fx, crashed)).toBe("awaiting_review");
  });
});
