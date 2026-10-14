import { chmodSync, existsSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HARDENED_GIT_CONFIG, HostGitError, createScratchGitDir, hardenedGitEnv, runHostGit } from "../../src/git/hardened.js";
import { type GitFixture, gitFixture } from "../helpers/git-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

let fx: GitFixture;
beforeAll(() => {
  fx = gitFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });
});
afterEach(() => vi.unstubAllEnvs());

describe("HARDENED_GIT_CONFIG", () => {
  it("is the pinned list, byte for byte", () => {
    expect([...HARDENED_GIT_CONFIG]).toEqual([
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.pager=cat",
      "-c", "protocol.file.allow=never", "-c", "protocol.allow=never",
      "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "receive.fsckObjects=true",
      "-c", "gc.auto=0", "-c", "maintenance.auto=false",
    ]);
  });
});

describe("hardenedGitEnv", () => {
  it("keeps PATH only, drops every GIT_* and other variable, and sets the seven fixed ones", () => {
    const env = hardenedGitEnv({
      PATH: "/usr/bin", HOME: "/home/x", XDG_CONFIG_HOME: "/x", GIT_DIR: "/evil", GIT_WORK_TREE: "/evil", GIT_INDEX_FILE: "/evil",
      GIT_CONFIG_COUNT: "1", GIT_EXEC_PATH: "/evil", LC_ALL: "de_DE.UTF-8",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      LC_ALL: "C",
    });
  });

  it("has no PATH when the base has none", () => {
    expect(hardenedGitEnv({})).not.toHaveProperty("PATH");
  });
});

describe("runHostGit target checks", () => {
  it("refuses a relative path in any of the three target fields", async () => {
    await expect(runHostGit({ gitDir: "relative/.git" }, ["status"])).rejects.toMatchObject({ code: "not_absolute" });
    await expect(runHostGit({ ...fx.quarantine, workTree: "rel" }, ["status"])).rejects.toMatchObject({ code: "not_absolute" });
    await expect(runHostGit({ ...fx.quarantine, indexFile: "rel/index" }, ["status"])).rejects.toMatchObject({ code: "not_absolute" });
  });

  it("refuses a symlinked git dir, a directory without HEAD and a missing one", async () => {
    const link = join(makeTempDir("omf-link-"), "link.git");
    symlinkSync(fx.quarantine.gitDir, link);
    await expect(runHostGit({ gitDir: link }, ["rev-parse", "HEAD"])).rejects.toMatchObject({ code: "gitdir_invalid" });
    await expect(runHostGit({ gitDir: makeTempDir("omf-empty-") }, ["rev-parse", "HEAD"])).rejects.toMatchObject({ code: "gitdir_invalid" });
    await expect(runHostGit({ gitDir: join(makeTempDir("omf-none-"), "none.git") }, ["rev-parse", "HEAD"])).rejects.toMatchObject({
      code: "gitdir_invalid",
    });
  });

  it("accepts a good git dir and returns bytes", async () => {
    const out = await runHostGit(fx.quarantine, ["rev-parse", "HEAD"]);
    expect(out.stdout.toString("utf8").trim()).toBe(fx.head);
  });
});

