import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore, findWorkItem, workItemDir } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { runVeto, runWorkApprove } from "../../src/cli/work.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { verifiedItems } from "../../src/work/ledger-verify.js";
import { wEvent } from "../../src/work/w-events.js";
import { omf } from "../helpers/cli.js";
import { type GoalFixture, setupGoal } from "../helpers/goal.js";
import { gitIn } from "../helpers/tmp.js";
import { HIGH_RISK, createRecorded, makeNewItem, recordW, rewriteItem } from "../helpers/work.js";

function fixture(options: { email?: boolean } = {}): GoalFixture & { store: ReturnType<typeof createMarkdownStore> } {
  const fx = setupGoal();
  if (options.email !== false) gitIn(fx.repo, "config", "user.email", "dev@example.com");
  return { ...fx, store: createMarkdownStore(fx.location.dir) };
}

const eventsOf = (fx: GoalFixture, type: string) =>
  new Ledger(fx.location.dir).readVerified().filter((e) => e.type === type);

describe("omf work list", () => {
  it("lists a goal's items, filters by state and prints JSON", () => {
    const fx = fixture();
    const ready = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Cache the render path" }));
    const gated = createRecorded(
      fx.ledger,
      fx.store,
      makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }),
    );
    const all = omf(["work", "list", "g-fast"], fx.repo, fx.home);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain(`${ready.front.work_id}  ready`);
    expect(all.stdout).toContain(`${gated.front.work_id}  awaiting_approval`);

    const only = omf(["work", "list", "g-fast", "--state", "awaiting_approval"], fx.repo, fx.home);
    expect(only.stdout).toContain(gated.front.work_id);
    expect(only.stdout).not.toContain(ready.front.work_id);

    const json = JSON.parse(omf(["work", "list", "g-fast", "--json"], fx.repo, fx.home).stdout) as {
      items: { work_id: string }[];
      malformed: unknown[];
    };
    expect(json.items.map((item) => item.work_id).sort()).toEqual([ready.front.work_id, gated.front.work_id].sort());
    expect(json.malformed).toEqual([]);
  });

  it("says so when the goal has no items, and rejects an unknown state", () => {
    const fx = fixture();
    expect(omf(["work", "list", "g-fast"], fx.repo, fx.home).stdout).toContain("no work items");
    const bad = omf(["work", "list", "g-fast", "--state", "paused"], fx.repo, fx.home);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown state paused");
  });

  it("reports an unparseable item.md as malformed and exits 1", () => {
    const fx = fixture();
    const ok = createRecorded(fx.ledger, fx.store, makeNewItem());
    const junk = workItemDir(fx.location.dir, "g-fast", "w-0123456789ab");
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, "item.md"), "not a work item");
    const result = omf(["work", "list", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("malformed w-0123456789ab: item.md unreadable");
    expect(result.stdout).toContain(ok.front.work_id);
    expect(result.stderr).toContain("1 malformed work item(s)");
  });

  it("reports a hand-approved item as malformed, with the ledger reason, and does not list it as ready", () => {
    const fx = fixture();
    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ risk: HIGH_RISK }));
    rewriteItem(gated, { state: "ready" });
    const result = omf(["work", "list", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`malformed ${gated.front.work_id}: approval_unrecorded`);
    expect(result.stdout).not.toContain(`${gated.front.work_id}  ready`);
    const ready = omf(["work", "list", "g-fast", "--state", "ready"], fx.repo, fx.home);
    expect(ready.stdout).not.toContain(`${gated.front.work_id}  `);
  });
});

describe("omf work show", () => {
  it("prints the ledger verdict, item.md and intent.md", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Cache the render path" }));
    const result = omf(["work", "show", item.front.work_id], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`work ${item.front.work_id} (ready) of goal g-fast`);
    expect(result.stdout).toContain("ledger: consistent");
    expect(result.stdout).toContain("state: ready");
    expect(result.stdout).toContain("# Intent: Cache the render path");
  });

  it("flags an item the ledger does not account for", () => {
    const fx = fixture();
    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ risk: HIGH_RISK }));
    rewriteItem(gated, { state: "ready" });
    const result = omf(["work", "show", gated.front.work_id], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ledger: MALFORMED (approval_unrecorded)");
  });

  it("exits 2 for an unknown or invalid id", () => {
    const fx = fixture();
    const unknown = omf(["work", "show", "w-ffffffffffff"], fx.repo, fx.home);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown work item w-ffffffffffff");
    const invalid = omf(["work", "show", "nope"], fx.repo, fx.home);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("invalid work id nope");
  });
});

