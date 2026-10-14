import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveGoal } from "../../src/goal/approve.js";
import { requireProject } from "../../src/core/project.js";
import { omf } from "../helpers/cli.js";
import { gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// The README quick start, run against the built CLI in a temporary HOME and a temporary git repository.
// J1 approval needs a terminal and a typed id, which a test cannot provide, so that one step calls approveGoal
// in-process (the TTY path is covered in tests/cli/confirm.test.ts and goal-cli.test.ts).
// Per-step timings are printed, not asserted. Only a generous ceiling fails the test, so a real hang is caught
// without flaking on a slow CI machine. Override with OMF_E2E_BUDGET_MS.
const parsedBudget = Number(process.env.OMF_E2E_BUDGET_MS);
const BUDGET_MS = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 60_000;
const GOAL_ID = "g-journey";
const METRIC_ID = "m-journey";

interface StepResult {
  name: string;
  ms: number;
}

describe("first-run journey", () => {
  it("walks init to goal status in a temporary HOME without hanging", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    gitIn(repo, "config", "user.email", "journey@example.invalid");
    gitIn(repo, "config", "user.name", "journey");
    const steps: StepResult[] = [];
    const started = Date.now();

    /** Runs one CLI step, records its timing and checks the exit code. */
    const run = (name: string, args: string[], code: number | number[]): { stdout: string; stderr: string } => {
      const t0 = Date.now();
      const result = omf(args, repo, home);
      steps.push({ name, ms: Date.now() - t0 });
      expect(result.code, `${name}: exit code\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBeOneOf(Array.isArray(code) ? code : [code]);
      return result;
    };

    const init = run("init", ["init"], 0);
    expect(init.stdout).toMatch(/^initialized .*\/\.omf\/projects\/[0-9a-f]+/m);
    expect(init.stdout).toContain(home);

    // Exit 1 means "problems found" (no Docker or agent CLI on this machine); 2 would mean it could not run.
    // Exit 1 means problems were found (no Docker or agent CLI here); 2 would mean doctor could not run.
    const doctor = run("doctor --json", ["doctor", "--json"], [0, 1]);
    const report = JSON.parse(doctor.stdout) as { problems?: unknown };
    expect(Array.isArray(report.problems)).toBe(true);

    const verify = run("ledger verify", ["ledger", "verify"], 0);
    expect(verify.stdout).toMatch(/^ok: 1 event, head [0-9a-f]+/);

    const created = run("goal new", ["goal", "new", GOAL_ID], 0);
    expect(created.stdout).toMatch(new RegExp(`created .*goals/${GOAL_ID}/goal\\.md`));
    const goalFile = /created (.*goal\.md)/.exec(created.stdout)?.[1];
    expect(goalFile).toBeDefined();

    // A real edit: point the template at the metric and set a target the metric misses (7 > 5).
    const t0 = Date.now();
    const edited = readFileSync(goalFile as string, "utf8")
      .replace(/m-replace-me/g, METRIC_ID)
      .replace("value: 0", "value: 5");
    expect(edited).not.toContain("m-replace-me");
    writeFileSync(goalFile as string, edited);
    steps.push({ name: "edit goal.md", ms: Date.now() - t0 });

    const proposed = run("metric propose", ["metric", "propose", METRIC_ID, "--unit", "ms", "--", "sh", "-c", "echo 7"], 0);
    expect(proposed.stdout).toContain(`proposed ${METRIC_ID} as human:journey@example.invalid`);

    const audit = run("goal audit", ["goal", "audit", GOAL_ID], 0);
    expect(audit.stdout).toContain(`goal ${GOAL_ID}: draft`);
    expect(audit.stdout).toContain(`ready for J1: run omf goal approve ${GOAL_ID}`);

    const t1 = Date.now();
    const approval = approveGoal(requireProject(repo, { HOME: home }), GOAL_ID, "human:journey@example.invalid");
    steps.push({ name: "approve (in-process)", ms: Date.now() - t1 });
    expect(approval.created).toBe(true);
    expect(approval.approval.regime).toBe(1);

    const measured = run("goal measure", ["goal", "measure", GOAL_ID, "--runner", "host"], 0);
    expect(measured.stdout).toContain(`goal ${GOAL_ID} (regime 1), runner host`);
    expect(measured.stdout).toContain(`target ${METRIC_ID}: 7 ms; target <= 5 ms; gap 2`);
    expect(measured.stderr).toContain("measured on the host without isolation");

    const status = run("goal status", ["goal", "status", GOAL_ID], 0);
    expect(status.stdout).toContain(GOAL_ID);
    expect(status.stdout).toMatch(/running/);

    const total = Date.now() - started;
    const lines = ["first-run journey timings:", ...steps.map((s) => `  ${s.name.padEnd(22)} ${String(s.ms).padStart(5)} ms`), `  total ${total} ms`];
    // console.log is not shown for a passing file with this reporter setup; stderr is.
    process.stderr.write(`${lines.join("\n")}\n`);
    expect(total, `journey took ${total} ms, ceiling ${BUDGET_MS} ms (OMF_E2E_BUDGET_MS)`).toBeLessThan(BUDGET_MS);
  }, BUDGET_MS + 30_000);
});
