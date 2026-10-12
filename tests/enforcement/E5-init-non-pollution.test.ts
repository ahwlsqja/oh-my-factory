import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { initProject } from "../../src/core/project.js";
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
});