describe("omf work approve", () => {
  it("refuses without an interactive terminal and changes nothing", () => {
    const fx = fixture();
    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ risk: HIGH_RISK }));
    const before = new Ledger(fx.location.dir).readVerified().length;
    const result = omf(["work", "approve", gated.front.work_id], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("work approval needs an interactive terminal; nothing was done");
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
    expect(findWorkItem(fx.location.dir, gated.front.work_id)?.front.state).toBe("awaiting_approval");
  });
});

describe("runWorkApprove", () => {
  it("records the approval in the ledger first, then opens the item, and the result verifies", () => {
    const fx = fixture();
    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ risk: HIGH_RISK }));
    const approved = runWorkApprove(
      fx.location,
      gated.front.work_id,
      "human:dev@example.com",
      new Date("2026-10-12T12:00:00.000Z"),
    );
    expect(approved.front.state).toBe("ready");
    expect(approved.front.approval).toEqual({
      approved_by: "human:dev@example.com",
      approved_at: "2026-10-12T12:00:00.000Z",
    });
    const [event] = eventsOf(fx, "work.approved");
    expect(event).toMatchObject({
      actor: "human:dev@example.com",
      payload: { goal_id: "g-fast", work_id: gated.front.work_id },
    });
    const verified = verifiedItems(fx.store, new Ledger(fx.location.dir).readVerified(), "g-fast");
    expect(verified.items.map((item) => item.front.state)).toEqual(["ready"]);
    expect(verified.malformed).toEqual([]);
  });

  it("finishes an approval that was recorded but never applied (crash between event and file)", () => {
    const fx = fixture();
    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ risk: HIGH_RISK }));
    fx.ledger.append({
      actor: "human:dev@example.com",
      type: "work.approved",
      payload: { goal_id: "g-fast", work_id: gated.front.work_id },
    });
    expect(runWorkApprove(fx.location, gated.front.work_id, "human:dev@example.com").front.state).toBe("ready");
  });

  it("refuses a non-person, an item that is not waiting, and an item the ledger does not account for, appending nothing", () => {
    const fx = fixture();
    const ready = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Cache the render path" }));
    const gated = createRecorded(
      fx.ledger,
      fx.store,
      makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }),
    );
    const before = new Ledger(fx.location.dir).readVerified().length;
    expect(() => runWorkApprove(fx.location, gated.front.work_id, "omf")).toThrow(/human actor/);
    expect(() => runWorkApprove(fx.location, ready.front.work_id, "human:dev")).toThrow(/only awaiting_approval/);
    rewriteItem(gated, { risk: { ...gated.front.risk, class: "normal" } });
    expect(() => runWorkApprove(fx.location, gated.front.work_id, "human:dev")).toThrow(/malformed \(risk_mismatch\)/);
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
  });
});

describe("omf veto", () => {
  it("vetoes without a terminal as the git user, recording the reason in the ledger", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    const result = omf(["veto", item.front.work_id, "--reason", "wrong direction"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`vetoed ${item.front.work_id} (was ready)`);
    const [event] = eventsOf(fx, "work.vetoed");
    expect(event).toMatchObject({
      actor: "human:dev@example.com",
      payload: { goal_id: "g-fast", work_id: item.front.work_id, reason: "wrong direction" },
    });
    const stored = findWorkItem(fx.location.dir, item.front.work_id);
    expect(stored?.front.state).toBe("vetoed");
    expect(stored?.front.veto?.reason).toBe("wrong direction");
  });

  it("defaults the reason and vetoes an item awaiting approval", () => {
    const fx = fixture();
    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ risk: HIGH_RISK }));
    expect(omf(["veto", gated.front.work_id], fx.repo, fx.home).code).toBe(0);
    expect(findWorkItem(fx.location.dir, gated.front.work_id)?.front.veto?.reason).toBe("vetoed");
  });

  it("succeeds while another process holds the claim, and says so", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    recordW(fx.ledger, "work.started", item);
    rewriteItem(item, { state: "in_progress" });
    claimItem(item.dir);
    const result = omf(["veto", item.front.work_id], fx.repo, fx.home);
    releaseItem(item.dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`vetoed ${item.front.work_id} (was in_progress)`);
    expect(result.stdout).toContain(`a run holds the claim (pid ${process.pid})`);
  });

  it("refuses an item that is already finished, appending nothing", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    expect(omf(["veto", item.front.work_id], fx.repo, fx.home).code).toBe(0);
    const before = new Ledger(fx.location.dir).readVerified().length;
    const again = omf(["veto", item.front.work_id], fx.repo, fx.home);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain(`work item ${item.front.work_id} is already vetoed; nothing to veto`);
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
  });

  it("rejects a reason over 500 characters, an unknown item and a missing git identity, appending nothing", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    const before = new Ledger(fx.location.dir).readVerified().length;
    const long = omf(["veto", item.front.work_id, "--reason", "x".repeat(501)], fx.repo, fx.home);
    expect(long.code).toBe(2);
    expect(long.stderr).toContain("veto reason must be 1 to 500 characters");
    const unknown = omf(["veto", "w-ffffffffffff"], fx.repo, fx.home);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown work item w-ffffffffffff");
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);

    const anonymous = fixture({ email: false });
    const other = createRecorded(anonymous.ledger, anonymous.store, makeNewItem());
    const noEmail = omf(["veto", other.front.work_id], anonymous.repo, anonymous.home);
    expect(noEmail.code).toBe(2);
    expect(noEmail.stderr).toMatch(/user\.email/);
    expect(findWorkItem(anonymous.location.dir, other.front.work_id)?.front.state).toBe("ready");
  });
});