describe("runHostGit environment", () => {
  it("ignores a hostile GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_* and global config in the caller environment", async () => {
    const evil = makeTempDir("omf-evil-");
    const globalConfig = join(evil, "gitconfig");
    writeFileSync(globalConfig, "[core]\n\tfsmonitor = /evil/monitor\n");
    vi.stubEnv("GIT_DIR", join(evil, "nope"));
    vi.stubEnv("GIT_WORK_TREE", evil);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", join(evil, "hooks"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);

    const dir = await runHostGit(fx.quarantine, ["rev-parse", "--absolute-git-dir"]);
    expect(dir.stdout.toString("utf8").trim()).toBe(fx.quarantine.gitDir);
    const hooks = await runHostGit(fx.quarantine, ["config", "--get", "core.hooksPath"]);
    expect(hooks.stdout.toString("utf8").trim()).toBe("/dev/null");
    const monitor = await runHostGit(fx.quarantine, ["config", "--get", "core.fsmonitor"]);
    expect(monitor.stdout.toString("utf8").trim()).toBe("false");
  });

  it("sets GIT_INDEX_FILE from the target after hardening, and ignores the caller's", async () => {
    const hostile = join(makeTempDir("omf-hostile-index-"), "index");
    vi.stubEnv("GIT_INDEX_FILE", hostile);
    const indexFile = join(makeTempDir("omf-index-"), "index");
    await runHostGit({ ...fx.quarantine, indexFile }, ["read-tree", fx.head]);
    expect(existsSync(indexFile)).toBe(true);
    expect(existsSync(hostile)).toBe(false);
  });

  it("refuses read-tree without an indexFile, so the repository's own index is never written", async () => {
    await expect(runHostGit(fx.quarantine, ["read-tree", fx.head])).rejects.toMatchObject({ code: "gitdir_invalid" });
  });
});

/** A `git` on PATH that behaves as the script says; the module resolves `git` through the PATH it was started with. */
function fakeGit(script: string): void {
  const bin = makeTempDir("omf-fake-git-");
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", bin);
}

describe("runHostGit limits and errors", () => {
  it("stops at the output cap", async () => {
    await expect(runHostGit(fx.quarantine, ["cat-file", "-p", fx.head], { maxOutputBytes: 10 })).rejects.toMatchObject({ code: "output_limit" });
  });

  it("stops at the timeout", async () => {
    fakeGit("exec /bin/sleep 5");
    await expect(runHostGit(fx.quarantine, ["status"], { timeoutMs: 150 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports a failing git as git_failed with the exit status", async () => {
    fakeGit("exit 7");
    await expect(runHostGit(fx.quarantine, ["status"])).rejects.toMatchObject({ code: "git_failed", exitStatus: 7 });
  });

  it("puts the code and the exit status in the message and no path anywhere printable", async () => {
    const parent = makeTempDir("omf-scratch-parent-");
    const scratch = await createScratchGitDir(parent);
    const work = makeTempDir("omf-apply-");
    const patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const failure = await runHostGit({ gitDir: scratch, workTree: work }, ["apply", "--check", "-"], { input: patch, cwd: work }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HostGitError);
    const error = failure as HostGitError;
    expect(error.code).toBe("git_failed");
    expect(error.exitStatus).toBe(1);
    for (const text of [error.message, String(error), JSON.stringify(error), JSON.stringify(Object.keys(error))]) {
      expect(text).not.toContain("x.ts");
    }
    expect(Object.keys(error)).not.toContain("diagnostic");
    expect(String(Reflect.get(error, "diagnostic"))).toContain("x.ts"); // kept for a human, never printed
  });
});

describe("createScratchGitDir", () => {
  it("makes an empty bare repository with no hooks in a private directory that runHostGit accepts", async () => {
    const gitDir = await createScratchGitDir(makeTempDir("omf-scratch-parent-"));
    const hooks = join(gitDir, "hooks");
    expect(existsSync(hooks) ? readdirSync(hooks) : []).toEqual([]);
    expect(statSync(dirname(gitDir)).mode & 0o777).toBe(0o700);
    const bare = await runHostGit({ gitDir }, ["rev-parse", "--is-bare-repository"]);
    expect(bare.stdout.toString("utf8").trim()).toBe("true");
  });

  it("refuses a relative parent, a parent inside an agent home and, when given the repository, a parent inside it", async () => {
    await expect(createScratchGitDir("relative")).rejects.toMatchObject({ code: "not_absolute" });
    const home = makeTempDir("omf-home-");
    vi.stubEnv("HOME", home);
    await expect(createScratchGitDir(join(home, ".claude", "scratch"))).rejects.toThrow(/must not live inside/);
    await expect(createScratchGitDir(join(fx.repo, "inside"), fx.repo)).rejects.toThrow(/must live outside the repository/);
  });
});
