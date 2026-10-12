import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertOutsideRepo,
  NotAGitRepoError,
  omfHome,
  projectDir,
  projectId,
  repoToplevel,
  UnsupportedRepoError,
} from "../../src/core/paths.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("omfHome", () => {
  it("uses OMF_HOME when it is set", () => {
    expect(omfHome({ OMF_HOME: "/x/omf", HOME: "/h" })).toBe("/x/omf");
  });

  it("falls back to $HOME/.omf", () => {
    expect(omfHome({ HOME: "/h" })).toBe("/h/.omf");
  });

  it("treats an empty OMF_HOME as unset", () => {
    expect(omfHome({ OMF_HOME: "", HOME: "/h" })).toBe("/h/.omf");
  });

  it("rejects a relative OMF_HOME", () => {
    expect(() => omfHome({ OMF_HOME: "state" })).toThrow(/must be an absolute path/);
  });

  it("treats an empty HOME as unset and falls back to the OS home directory", () => {
    expect(omfHome({ HOME: "" })).toBe(join(homedir(), ".omf"));
  });
});

describe("repoToplevel", () => {
  it("returns the real path of the repository root from a subdirectory", () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, "sub"));
    expect(repoToplevel(join(repo, "sub"))).toBe(realpathSync(repo));
  });

  it("throws NotAGitRepoError outside a repository", () => {
    expect(() => repoToplevel(makeTempDir())).toThrow(NotAGitRepoError);
  });

  it("resolves a linked worktree to the main repository root", () => {
    const repo = makeGitRepo();
    const wt = join(makeTempDir(), "wt");
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt"], {
      cwd: repo,
      stdio: "ignore",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
    expect(repoToplevel(wt)).toBe(realpathSync(repo));
    expect(projectId(repoToplevel(wt))).toBe(projectId(repoToplevel(repo)));
  });

  it("resolves a symlink to the same project identity", () => {
    const repo = makeGitRepo();
    const link = join(makeTempDir(), "link");
    symlinkSync(repo, link);
    expect(projectId(repoToplevel(link))).toBe(projectId(repoToplevel(repo)));
  });

  it("throws a plain error, not NotAGitRepoError, for a nonexistent directory", () => {
    let caught: unknown;
    try {
      repoToplevel("/nonexistent/omf-xyz");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/does not exist/);
    expect(caught).not.toBeInstanceOf(NotAGitRepoError);
  });

  it("throws UnsupportedRepoError for a bare repository", () => {
    const bare = join(makeTempDir(), "b.git");
    execFileSync("git", ["init", "-q", "--bare", bare], {
      stdio: "ignore",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
    expect(() => repoToplevel(bare)).toThrow(UnsupportedRepoError);
  });
});

describe("projectId and projectDir", () => {
  it("is 16 lowercase hex characters", () => {
    const repo = makeGitRepo();
    expect(projectId(repoToplevel(repo))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs between repositories", () => {
    expect(projectId(repoToplevel(makeGitRepo()))).not.toBe(projectId(repoToplevel(makeGitRepo())));
  });

  it("places the project under OMF_HOME/projects/<id>", () => {
    const repo = makeGitRepo();
    const id = projectId(repoToplevel(repo));
    expect(projectDir(repo, { OMF_HOME: "/x/omf" })).toBe(`/x/omf/projects/${id}`);
  });

  it("refuses OMF state inside the repository", () => {
    const repo = makeGitRepo();
    expect(() => projectDir(repo, { OMF_HOME: join(repo, ".omf") })).toThrow(/outside the repository/);
  });
});

describe("assertOutsideRepo", () => {
  it("throws when the directory is the repository root", () => {
    expect(() => assertOutsideRepo("/a/b", "/a/b")).toThrow();
  });

  it("does not throw for a directory outside the repository", () => {
    expect(() => assertOutsideRepo("/x/omf", "/a/b")).not.toThrow();
  });
});
