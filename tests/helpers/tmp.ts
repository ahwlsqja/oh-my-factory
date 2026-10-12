import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every directory this process created through makeTempDir; removeTempDirs deletes them. */
const createdTempDirs: string[] = [];

export function makeTempDir(prefix = "omf-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

/** Deletes every directory made by makeTempDir so far and forgets them. Run after each test file. */
export function removeTempDirs(): void {
  for (const dir of createdTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A fresh git repository with one commit and no remote. */
export function makeGitRepo(): string {
  const dir = makeTempDir("omf-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
        LC_ALL: "C",
      },
    });
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git(
    "-c", "user.name=omf-test",
    "-c", "user.email=omf-test@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init",
  );
  return dir;
}
