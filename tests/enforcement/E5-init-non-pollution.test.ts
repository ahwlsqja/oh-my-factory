import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { initProject } from "../../src/core/project.js";
import { approveGoal } from "../../src/goal/approve.js";
import { writePollutingAgentStubs } from "../helpers/agent-stubs.js";
import { omf } from "../helpers/cli.js";
import { setupGoal } from "../helpers/goal.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

/** Map of relative path -> content hash for every file under root (skipping .git). */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = sha256Hex(readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

/** Every path under root (directories included) and the hash of every file; null when root is absent. */
function treeState(root: string): unknown {
  if (!existsSync(root)) return null;
  return { paths: readdirSync(root, { recursive: true }).map(String).sort(), files: snapshot(root) };
}

/** The agent-owned state that OMF must never touch (spec §11 rule 1). */
function agentHomeState(home: string): unknown {
  const claudeJson = join(home, ".claude.json");
  return {
    claude: treeState(join(home, ".claude")),
    codex: treeState(join(home, ".codex")),
    claudeJson: existsSync(claudeJson) ? readFileSync(claudeJson, "utf8") : null,
  };
}

function makeUserHome(): string {
  const home = makeTempDir("omf-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}\n');
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
  writeFileSync(join(home, ".claude.json"), '{"projects":{}}\n');
  return home;
}

// Spec §11 rule 1: OMF only reads the user's repo, ~/.claude, ~/.claude.json and ~/.codex.
describe("E5 init-non-pollution", () => {
  it("omf init writes only under $HOME/.omf", () => {
    const repo = makeGitRepo();
    const home = makeUserHome();
    const before = {
      repo: snapshot(repo),
      claude: snapshot(join(home, ".claude")),
      codex: snapshot(join(home, ".codex")),
      claudeJson: readFileSync(join(home, ".claude.json"), "utf8"),
      status: execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" }),
    };

    initProject(repo, { HOME: home });

    expect(snapshot(repo)).toEqual(before.repo);
    expect(snapshot(join(home, ".claude"))).toEqual(before.claude);
    expect(snapshot(join(home, ".codex"))).toEqual(before.codex);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before.claudeJson);
    expect(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" })).toBe(
      before.status,
    );
    expect(existsSync(join(home, ".omf", "projects"))).toBe(true);
    expect(readdirSync(home).sort()).toEqual([".claude", ".claude.json", ".codex", ".omf"]);
  });

  it("omf doctor writes nothing to the repository, ~/.claude, ~/.claude.json or ~/.codex, even when the agent CLIs would", () => {
    const repo = makeGitRepo();
    const home = makeUserHome();
    const stubs = makeTempDir("omf-stubs-");
    writePollutingAgentStubs(stubs);
    const path = `${stubs}${delimiter}${process.env.PATH ?? ""}`;
    const gitStatus = (): string =>
      execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" });
    const before = { repo: snapshot(repo), agents: agentHomeState(home), status: gitStatus() };

    // The caller's config-dir overrides point into the watched home, so a probe that only replaced
    // HOME would still leak there.
    const result = omf(["doctor", "--json"], repo, home, {
      PATH: path,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    });

    // The polluting stubs must actually have run, or the comparison below proves nothing.
    expect(JSON.parse(result.stdout).tools.claude.found).toBe(true);
    expect(JSON.parse(result.stdout).tools.codex.found).toBe(true);
    expect(snapshot(repo)).toEqual(before.repo);
    expect(agentHomeState(home)).toEqual(before.agents);
    expect(gitStatus()).toBe(before.status);
  });

  it("goal audit, approve and measure leave the repository's git index untouched", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    // A stale stat entry is what makes git rewrite its index on a read.
    const touched = new Date(Date.now() - 60_000);
    utimesSync(join(fx.repo, "bench", "p95.sh"), touched, touched);
    utimesSync(join(fx.repo, "bench", "errors.sh"), touched, touched);
    const index = join(fx.repo, ".git", "index");
    const state = (): { bytes: string; mtime: bigint } => ({
      bytes: readFileSync(index).toString("hex"),
      mtime: statSync(index, { bigint: true }).mtimeNs,
    });
    const before = state();

    omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    approveGoal(fx.location, "g-fast", "human:dev");

    expect(state()).toEqual(before);
    expect(existsSync(`${index}.lock`)).toBe(false);
  });
});
