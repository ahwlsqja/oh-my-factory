import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { gitEnv } from "../../src/core/paths.js";
import { exportBase, userHeadCommit } from "../../src/git/user-repo.js";
import { assertLineSafe } from "../../src/vault/line-guard.js";
import { PokaYokeError } from "../../src/vault/pokayoke.js";
import { setupDecisionItem } from "../helpers/decision-fixture.js";
import { put } from "../helpers/ops-fixture.js";
import { readTar } from "../helpers/tar-read.js";
import { gitIn, makeGitRepo } from "../helpers/tmp.js";
import { commitBlobs, committedBytes, trackedNames } from "../helpers/user-repo-fixture.js";

const MAX = 16 * 1024 * 1024;

// Spec §5.4, §7 (M3-D15): the container gets the tracked files of one base commit and nothing else. The user's work tree is
// never read, so ignored files, untracked files, uncommitted edits and a `.env` cannot reach the container, and no attribute
// decides what a file contains.
describe("W-worktree-tracked-only", () => {
  it("exports exactly the tracked files of the base commit, byte for byte, whatever else the work tree holds", async () => {
    const repo = makeGitRepo();
    put(repo, ".gitignore", "ignored.txt\n");
    commitBlobs(repo, {
      ".gitignore": { mode: "100644", bytes: "ignored.txt\n" },
      "src/a.ts": { mode: "100644", bytes: "export const a = 1;\n" },
      "bin/run.sh": { mode: "100755", bytes: "#!/bin/sh\n" },
      link: { mode: "120000", bytes: "src/a.ts" },
      "data.bin": { mode: "100644", bytes: Buffer.from([0, 1, 2, 255, 254]) },
    });
    const base = await userHeadCommit(repo);
    // Everything git would not commit, and one edit it has not committed yet.
    put(repo, "src/a.ts", "export const a = 2; // uncommitted\n");
    put(repo, "ignored.txt", "ignored\n");
    put(repo, "untracked.txt", "untracked\n");
    put(repo, ".env", "TOKEN=secret\n");
    put(repo, "vendor/dep/.git/HEAD", "ref: refs/heads/main\n");
    put(repo, "vendor/dep/index.js", "nested\n");

    const out = await exportBase({ repo, baseSha: base, maxBytes: MAX });
    const items = readTar(out.tar);

    expect(items.map((item) => item.path)).toEqual(trackedNames(repo, base));
    expect(out.tracked_paths).toEqual(trackedNames(repo, base));
    expect(items.some((item) => item.path.split("/").includes(".git"))).toBe(false);
    for (const item of items) {
      if (item.type === "file") expect(item.data.equals(committedBytes(repo, base, item.path)), item.path).toBe(true);
    }
    expect(items.find((item) => item.path === "src/a.ts")?.data.toString("utf8")).toBe("export const a = 1;\n");
    expect(items.find((item) => item.path === "bin/run.sh")?.mode).toBe(0o755);
    expect(items.find((item) => item.path === "link")).toMatchObject({ type: "symlink", linkName: "src/a.ts" });
    expect(out.base_tree_sha).toBe(gitIn(repo, "rev-parse", `${base}^{tree}`).trim());
  });

  it("applies no attribute: export-ignore, export-subst, ident and eol conversion leave the committed bytes", async () => {
    const repo = makeGitRepo();
    const attributes = [
      "docs/** export-ignore",
      "version.txt export-subst",
      "ident.txt ident",
      "crlf.cfg text=auto eol=lf",
      "*.sh text eol=crlf",
      "",
    ].join("\n");
    const files: Record<string, string> = {
      ".gitattributes": attributes,
      "docs/guide.md": "guide\n",
      "version.txt": "$Format:%H$\n",
      "ident.txt": "$Id$\n",
      "crlf.cfg": "a\r\nb\r\n",
      "run.sh": "echo hi\n",
    };
    const base = commitBlobs(
      repo,
      Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { mode: "100644" as const, bytes }])),
    );

    // Control: `git archive` of the same commit does apply them, so the fixture really exercises attributes.
    const archive = readTar(execFileSync("git", ["archive", "--format=tar", base], { cwd: repo, env: gitEnv() }));
    expect(archive.some((item) => item.path === "docs/guide.md")).toBe(false);
    expect(archive.find((item) => item.path === "version.txt")?.data.toString("utf8")).not.toBe(files["version.txt"]);

    const exported = new Map(
      readTar((await exportBase({ repo, baseSha: base, maxBytes: MAX })).tar).map((item) => [
        item.path,
        item.data.toString("utf8"),
      ]),
    );
    for (const [path, bytes] of Object.entries(files)) expect(exported.get(path), path).toBe(bytes);
  });

  it("refuses a tracked submodule instead of exporting an empty directory for it", async () => {
    const repo = makeGitRepo();
    const gitmodules = '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n';
    const base = commitBlobs(repo, {
      ".gitmodules": { mode: "100644", bytes: gitmodules },
      lib: { mode: "160000", sha: gitIn(repo, "rev-parse", "HEAD").trim() },
    });
    await expect(exportBase({ repo, baseSha: base, maxBytes: MAX })).rejects.toMatchObject({
      name: "UserRepoError",
      code: "submodule_present",
    });
    // Control: an untracked directory of the same name is just an untracked directory.
    const plain = makeGitRepo();
    put(plain, "lib/x.txt", "x\n");
    const head = await userHeadCommit(plain);
    expect((await exportBase({ repo: plain, baseSha: head, maxBytes: MAX })).tracked_paths).toEqual(["README.md"]);
  });

  it("the line guard refuses a repository that holds sealed material, which stops the export before it starts", () => {
    const f = setupDecisionItem();
    expect(() => assertLineSafe(f.fx.location, f.fx.env)).not.toThrow();
    put(f.fx.repo, "vault/scenarios/w-1/seal-1/s-1.yaml", "kind: behavior\n");
    expect(() => assertLineSafe(f.fx.location, f.fx.env)).toThrow(PokaYokeError);
  });
});