describe("runVeto", () => {
  it("returns the previous state and the claim it vetoed under", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    claimItem(item.dir);
    const result = runVeto(fx.location, item.front.work_id, "human:dev@example.com", "  stop  ");
    releaseItem(item.dir);
    expect(result.previous).toBe("ready");
    expect(result.claim.held).toBe(true);
    expect(result.item.front.veto?.reason).toBe("stop");
    expect(() => runVeto(fx.location, item.front.work_id, "omf", "no")).toThrow(/human actor/);
  });
});

const RUN = "r-20261014T091500Z-ab12";
const REPAIRABLE_TEXT = "repairable (file is behind the ledger; the next W entry on this goal repairs it)";

/** The crash window of M3b1-D2: the `work.started` event reached the ledger, item.md still says `ready`. */
function recordStartedOnly(fx: GoalFixture, workId: string): void {
  fx.ledger.append(
    wEvent({ type: "work.started", payload: { goal_id: "g-fast", work_id: workId, run_id: RUN, from: "ready" } }),
  );
}

describe("a repairable item (ledger one W edge ahead of item.md)", () => {
  it("is labelled by work list, still exits 1, and is not shown as a ready or in_progress item", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Cache the render path" }));
    recordStartedOnly(fx, item.front.work_id);
    const result = omf(["work", "list", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`malformed ${item.front.work_id}: ${REPAIRABLE_TEXT}`);
    expect(result.stdout).not.toContain("w_repairable");
    expect(result.stdout).not.toContain(`${item.front.work_id}  ready`);
    expect(result.stderr).toContain("1 malformed work item(s)");
  });

  it("keeps the machine reason in --json, unchanged", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    recordStartedOnly(fx, item.front.work_id);
    const json = JSON.parse(omf(["work", "list", "g-fast", "--json"], fx.repo, fx.home).stdout) as {
      items: unknown[];
      malformed: { work_id: string; reason: string }[];
    };
    expect(json.items).toEqual([]);
    expect(json.malformed.map((entry) => [entry.work_id, entry.reason])).toEqual([
      [item.front.work_id, "w_repairable"],
    ]);
  });

  it("is labelled by work show, which still exits 0", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    recordStartedOnly(fx, item.front.work_id);
    const result = omf(["work", "show", item.front.work_id], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ledger: ${REPAIRABLE_TEXT}`);
    expect(result.stdout).not.toContain("MALFORMED");
  });

  it("leaves a hand edit with no event under its bare reason, in both commands", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    rewriteItem(item, { state: "in_progress" });
    const list = omf(["work", "list", "g-fast"], fx.repo, fx.home);
    expect(list.code).toBe(1);
    expect(list.stdout).toContain(`malformed ${item.front.work_id}: w_event_missing`);
    expect(list.stdout).not.toContain("repairable");
    const show = omf(["work", "show", item.front.work_id], fx.repo, fx.home);
    expect(show.stdout).toContain("ledger: MALFORMED (w_event_missing)");
    expect(show.stdout).not.toContain("repairable");
  });
});
