import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { approveGoal } from "../../src/goal/approve.js";
import { ESCALATIONS, escalate, nextSteps, terminate } from "../../src/goal/lifecycle.js";
import { lockFile } from "../../src/goal/metrics.js";
import { tickLockFile } from "../../src/goal/tick-lock.js";
import { omf } from "../helpers/cli.js";
import { setupGoal } from "../helpers/goal.js";
import { seedRepairable, setupTick } from "../helpers/tick.js";
import { commitAll } from "../helpers/tmp.js";

const G = "g-fast";
const TICK = "t-20261012T000000Z-0a1b";

describe("omf goal status", () => {
  it("--json reports the run state, budgets, open escalation, next steps and work counts", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    const result = omf(["goal", "status", G, "--json"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      goal_id: G,
      state: "running",
      since: null,
      reason_code: null,
      ticks: 0,
      audit_state: "approved",
      rounds: { kind: "rounds", declared: 10, raised: 0, consumed: 0, remaining: 10 },
      disclosure: null,
      open_escalation: null,
      next_steps: [],
      work: {
        ready: 0,
        awaiting_approval: 0,
        in_progress: 0,
        awaiting_review: 0,
        done: 0,
        failed: 0,
        vetoed: 0,
        cancelled: 0,
        malformed: 0,
        repairable: 0,
      },
    });
  });

  it("shows a blocked goal with its escalation and the exact next steps", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    escalate(fx.ledger, G, TICK, "no_progress", null);
    const json = JSON.parse(omf(["goal", "status", G, "--json"], fx.repo, fx.home).stdout);
    expect(json.state).toBe("blocked_on_user");
    expect(json.reason_code).toBe("no_progress");
    expect(json.open_escalation).toMatchObject({ j: "J6", reason_code: "no_progress", default: "stay stopped" });
    expect(json.next_steps[0]).toBe(`omf work list ${G}`);

    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`goal ${G}: blocked_on_user`);
    expect(text.stdout).toContain("J6 no_progress");
    expect(text.stdout).toContain(`omf goal resume ${G}`);
  });

  it("lists a repairable item in its own count and keeps it out of the file-state counts", () => {
    const fx = setupTick();
    seedRepairable(fx, "Crashed after start", "in_progress");

    const json = JSON.parse(omf(["goal", "status", "g-fast", "--json"], fx.repo, fx.home).stdout);
    // The file still says ready, but the ledger has moved on: it is neither a ready item nor dropped.
    expect(json.work).toMatchObject({ ready: 0, in_progress: 0, malformed: 1, repairable: 1 });

    const text = omf(["goal", "status", "g-fast"], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("malformed 1, repairable 1");
  });

  it("says a draft goal is not approved and names the next step, without changing the JSON or the ledger", () => {
    const fx = setupGoal();
    const before = fx.ledger.verify();
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`goal ${G}: not approved yet, no work has started (audit: draft; 0 ticks)`);
    expect(text.stdout).not.toContain(": running");
    expect(text.stdout).toContain(`omf goal approve ${G}`);
    const json = JSON.parse(omf(["goal", "status", G, "--json"], fx.repo, fx.home).stdout);
    expect(json).toMatchObject({ state: "running", audit_state: "draft", ticks: 0, next_steps: [] });
    expect(fx.ledger.verify()).toEqual(before);
  });

  it("says an approved goal with no tick yet is approved, not running", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    const before = fx.ledger.verify();
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.stdout).toContain(`goal ${G}: approved, no tick has run yet (audit: approved; 0 ticks)`);
    expect(text.stdout).not.toContain("next steps");
    expect(fx.ledger.verify()).toEqual(before);
  });

  it("says reapproval is required after goal.md changes and points at audit and approve", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const before = fx.ledger.verify();
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`goal ${G}: reapproval required`);
    expect(text.stdout).toContain("audit: needs re-approval");
    expect(text.stdout).toContain(`omf goal approve ${G}`);
    expect(JSON.parse(omf(["goal", "status", G, "--json"], fx.repo, fx.home).stdout).state).toBe("running");
    expect(fx.ledger.verify()).toEqual(before);
  });

  it("says reapproval is required after a watched metric file changes", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    commitAll(fx.repo, "faster benchmark");
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.stdout).toContain(`goal ${G}: reapproval required`);
    expect(text.stdout).toContain(`omf goal approve ${G}`);
  });

  it("keeps a blocked goal's own name even when the audit also needs reapproval", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    escalate(fx.ledger, G, TICK, "no_progress", null);
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.stdout).toContain(`goal ${G}: blocked_on_user (audit: needs re-approval`);
    expect(text.stdout).toContain(`omf goal audit ${G}`);
  });

  it("points a cancelled goal with a tampered lock at audit", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    terminate(fx.ledger, G, "cancelled", null, "cancelled_by_user", "human:dev");
    const file = lockFile(fx.location.dir, G, "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.stdout).toContain(`goal ${G}: cancelled (audit: tampered`);
    expect(text.stdout).toContain(`omf goal audit ${G}`);
  });

  it.each([
    ["failed", "omf", "tick_error"],
    ["finish", "omf", "target_reached"],
    ["cancelled", "human:dev", "cancelled_by_user"],
  ] as const)("keeps its own status text for a %s goal", (state, actor, reason) => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    terminate(fx.ledger, G, state, null, reason, actor);
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`goal ${G}: ${state} (audit: approved`);
    expect(text.stdout).not.toContain("approved, no tick has run yet");
    expect(JSON.parse(omf(["goal", "status", G, "--json"], fx.repo, fx.home).stdout).state).toBe(state);
  });

  it("spends no budget and appends no ledger event", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    const eventsBefore = fx.ledger.readVerified().length;
    const counts = () => {
      const b = JSON.parse(omf(["budget", "show", G, "--json"], fx.repo, fx.home).stdout);
      expect(b.rounds).toBeDefined();
      return { rounds: b.rounds, disclosure: b.disclosure };
    };
    const budgetBefore = counts();
    const first = JSON.parse(omf(["goal", "status", G, "--json"], fx.repo, fx.home).stdout);
    omf(["goal", "status", G], fx.repo, fx.home);
    const second = JSON.parse(omf(["goal", "status", G, "--json"], fx.repo, fx.home).stdout);
    expect(second.rounds).toEqual(first.rounds);
    expect(second.disclosure).toEqual(first.disclosure);
    expect(first.rounds.consumed).toBe(0);
    expect(counts()).toEqual(budgetBefore);
    expect(fx.ledger.readVerified().length).toBe(eventsBefore);
  });

  it("says the audit found problems and points at audit first, without claiming approve repairs it", () => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    const file = lockFile(fx.location.dir, G, "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    const text = omf(["goal", "status", G], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`goal ${G}: stopped, the audit found problems (audit: tampered`);
    expect(text.stdout).toContain(`omf goal audit ${G}`);
    expect(text.stdout).not.toContain("omf goal approve");
    expect(text.stdout).toContain("stopped, the audit found problems");
  });

  it("exits 2 for an unknown goal", () => {
    const fx = setupGoal();
    const result = omf(["goal", "status", "g-nope"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("goal g-nope not found");
  });
});

