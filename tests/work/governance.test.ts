import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { auditGoal } from "../../src/goal/audit.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { lockFile } from "../../src/goal/metrics.js";
import { type Governance, GovernanceError, governanceDrift, readGovernance } from "../../src/work/governance.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { type EnforcementFixture, setupEnforcementGoal } from "../helpers/enforcement-goal.js";
import { type GoalFixture, type TickGoalFixture, setupGoal, setupTickGoal } from "../helpers/goal.js";
import { appendEscalation, appendGoalEvent } from "../helpers/loop-events.js";
import { commitAll } from "../helpers/tmp.js";

// Wraps readFileSync so one test can count the reads of config.toml and serve other bytes for it.
// Every other caller gets the real function.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const G = "g-fast";

/** The closed codes a failed reading carries, or null when it succeeded. */
function problemsOf(fx: GoalFixture): string[] | null {
  try {
    readGovernance(fx.location, G, new Date());
  } catch (err) {
    if (!(err instanceof GovernanceError)) throw err;
    return [...err.problems];
  }
  return null;
}

/** Flips one field of the first ledger line, so the hash chain no longer verifies. */
function corruptLedger(fx: GoalFixture): void {
  const lines = readFileSync(fx.ledger.file, "utf8").split("\n");
  const first = JSON.parse(lines[0]!) as { payload: Record<string, unknown> };
  first.payload.tampered = true;
  lines[0] = JSON.stringify(first);
  writeFileSync(fx.ledger.file, lines.join("\n"));
}

describe("readGovernance", () => {
  it("returns digests only for an approved, running goal", () => {
    const fx = setupTickGoal();
    const governance = readGovernance(fx.location, G, new Date());
    expect(Object.keys(governance).sort()).toEqual(["config_sha256", "goal_digest", "regime"]);
    expect(governance.config_sha256).toBe(sha256Hex(readFileSync(join(fx.location.dir, "config.toml"))));
    expect(governance.regime).toBe(1);
    expect(governance.goal_digest).toBe(auditGoal(fx.location, G, new Date()).approval?.semantic_sha256);
  });

  it("carries nothing a model or a metric could leak: the canary goal's reading has no hit", () => {
    // goal.md of this fixture holds the reading and the target in its notes, and the metric id is a canary.
    const fx = setupEnforcementGoal();
    const governance = readGovernance(fx.location, fx.goalId, new Date());
    expect(canaryHits(JSON.stringify(governance))).toEqual([]);
  });

  it("reads config.toml exactly once and hashes the bytes it parsed", async () => {
    const fx = setupTickGoal();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const passthrough = actual.readFileSync as (...args: unknown[]) => unknown;
    const served = "# served to governance, never on disk\n";
    const read = vi.mocked(readFileSync);
    read.mockClear();
    // Any second read of the file would see the real (different) bytes and hash those instead.
    read.mockImplementation(((...args: unknown[]) =>
      String(args[0]).endsWith("config.toml") ? Buffer.from(served) : passthrough(...args)) as never);
    try {
      const governance = readGovernance(fx.location, G, new Date());
      const configReads = read.mock.calls.filter((call) => String(call[0]).endsWith("config.toml"));
      expect(configReads).toHaveLength(1);
      expect(governance.config_sha256).toBe(sha256Hex(Buffer.from(served)));
    } finally {
      read.mockImplementation(actual.readFileSync as never);
    }
  });

  it.each<[string, () => GoalFixture, (fx: GoalFixture) => void, string[]]>([
    [
      "a missing config.toml",
      setupTickGoal,
      (fx) => rmSync(join(fx.location.dir, "config.toml")),
      ["config_unreadable"],
    ],
    [
      "config.toml that is not TOML",
      setupTickGoal,
      (fx) => writeFileSync(join(fx.location.dir, "config.toml"), "not = [valid"),
      ["config_unreadable"],
    ],
    ["a missing goal.md", setupTickGoal, (fx) => rmSync(fx.goalFile), ["goal_unreadable"]],
    ["a goal that was never approved", setupGoal, () => undefined, ["goal_not_approved"]],
    [
      "an edited goal.md",
      setupTickGoal,
      (fx) => writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400")),
      ["needs_reapproval"],
    ],
    [
      "a tampered metric lock",
      setupTickGoal,
      (fx) => {
        const file = lockFile(fx.location.dir, G, "m-p95");
        const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
        lock.command = ["sh", "-c", "echo 1"];
        writeFileSync(file, JSON.stringify(lock));
      },
      ["tampered"],
    ],
    ["a corrupt ledger", setupTickGoal, corruptLedger, ["ledger_corrupt"]],
    [
      "a goal blocked on a person (J6)",
      setupTickGoal,
      (fx) => appendEscalation(fx.ledger, G, "J6", "no_progress"),
      ["goal_stopped"],
    ],
    [
      "a failed goal",
      setupTickGoal,
      (fx) =>
        appendGoalEvent(fx.ledger, "goal.terminated", G, "omf", {
          tick_id: null,
          state: "failed",
          reason_code: "test",
        }),
      ["goal_stopped"],
    ],
    [
      "a finished goal",
      setupTickGoal,
      (fx) =>
        appendGoalEvent(fx.ledger, "goal.terminated", G, "omf", {
          tick_id: null,
          state: "finish",
          reason_code: "test",
        }),
      ["goal_stopped"],
    ],
  ])("stops with a closed code on %s", (_name, make, arrange, expected) => {
    const fx = make();
    arrange(fx);
    expect(problemsOf(fx)).toEqual(expected);
  });

  it("never replaces a missing config.toml with defaults", () => {
    const fx = setupTickGoal();
    const path = join(fx.location.dir, "config.toml");
    rmSync(path);
    expect(problemsOf(fx)).toEqual(["config_unreadable"]);
    expect(() => readFileSync(path)).toThrow(/ENOENT/);
  });

  it("puts only the closed code in the message", () => {
    const fx = setupTickGoal();
    rmSync(join(fx.location.dir, "config.toml"));
    expect(() => readGovernance(fx.location, G, new Date())).toThrow(
      expect.objectContaining({ name: "GovernanceError", message: "config_unreadable" }),
    );
  });
});

