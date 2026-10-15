import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type TreeReadErrorCode, TreeLimitError, TreeReadError, readTreeFile, walkTree } from "../../src/git/tree-walk.js";
import { makeTempDir } from "../helpers/tmp.js";

/** A tree with a file, an executable, a directory, a `.git` directory and a symlink to a directory that holds a secret. */
function hostile(): { root: string; outside: string } {
  const root = makeTempDir("omf-walk-");
  const outside = makeTempDir("omf-outside-");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "b.txt"), "hello\n");
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  symlinkSync(outside, join(root, "vault"));
  symlinkSync("a/b.txt", join(root, "file-link"));
  return { root, outside };
}

function codeOf(run: () => unknown): TreeReadErrorCode | "no error" {
  try {
    run();
  } catch (error) {
    if (error instanceof TreeReadError) return error.code;
    throw error;
  }
  return "no error";
}

describe("walkTree", () => {
  it("lists entries sorted, reports a symlink without following it, and treats .git as an ordinary entry", () => {
    const { root } = hostile();
    const entries = walkTree(root);
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "dir:.git",
      "file:.git/config",
      "dir:a",
      "file:a/b.txt",
      "symlink:file-link",
      "file:run.sh",
      "symlink:vault",
    ]);
    expect(entries.find((e) => e.path === "a/b.txt")).toMatchObject({ size: 6, executable: false });
    expect(entries.find((e) => e.path === "run.sh")).toMatchObject({ executable: true });
    expect(entries.some((e) => e.path.startsWith("vault/"))).toBe(false); // the symlink was not descended
  });

  it("reports a FIFO as other", () => {
    const root = makeTempDir("omf-walk-fifo-");
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(walkTree(root)).toMatchObject([{ path: "pipe", kind: "other" }]);
  });

  it("enforces the entry and depth limits", () => {
    const { root } = hostile();
    expect(() => walkTree(root, { maxEntries: 3 })).toThrow(TreeLimitError);
    const deep = makeTempDir("omf-walk-deep-");
    mkdirSync(join(deep, "a", "b"), { recursive: true });
    writeFileSync(join(deep, "a", "b", "c.txt"), "x\n");
    expect(() => walkTree(deep, { maxDepth: 2 })).toThrow(TreeLimitError);
    expect(walkTree(deep, { maxDepth: 3 }).map((e) => e.path)).toEqual(["a", "a/b", "a/b/c.txt"]);
  });
});

describe("readTreeFile", () => {
  it("reads a regular file", () => {
    const { root } = hostile();
    expect(readTreeFile(root, "a/b.txt").toString("utf8")).toBe("hello\n");
    expect(readTreeFile(root, "./a//b.txt").toString("utf8")).toBe("hello\n");
  });

  it("refuses a symlink anywhere in the path, also as the leaf", () => {
    const { root } = hostile();
    expect(codeOf(() => readTreeFile(root, "vault/secret.txt"))).toBe("symlink_in_path");
    expect(codeOf(() => readTreeFile(root, "file-link"))).toBe("symlink_in_path");
  });

  it("refuses a FIFO without blocking, a directory and a missing file", () => {
    const { root } = hostile();
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(codeOf(() => readTreeFile(root, "pipe"))).toBe("not_regular");
    expect(codeOf(() => readTreeFile(root, "a"))).toBe("not_regular");
    expect(codeOf(() => readTreeFile(root, "a/none.txt"))).toBe("missing");
    expect(codeOf(() => readTreeFile(root, "none/none.txt"))).toBe("missing");
  });

  it("refuses .., an absolute path and a NUL", () => {
    const { root } = hostile();
    expect(codeOf(() => readTreeFile(root, "../outside.txt"))).toBe("outside_root");
    expect(codeOf(() => readTreeFile(root, "a/../../x"))).toBe("outside_root");
    expect(codeOf(() => readTreeFile(root, "/etc/passwd"))).toBe("outside_root");
    expect(codeOf(() => readTreeFile(root, "a/b.txt\0.png"))).toBe("outside_root");
  });

  it("refuses a file over the cap", () => {
    const { root } = hostile();
    expect(codeOf(() => readTreeFile(root, "a/b.txt", 5))).toBe("too_large");
    expect(readTreeFile(root, "a/b.txt", 6).length).toBe(6);
  });

  it("keeps the path out of the error message", () => {
    const { root } = hostile();
    try {
      readTreeFile(root, "vault/secret.txt");
    } catch (error) {
      expect((error as Error).message).toBe("symlink_in_path");
    }
  });
});
