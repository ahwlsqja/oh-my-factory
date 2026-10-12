import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "omf-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
