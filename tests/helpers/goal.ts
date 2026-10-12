import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../src/core/ledger.js";
import { type ProjectLocation, resolveProject } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { createGoal, goalTemplate } from "../../src/goal/goal-file.js";
import { proposeMetric } from "../../src/goal/metrics.js";
import { commitAll, makeGitRepo, makeTempDir } from "./tmp.js";

export interface GoalFixture {
  repo: string;
  /** Use as HOME for CLI runs; OMF state is under `<home>/.omf`, the same place the core calls use. */
  home: string;
  env: NodeJS.ProcessEnv;
  location: ProjectLocation;
  ledger: Ledger;
  goalFile: string;
}

/**
 * An initialized project with goal g-fast: target m-p95 <= 250 ms (the bench prints 312), guardrail
 * m-errors (prints 0.4). m-p95 watches `bench/p95.sh` only, so editing bench/errors.sh is not a regime
 * change. Both metrics are proposed by human:dev. Nothing is approved yet.
 */
export function setupGoal(options: { guardrails?: string[] } = {}): GoalFixture {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env = { OMF_HOME: join(home, ".omf") };
  initProject(repo, env);
  const location = resolveProject(repo, env);
  mkdirSync(join(repo, "bench"), { recursive: true });
  writeFileSync(join(repo, "bench", "p95.sh"), "echo 312\n");
  writeFileSync(join(repo, "bench", "errors.sh"), "echo 0.4\n");
  commitAll(repo, "add bench");
  const goalFile = createGoal(location.dir, "g-fast");
  const guardrails = options.guardrails ?? ["m-errors"];
  writeFileSync(
    goalFile,
    goalTemplate("g-fast")
      .replace(/m-replace-me/g, "m-p95")
      .replace("value: 0", "value: 250")
      .replace("guardrails: []", `guardrails: [${guardrails.join(", ")}]`),
  );
  const ledger = new Ledger(location.dir);
  proposeMetric(
    ledger,
    location.dir,
    { metric_id: "m-p95", command: ["sh", "bench/p95.sh"], unit: "ms", watched_paths: ["bench/p95.sh"], image: null },
    "human:dev",
  );
  proposeMetric(
    ledger,
    location.dir,
    { metric_id: "m-errors", command: ["sh", "bench/errors.sh"], unit: "%", watched_paths: [], image: null },
    "human:dev",
  );
  return { repo, home, env, location, ledger, goalFile };
}
