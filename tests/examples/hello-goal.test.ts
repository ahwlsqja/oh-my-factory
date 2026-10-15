import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createReconciler } from "../../src/adapters/reconciler.js";
import { readConfig } from "../../src/core/config.js";
import { Ledger } from "../../src/core/ledger.js";
import { resolveProject } from "../../src/core/paths.js";
import { validate } from "../../src/core/schema.js";
import { approveGoal } from "../../src/goal/approve.js";
import { MIN_BASELINE_POINTS } from "../../src/goal/bands.js";
import { parseGoal } from "../../src/goal/goal-file.js";
import { approachOf } from "../../src/goal/reconcile.js";
import { tickGoal } from "../../src/goal/tick.js";
import { forbiddenTermsFor, lintCandidate, lintText } from "../../src/work/seed-lint.js";
import type { IntentCandidate } from "../../src/work/types.js";
import { CLI, omf } from "../helpers/cli.js";
import { commitAll, gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// Spec §13: the walking skeleton proves two turns of the goal loop. M2b ships the goal-loop half of
// examples/hello-goal; the verification line (M3) is replaced by the change in fix/search.mjs.
const EXAMPLE = fileURLToPath(new URL("../../examples/hello-goal/", import.meta.url));
const E2E_TIMEOUT_MS = 90_000;

const loadGoal = () => parseGoal(readFileSync(join(EXAMPLE, "goal.md"), "utf8"));

/** Runs a bench script with the current node and returns the integer it prints. */
function runBench(cwd: string, script: string): number {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

/** The environment of a script run: HOME is the test's, nothing points at a real OMF home, no API key leaks in. */
function scriptEnv(home: string, path: string): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("GIT_") &&
      !key.startsWith("XDG_") &&
      !["OMF_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key) &&
      !/(_API_KEY$|^ANTHROPIC_|^OPENAI_)/.test(key),
  );
  return { ...Object.fromEntries(inherited), HOME: home, PATH: path };
}

interface TickJson {
  status: string;
  outcome: string;
  created: { work_id: string; state: string; risk: string }[];
}

describe("examples/hello-goal files", () => {
  it("ships a goal.md and a bands file that validate", () => {
    const { front } = loadGoal();
    expect(front).toMatchObject({ goal_id: "g-hello", mode: "build", guardrails: ["m-bad-results"] });
    expect(front.prereg.min_observation).toBe("1m");
    const bands = parse(readFileSync(join(EXAMPLE, "bands", "m-bad-results.yaml"), "utf8")) as unknown;
    expect(validate("bands.schema.json", bands)).toEqual({ ok: true });
    expect(bands).toMatchObject({ metric: "m-bad-results", tiers: { "3sigma": { action: "propose" } } });
  });

  it("has an objective and an approach that pass seed lint (D22)", () => {
    const { front, body } = loadGoal();
    const terms = forbiddenTermsFor(front);
    expect(lintText("objective", front.objective, terms)).toEqual([]);
    expect(lintText("approach", approachOf(body), terms)).toEqual([]);
    expect(approachOf(body)).not.toBe("");
  });

  it("answers with a candidate that passes the output schema and every deterministic filter", () => {
    const run = spawnSync(process.execPath, [join(EXAMPLE, "reconciler.mjs")], {
      input: "an untrusted prompt\n",
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const response = JSON.parse(run.stdout) as { candidates: IntentCandidate[] };
    expect(validate("reconcile-output.schema.json", response)).toEqual({ ok: true });
    expect(response.candidates).toHaveLength(1);
    const terms = forbiddenTermsFor(loadGoal().front);
    for (const candidate of response.candidates) expect(lintCandidate(candidate, terms)).toEqual([]);
  });

  it("ships the change that closes the gap without changing any answer", () => {
    const copy = makeTempDir("omf-hello-");
    cpSync(EXAMPLE, copy, { recursive: true });
    const target = loadGoal().front.target.value;
    expect(runBench(copy, "bench/steps.mjs")).toBeGreaterThan(target);
    expect(runBench(copy, "bench/check.mjs")).toBe(0);
    cpSync(join(copy, "fix", "search.mjs"), join(copy, "app", "search.mjs"));
    expect(runBench(copy, "bench/steps.mjs")).toBeLessThanOrEqual(target);
    expect(runBench(copy, "bench/check.mjs")).toBe(0);
  });
});

describe("examples/hello-goal, two turns of the goal loop", () => {
  it(
    "runs setup, the seeded baseline, turn 1 (dispatch) and turn 2 (success candidate)",
    async () => {
      const repo = makeGitRepo();
      // setup.sh runs `omf metric propose`, which records the person as human:<git user.email>; HOME is empty here.
      gitIn(repo, "config", "user.email", "dev@example.com");
      const home = makeTempDir("omf-home-");
      const bin = makeTempDir("omf-bin-");
      const wrapper = join(bin, "omf");
      writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      const path = [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);
      const env = scriptEnv(home, path);
      const sh = (script: string): void => {
        const result = spawnSync("sh", [script], { cwd: repo, env, encoding: "utf8" });
        expect(result.status, `${script}: ${result.stderr}`).toBe(0);
      };

      cpSync(EXAMPLE, repo, { recursive: true });
      commitAll(repo, "add the hello-goal example");

      sh("setup.sh");
      const location = resolveProject(repo, { OMF_HOME: join(home, ".omf") });
      expect(approveGoal(location, "g-hello", "human:dev")).toMatchObject({ created: true, approval: { regime: 1 } });

      sh("seed-baseline.sh");
      const measured = new Ledger(location.dir).readVerified().filter((e) => e.type === "goal.measured");
      expect(measured).toHaveLength(MIN_BASELINE_POINTS + 1);
      expect(measured.at(-1)?.payload.guardrails).toBe("pass");

      // Turn 1, through the CLI: the target is not met, so the stand-in model is asked and one item is dispatched.
      const turn1 = omf(["goal", "tick", "g-hello", "--runner", "host", "--json"], repo, home, { PATH: path });
      expect(turn1.code, turn1.stderr).toBe(0);
      const first = JSON.parse(turn1.stdout) as TickJson;
      expect(first).toMatchObject({ status: "continue", outcome: "dispatched" });
      expect(first.created).toHaveLength(1);
      expect(first.created[0]).toMatchObject({ state: "ready", risk: "normal" });
      const list = omf(["work", "list", "g-hello"], repo, home, { PATH: path });
      expect(list.code, list.stderr).toBe(0);
      expect(list.stdout).toContain(first.created[0]?.work_id ?? "no work id");

      // The change the verification line would make. It is outside bench/, so it is not a regime change.
      cpSync(join(repo, "fix", "search.mjs"), join(repo, "app", "search.mjs"));
      commitAll(repo, "halve the range at every look");

      // Turn 2, with a fake clock: the first met measurement starts the streak, the second one a minute or more later ends it.
      const config = readConfig(location.dir);
      const reconciler = createReconciler(location.dir, config.reconciler, env);
      const started = Date.now();
      const tick = (minutes: number) =>
        tickGoal(location, "g-hello", {
          runner: "host",
          reconciler,
          config,
          env,
          now: () => new Date(started + minutes * 60_000),
        });
      expect(await tick(1)).toMatchObject({ status: "continue", outcome: "observing", reason_code: "consecutive" });
      expect(await tick(3)).toMatchObject({ status: "finish", outcome: "success_candidate" });
      expect(await tick(4)).toMatchObject({ status: "finish", outcome: "already_final" });

      const events = new Ledger(location.dir).readVerified();
      expect(events.filter((e) => e.type === "goal.success_candidate")).toHaveLength(1);
      // Only turn 1 called the model, so only turn 1 spent a round (D18).
      expect(events.filter((e) => e.type === "budget.consumed" && e.payload.kind === "rounds")).toHaveLength(1);
    },
    E2E_TIMEOUT_MS,
  );
});
