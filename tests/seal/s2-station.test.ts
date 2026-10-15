import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { gate2EvaluatedEvent } from "../../src/scenario/events.js";
import { sealLockFile } from "../../src/seal/seal.js";
import { s2Station } from "../../src/seal/s2-station.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import type { StationContext, StationResult } from "../../src/work/sequencer.js";
import { commandAuthor, countingSession, fixedIds, sealFixture, startWork, type SealFixture } from "../helpers/seal-fixture.js";
import { digest } from "../helpers/stored-scenario.js";
import { makeTempDir } from "../helpers/tmp.js";

const SHA256 = /^[0-9a-f]{64}$/;

function ctxFor(s: SealFixture): StationContext {
  return {
    runId: "r-20261014T000000Z-0001",
    workId: s.f.workId,
    goalId: s.f.scope.goal_id,
    round: 0,
    resumed: false,
    entryState: "ready",
    item: s.f.item,
    now: () => s.now,
    inputs: emptyEvidenceInputs(),
    recordSpend: () => {},
  };
}

async function runStation(s: SealFixture, session = commandAuthor("from_feedback", makeTempDir("omf-rec-"))): Promise<StationResult> {
  const station = s2Station({ location: s.f.fx.location, session, ids: fixedIds() });
  expect(station.id).toBe("S2");
  return station.run(ctxFor(s));
}

const completed = (s: SealFixture) => s.f.fx.ledger.readVerified().filter((e) => e.type === "seal.completed");

describe("s2Station: a stored or reused seal hands over to GATE-2", () => {
  it("answers ok with the digest of the set it stored", async () => {
    const s = sealFixture();
    const result = await runStation(s);
    expect(result).toEqual({ kind: "ok", progress_digest: completed(s)[0]?.payload.set_sha256 });
    expect((result as { progress_digest: string }).progress_digest).toMatch(SHA256);
  });

  it("answers ok with the digest of the standing seal after a start, and calls no author", async () => {
    const s = sealFixture();
    await runStation(s);
    startWork(s);
    const session = countingSession();
    const result = await runStation(s, session);
    expect(result).toEqual({ kind: "ok", progress_digest: completed(s)[0]?.payload.set_sha256 });
    expect(session.calls).toHaveLength(0);
    expect(completed(s)).toHaveLength(1);
  });

  it("answers ok without a digest for an author failure that a retry can fix; GATE-2 decides", async () => {
    const s = sealFixture();
    const session = countingSession({ ok: false, code: "nonzero_exit", durationMs: 1 });
    expect(await runStation(s, session)).toEqual({ kind: "ok" });
    expect(s.f.fx.ledger.readVerified().filter((e) => e.type === "seal.failed")).toHaveLength(1);
  });
});

describe("s2Station: each stop maps to its code", () => {
  it("J2 (GATE-1 moved) is blocked j2_open", async () => {
    expect(await runStation(sealFixture("open"))).toEqual({ kind: "blocked", reason_code: "j2_open" });
  });

  it("J3 is blocked scenarios_need_review: an unsupported interface, and an item started with no seal", async () => {
    expect(await runStation(sealFixture("http"))).toEqual({ kind: "blocked", reason_code: "scenarios_need_review" });
    const started = sealFixture();
    startWork(started);
    expect(await runStation(started)).toEqual({ kind: "blocked", reason_code: "scenarios_need_review" });
  });

  it("J7 is blocked gate_blocked: a held seal lock, an environment failure of the author, and a guard refusal", async () => {
    const held = sealFixture();
    acquireLock(sealLockFile(held.f.item.dir));
    try {
      expect(await runStation(held)).toEqual({ kind: "blocked", reason_code: "gate_blocked" });
    } finally {
      releaseLock(sealLockFile(held.f.item.dir));
    }

    const slow = sealFixture();
    expect(await runStation(slow, countingSession({ ok: false, code: "timeout", durationMs: 1 }))).toEqual({ kind: "blocked", reason_code: "gate_blocked" });

    const hostile = sealFixture();
    writeFileSync(join(hostile.f.fx.repo, "notes.txt"), `left over: ${"omf-canary-"}${"a".repeat(32)}\n`);
    const session = countingSession();
    expect(await runStation(hostile, session)).toEqual({ kind: "blocked", reason_code: "gate_blocked" });
    expect(session.calls).toHaveLength(0);
  });
});

describe("s2Station: feedback from the ledger", () => {
  const back = (s: SealFixture) =>
    gate2EvaluatedEvent(s.f.scope, {
      round: 1,
      seal_id: null,
      status: "fail",
      route: "back_to_S2",
      reason_codes: ["unlinked_decisions"],
      unlinked_decision_ids: ["d-cache"],
      not_run_decision_ids: [],
      counts: { active: 1, behavior_train: 1, behavior_test: 0, canaries: 0, contaminated: 0, retired: 0 },
      set_sha256: null,
      decisions_digest: digest("a"),
      feedback_counts: { weak: 2, contradictions: 0, invalid: 1 },
    });

  it("passes the latest back_to_S2 feedback of the item to the next author, ids and counts only", async () => {
    const s = sealFixture();
    s.f.fx.ledger.append(back(s));
    const dir = makeTempDir("omf-rec-");
    await runStation(s, commandAuthor("from_feedback", dir));
    const prompt = readFileSync(join(dir, "stdin.txt"), "utf8");
    expect(prompt).toContain("- unlinked decision: d-cache");
    expect(prompt).toContain("- weak scenarios: 2");
    expect(prompt).toContain("- invalid scenarios: 1");
  });

  it("sends no feedback section when there is none", async () => {
    const s = sealFixture();
    const dir = makeTempDir("omf-rec-");
    await runStation(s, commandAuthor("from_feedback", dir));
    expect(readFileSync(join(dir, "stdin.txt"), "utf8")).not.toContain("Feedback on the last attempt");
  });
});
