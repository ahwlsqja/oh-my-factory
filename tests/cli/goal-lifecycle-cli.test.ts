import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { approveGoal } from "../../src/goal/approve.js";
import { ESCALATIONS, escalate, nextSteps } from "../../src/goal/lifecycle.js";
import { tickLockFile } from "../../src/goal/tick-lock.js";
import { omf } from "../helpers/cli.js";
import { setupGoal } from "../helpers/goal.js";
import { seedRepairable, setupTick } from "../helpers/tick.js";

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