describe("omf goal resume and omf goal cancel", () => {
  it.each(["resume", "cancel"])("%s without a terminal exits 2 and writes nothing", (verb) => {
    const fx = setupGoal();
    approveGoal(fx.location, G, "human:dev");
    escalate(fx.ledger, G, TICK, "no_progress", null);
    const before = fx.ledger.verify();
    const result = omf(["goal", verb, G], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`goal ${verb} needs an interactive terminal; nothing was done`);
    expect(fx.ledger.verify()).toEqual(before);
  });

  it.each(["resume", "cancel"])(
    "%s exits 2 with `a tick is running; retry` while another process holds tick.lock, and writes nothing",
    (verb) => {
      const fx = setupGoal();
      approveGoal(fx.location, G, "human:dev");
      escalate(fx.ledger, G, TICK, "no_progress", null);
      const before = fx.ledger.verify();
      acquireLock(tickLockFile(fx.location, G));
      try {
        const result = omf(["goal", verb, G], fx.repo, fx.home);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("a tick is running; retry");
      } finally {
        releaseLock(tickLockFile(fx.location, G));
      }
      expect(fx.ledger.verify()).toEqual(before);
    },
  );

  it.each(["resume", "cancel"])("%s exits 2 for an unknown goal", (verb) => {
    const fx = setupGoal();
    const result = omf(["goal", verb, "g-nope"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("goal g-nope not found");
  });

  it("lists status, resume and cancel in the goal help", () => {
    const fx = setupGoal();
    const help = omf(["goal", "--help"], fx.repo, fx.home);
    expect(help.code).toBe(0);
    for (const verb of ["status", "resume", "cancel"]) expect(help.stdout).toContain(verb);
  });
});

describe("nextSteps name commands that exist", () => {
  it("every `omf ...` step of every reason code answers --help", () => {
    const fx = setupGoal();
    const D = "g-demo";
    const paths = new Set<string>();
    for (const code of Object.keys(ESCALATIONS)) {
      const entry = ESCALATIONS[code]!;
      for (const signature of [null, "audit|stopped|x"]) {
        const steps = nextSteps(
          {
            tick_id: TICK,
            j: entry.j,
            reason_code: code,
            signature,
            question: entry.question,
            options: entry.options,
            default: entry.default,
            at: "2026-10-12T00:00:00.000Z",
          },
          D,
        );
        for (const step of steps.filter((s) => s.startsWith("omf "))) {
          const words: string[] = [];
          for (const word of step.split(" ").slice(1)) {
            if (word === D || word.startsWith("<")) break;
            words.push(word);
          }
          paths.add(words.join(" "));
        }
      }
    }
    expect([...paths].sort()).toEqual([
      "budget raise",
      "goal approve",
      "goal audit",
      "goal cancel",
      "goal resume",
      "veto",
      "work approve",
      "work list",
    ]);
    for (const path of paths) {
      const help = omf([...path.split(" "), "--help"], fx.repo, fx.home);
      expect(help.code, path).toBe(0);
      expect(help.stdout, path).toContain(`Usage: omf ${path}`);
    }
  });
});
