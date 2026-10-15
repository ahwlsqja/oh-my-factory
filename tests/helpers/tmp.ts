import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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

/**
 * Same as removeTempDirs, but removes the directories concurrently without blocking the worker thread.
 * The afterAll hook in tests/setup/cleanup.ts uses this: a synchronous recursive delete of a few thousand
 * fixture files took ~1.5 s per file on an idle machine and grew past the hook timeout under heavy load.
 */
export async function removeTempDirsAsync(): Promise<void> {
  await Promise.all(createdTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
    "-c",
    "user.name=omf-test",
    "-c",
    "user.email=omf-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  );
  return dir;
}

function testGitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    LC_ALL: "C",
  };
}

/** Runs git in `repo` and returns stdout. Throws with git's stderr on failure. */
export function gitIn(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: testGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Stages everything and commits it with a fixed test identity. */
export function commitAll(repo: string, message: string): void {
  gitIn(repo, "add", "-A");
  gitIn(
    repo,
    "-c",
    "user.name=omf-test",
    "-c",
    "user.email=omf-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  );
}
