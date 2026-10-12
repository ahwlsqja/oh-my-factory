import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./canonical-json.js";

export class NotAGitRepoError extends Error {
  constructor(readonly cwd: string) {
    super(`not a git repository: ${cwd}`);
    this.name = "NotAGitRepoError";
  }
}

/** Root of all OMF host state. Never inside the user's repository. */
export function omfHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMF_HOME ?? join(env.HOME ?? homedir(), ".omf");
}

export function repoToplevel(cwd: string): string {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new NotAGitRepoError(cwd);
  }
  return realpathSync(out.trim());
}

/** First 16 hex characters of the SHA-256 of the repository's real path. */
export function projectId(toplevel: string): string {
  return sha256Hex(realpathSync(toplevel)).slice(0, 16);
}

export function projectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(omfHome(env), "projects", projectId(repoToplevel(cwd)));
}
