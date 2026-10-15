import { appendFileSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserRepoError, exportBase, userHeadCommit, userRepoTarget } from "../../src/git/user-repo.js";
import { listFiles, realTempDir } from "../helpers/ops-fixture.js";
import { readTar } from "../helpers/tar-read.js";
import { gitIn, makeGitRepo } from "../helpers/tmp.js";
import { type CommittedEntry, commitBlobs, trackedNames } from "../helpers/user-repo-fixture.js";

const MAX = 16 * 1024 * 1024;

/** The `UserRepoError` code of a failure, `other: ...` for any other error, "no error" when it succeeded. */
async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof UserRepoError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
}

/** A fresh repository with one extra commit holding `entries`, exported with `maxBytes`; the outcome's code. */
async function exportCode(entries: Record<string, CommittedEntry>, maxBytes = MAX): Promise<string> {
  const repo = makeGitRepo();
  const baseSha = commitBlobs(repo, entries);
  return codeOf(() => exportBase({ repo, baseSha, maxBytes }));
}

describe("userRepoTarget and userHeadCommit", () => {
  it("name .git by real path, refuse a .git that is not a plain directory, and report an unborn HEAD", async () => {
    const repo = makeGitRepo();
    expect(userRepoTarget(repo)).toEqual({ gitDir: join(realpathSync(repo), ".git") });
    const gitFile = realTempDir("omf-gitfile-");
    writeFileSync(join(gitFile, ".git"), "gitdir: /elsewhere\n");
    const linked = realTempDir("omf-gitlink-");
    symlinkSync(join(repo, ".git"), join(linked, ".git"));
    for (const bad of [gitFile, linked, realTempDir("omf-nogit-"), join(repo, "missing"), "relative/path"]) {
      expect(await codeOf(() => userRepoTarget(bad)), bad).toBe("git_dir_unsupported");
    }

    const head = gitIn(repo, "rev-parse", "HEAD").trim();
    expect(await userHeadCommit(repo)).toBe(head);
    gitIn(repo, "checkout", "-q", "--detach");
    expect(await userHeadCommit(repo)).toBe(head);
    const unborn = realTempDir("omf-unborn-");
    gitIn(unborn, "init", "-q", "-b", "main");
    expect(await codeOf(() => userHeadCommit(unborn))).toBe("head_unborn");
  });

  it("refuse a repository whose own config defines a filter or an include", async () => {
    for (const section of ['[filter "lfs"]\n\tclean = git-lfs clean -- %f\n', "[include]\n\tpath = ../extra.cfg\n"]) {
      const repo = makeGitRepo();
      appendFileSync(join(repo, ".git", "config"), section);
      const baseSha = gitIn(repo, "rev-parse", "HEAD").trim();
      expect(await codeOf(() => userHeadCommit(repo)), section).toBe("repo_has_drivers");
      expect(await codeOf(() => exportBase({ repo, baseSha, maxBytes: MAX })), section).toBe("repo_has_drivers");
    }
  });
});

describe("exportBase", () => {
  it("exports files, executables and symlinks of the base commit, twice the same, and changes nothing in .git", async () => {
    const repo = makeGitRepo();
    const baseSha = commitBlobs(repo, {
      "src/a.ts": { mode: "100644", bytes: "a\n" },
      "bin/tool": { mode: "100755", bytes: "#!/bin/sh\n" },
      link: { mode: "120000", bytes: "src/a.ts" },
      "empty.txt": { mode: "100644", bytes: "" },
    });
    const snapshot = (): unknown => [
      listFiles(join(repo, ".git")),
      readFileSync(join(repo, ".git", "index")).toString("hex"),
      readFileSync(join(repo, ".git", "config"), "utf8"),
    ];
    const before = snapshot();
    const out = await exportBase({ repo, baseSha, maxBytes: MAX });
    expect(snapshot()).toEqual(before);
    expect(await exportBase({ repo, baseSha, maxBytes: MAX })).toEqual(out);

    expect(out.tracked_paths).toEqual(trackedNames(repo, baseSha));
    expect(out.tracked_paths).toEqual(["README.md", "bin/tool", "empty.txt", "link", "src/a.ts"]);
    expect(out.base_tree_sha).toBe(gitIn(repo, "rev-parse", `${baseSha}^{tree}`).trim());
    const items = new Map(readTar(out.tar).map((item) => [item.path, item]));
    expect(items.get("bin/tool")?.mode).toBe(0o755);
    expect(items.get("src/a.ts")?.mode).toBe(0o644);
    expect(items.get("empty.txt")?.data).toHaveLength(0);
    expect(items.get("link")).toMatchObject({ type: "symlink", linkName: "src/a.ts" });
  });

  it("refuses a base that is missing, is not a commit, or does not fit, with a closed code", async () => {
    const repo = makeGitRepo();
    const head = gitIn(repo, "rev-parse", "HEAD").trim();
    const tree = gitIn(repo, "rev-parse", "HEAD^{tree}").trim();
    const run = (baseSha: string, maxBytes = MAX): Promise<string> =>
      codeOf(() => exportBase({ repo, baseSha, maxBytes }));
    expect(await run("0".repeat(40))).toBe("base_missing");
    expect(await run("main")).toBe("base_missing");
    expect(await run(tree)).toBe("base_not_commit");
    expect(await run(head)).toBe("no error");
    expect(await run(head, 100), "the tarball is larger than the cap").toBe("export_too_large");
    const big = commitBlobs(repo, { "big.txt": { mode: "100644", bytes: "x".repeat(5000) } });
    expect(await run(big, 3000), "the blobs are larger than the cap").toBe("export_too_large");
    expect(await run(big)).toBe("no error");
  });

  it("refuses a tracked .gitattributes that sets the lfs filter, at any depth, and only a real attribute line", async () => {
    const lfs = "*.bin filter=lfs diff=lfs merge=lfs -text\n";
    expect(await exportCode({ ".gitattributes": { mode: "100644", bytes: lfs } })).toBe("lfs_pointers");
    expect(await exportCode({ "assets/.gitattributes": { mode: "100644", bytes: `*.txt text\r\n${lfs}` } })).toBe(
      "lfs_pointers",
    );
    expect(await exportCode({ ".gitattributes": { mode: "100644", bytes: `# ${lfs}` } })).toBe("no error");
    expect(await exportCode({ ".gitattributes": { mode: "100644", bytes: "*.bin filter=lfsx\n" } })).toBe("no error");
  });
});
