import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitTarget } from "../../src/git/hardened.js";
import { commitAll, gitIn, makeGitRepo } from "./tmp.js";

export interface GitFixture {
  /** Real path of the work repository. */
  repo: string;
  /** `<repo>/.git` by real path, usable as the quarantine of `runHostGit` and every `ops` function. */
  quarantine: GitTarget;
  base: string;
  head: string;
}

function writeFiles(repo: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(repo, path);
    if (content === null) {
      rmSync(file);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * A real repository with two commits on top of `makeGitRepo`'s own: `base` holds `baseFiles`, `head` applies
 * `headChanges` (a path maps to its new content, or to null to delete it). Both sets must change something, because
 * an empty commit fails. The one fixture every gate, audit and prove-test test builds on.
 */
export function gitFixture(baseFiles: Record<string, string>, headChanges: Record<string, string | null>): GitFixture {
  if (Object.keys(baseFiles).length === 0 || Object.keys(headChanges).length === 0) {
    throw new Error("gitFixture needs at least one base file and one head change");
  }
  const repo = realpathSync(makeGitRepo());
  writeFiles(repo, baseFiles);
  commitAll(repo, "base");
  const base = gitIn(repo, "rev-parse", "HEAD").trim();
  writeFiles(repo, headChanges);
  commitAll(repo, "head");
  const head = gitIn(repo, "rev-parse", "HEAD").trim();
  return { repo, quarantine: { gitDir: realpathSync(join(repo, ".git")) }, base, head };
}
