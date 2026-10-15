import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDecideDefer, runDecideNa, runDecideResolve } from "../../src/cli/decide.js";
import { needsHumanFile, readNeedsHuman } from "../../src/decision/needs-human.js";
import { findDecision } from "../../src/decision/state.js";
import {
  HUMAN,
  NOW,
  addOpen,
  closeInterface,
  decideCli,
  forge,
  reasonsFor,
  reasonsOf,
  relockTarget,
  reportAt,
  resolveOpen,
  setupDecisionItem,
  settle,
} from "../helpers/decision-fixture.js";

// Spec §5.0, GATE-1: a work item whose design decisions are not all closed by a person stops at J2
// (`blocked_on_user`) and waits for that person; there is no waiting loop (M3-D7). Each test below makes
// one way of being "not closed" and checks the reason GATE-1 names. None of them may come out as pass.
describe("W-gate1-open-blocks", () => {
  it("zero decisions block with interface_missing; lint exits 3 and persists a record with no default", () => {
    const f = setupDecisionItem();
    expect(reportAt(f, NOW).gate).toEqual({
      status: "blocked_on_user",
      j: "J2",
      reasons: [{ code: "interface_missing" }],
    });

    settle(f);
    const run = decideCli(f, ["lint", f.workId]);
    expect(run.code, run.stdout + run.stderr).toBe(3);
    const record = readNeedsHuman(f.item.dir);
    expect(record).toMatchObject({ j: "J2", work_id: f.workId, goal_id: f.fx.goalId, default: null });
    expect(record?.reasons).toEqual([{ code: "interface_missing" }]);
  });

  it("an open required decision blocks and is named", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    expect(reasonsFor(reportAt(f, NOW).gate, "d-cache")).toContainEqual({
      code: "required_open",
      decision_id: "d-cache",
    });
  });

  it("a missing interface blocks even when every other decision is closed", () => {
    const f = setupDecisionItem();
    addOpen(f, "d-cache");
    resolveOpen(f, "d-cache");
    expect(reasonsOf(reportAt(f, NOW).gate)).toContainEqual({ code: "interface_missing" });
  });

  it("a deferral that omf wrote instead of a person leaves the decision open and blocks", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    forge(f, "omf", "decision.deferred", "d-cache", {
      deferral: {
        owner: "omf",
        reason: "later",
        revisit_trigger: "never",
        default: "ship as is",
        signed_by: "omf",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const { state, gate } = reportAt(f, NOW);
    expect(findDecision(state, "d-cache")?.status).toBe("open");
    expect(gate.status).toBe("blocked_on_user");
    expect(reasonsFor(gate, "d-cache").map((r) => r.code)).toContain("required_open");
  });

  it("an expired deferral counts as open, to the second (injected clock), and a person can settle it (A21)", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    runDecideDefer(
      f.fx.location,
      f.workId,
      "d-cache",
      {
        owner: "dev",
        reason: "Waiting on the cache benchmark.",
        revisit_trigger: "After the benchmark lands.",
        default: "Keep the current behavior.",
        expires_at: "2026-10-15T00:00:00.000Z",
      },
      HUMAN,
      NOW,
    );
    expect(reportAt(f, new Date("2026-10-14T23:59:59.000Z")).gate).toEqual({ status: "pass" });
    expect(reportAt(f, new Date("2026-10-15T00:00:00.000Z")).gate).toEqual({
      status: "blocked_on_user",
      j: "J2",
      reasons: [{ code: "deferral_expired", decision_id: "d-cache", expires_at: "2026-10-15T00:00:00.000Z" }],
    });

    // Expired is not a dead end: a person resolves the deferred decision and GATE-1 passes again.
    resolveOpen(f, "d-cache");
    expect(findDecision(reportAt(f, NOW).state, "d-cache")?.status).toBe("resolved");
    expect(reportAt(f, new Date("2026-10-15T00:00:00.000Z")).gate).toEqual({ status: "pass" });
  });

  it("an intent with open questions never passes until a person has closed each one (F8)", () => {
    const f = setupDecisionItem({
      openQuestions: ["Which entries are evicted first?", "Who invalidates stale entries?"],
    });

    // Nothing is seeded before the first write, so GATE-1 must be fail-closed on its own.
    const unseeded = reasonsOf(reportAt(f, NOW).gate);
    expect(unseeded).toContainEqual({ code: "intent_question_missing", decision_id: "d-intent-q1" });
    expect(unseeded).toContainEqual({ code: "intent_question_missing", decision_id: "d-intent-q2" });

    // The first write seeds both. Resolving only the interface leaves them open.
    closeInterface(f);
    const seeded = reasonsOf(reportAt(f, NOW).gate);
    expect(seeded).toEqual([
      { code: "required_open", decision_id: "d-intent-q1" },
      { code: "required_open", decision_id: "d-intent-q2" },
    ]);
    settle(f);
    expect(decideCli(f, ["lint", f.workId]).code).toBe(3);
    expect(existsSync(needsHumanFile(f.item.dir))).toBe(true);

    // A person closes both. The last write clears the block without another lint.
    resolveOpen(f, "d-intent-q1");
    runDecideNa(f.fx.location, f.workId, "d-intent-q2", { rationale: "Not relevant to this change." }, HUMAN);
    expect(reportAt(f, NOW).gate).toEqual({ status: "pass" });
    expect(existsSync(needsHumanFile(f.item.dir))).toBe(false);
    const clean = decideCli(f, ["lint", f.workId]);
    expect(clean.code, clean.stdout + clean.stderr).toBe(0);
  });

  it("a record that was valid before a goal re-lock is invalid after it, and only cancel or veto leave the block", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-cache",
      { choice: "Keep 2500 entries", rationale: "That is the size callers already use.", rejected: [] },
      HUMAN,
    );
    expect(reportAt(f, NOW).gate).toEqual({ status: "pass" });

    relockTarget(f, 2500); // the new locked target now equals a number written in a closed decision
    const gate = reportAt(f, NOW).gate;
    expect(gate.status).toBe("blocked_on_user");
    expect(reasonsOf(gate)).toContainEqual({ code: "record_invalid", decision_id: "d-cache", problem: "leak" });

    settle(f);
    const run = decideCli(f, ["lint", f.workId]);
    expect(run.code, "lint problems win over the block").toBe(1);
    const record = readNeedsHuman(f.item.dir);
    // needs-human.json never copies the id of a record_invalid reason (T8); only the gate result above names it.
    expect(record?.reasons).toContainEqual({ code: "record_invalid", decision_id: null, problem: "leak" });
    expect(JSON.stringify(record)).not.toContain("d-cache");
    expect(record?.options.join("\n")).toContain("veto");
  });
});