describe("governanceDrift", () => {
  const base: Governance = { config_sha256: "a".repeat(64), regime: 1, goal_digest: "b".repeat(64) };

  it("is null for equal readings and names the first difference otherwise", () => {
    expect(governanceDrift(base, { ...base })).toBeNull();
    expect(governanceDrift(base, { ...base, config_sha256: "c".repeat(64) })).toBe("config_changed");
    expect(governanceDrift(base, { ...base, regime: 2 })).toBe("regime_changed");
    expect(governanceDrift(base, { ...base, goal_digest: "d".repeat(64) })).toBe("regime_changed");
    // Both moved: the config is reported first, so rule 5 never hides a config edit behind a re-lock.
    expect(governanceDrift(base, { ...base, config_sha256: "c".repeat(64), regime: 2 })).toBe("config_changed");
  });

  it("sees a real config edit and a real re-lock", () => {
    const fx: TickGoalFixture = setupTickGoal();
    const before = readGovernance(fx.location, G, new Date());
    expect(governanceDrift(before, readGovernance(fx.location, G, new Date()))).toBeNull();

    appendFileSync(join(fx.location.dir, "config.toml"), "\n# edited\n");
    const afterConfig = readGovernance(fx.location, G, new Date());
    expect(governanceDrift(before, afterConfig)).toBe("config_changed");

    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    lockGoal(fx.location, G, "human:dev");
    const afterRelock = readGovernance(fx.location, G, new Date());
    expect(afterRelock.regime).toBe(2);
    expect(governanceDrift(afterConfig, afterRelock)).toBe("regime_changed");
  });
});

describe("GovernanceError leaks nothing from the goal or the audit", () => {
  /** The error's whole visible surface, as one string. */
  function surfaceOf(fx: EnforcementFixture): string {
    try {
      readGovernance(fx.location, fx.goalId, new Date());
    } catch (err) {
      if (!(err instanceof GovernanceError)) throw err;
      return `${err.message}\n${JSON.stringify(err.problems)}`;
    }
    throw new Error("readGovernance was expected to throw");
  }

  /** The audit really does mention the canaries here, so an empty result below is not vacuous. */
  function auditMentionsCanary(fx: EnforcementFixture): boolean {
    const report = auditGoal(fx.location, fx.goalId, new Date());
    return (
      canaryHits(JSON.stringify([report.problems, report.regime_changes, report.watched_paths_changed])).length > 0
    );
  }

  it("for a regime change on a watched path and a changed target", () => {
    const fx = setupEnforcementGoal();
    writeFileSync(join(fx.repo, CANARY.watchedPath), "cat bench/reading.txt # edited\n");
    commitAll(fx.repo, "edit the watched script");
    writeFileSync(
      fx.goalPath + "/goal.md",
      readFileSync(fx.goalPath + "/goal.md", "utf8").replace(CANARY.target, "1234.5"),
    );
    expect(auditMentionsCanary(fx)).toBe(true);
    const surface = surfaceOf(fx);
    expect(surface).toContain("needs_reapproval");
    expect(canaryHits(surface)).toEqual([]);
  });

  it("for a tampered metric lock", () => {
    const fx = setupEnforcementGoal();
    const file = lockFile(fx.location.dir, fx.goalId, CANARY.metricId);
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    expect(auditMentionsCanary(fx)).toBe(true);
    const surface = surfaceOf(fx);
    expect(surface).toContain("tampered");
    expect(canaryHits(surface)).toEqual([]);
  });
});
