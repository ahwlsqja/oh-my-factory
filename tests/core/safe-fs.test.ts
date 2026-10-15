import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SymlinkRefusedError,
  UnsafePathError,
  assertNoSymlinksBelow,
  listSymlinksBelow,
  mkdirPrivate,
  readRegularNoFollow,
  stateRoot,
  writeNewNoFollow,
} from "../../src/core/safe-fs.js";
import { runChild } from "../helpers/child.js";
import { makeTempDir } from "../helpers/tmp.js";

/** A real (symlink-free) state root: the realpath of a fresh `.omf`. */
function newRoot(): string {
  const home = join(makeTempDir("omf-safe-"), ".omf");
  mkdirSync(home);
  return stateRoot({ OMF_HOME: home });
}

function refusal(fn: () => unknown): SymlinkRefusedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SymlinkRefusedError) return err;
    throw err;
  }
  throw new Error("expected a SymlinkRefusedError, nothing was thrown");
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof UnsafePathError) return err.code;
    throw err;
  }
  return "no error";
}

const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

describe("stateRoot", () => {
  it("resolves a symlinked home once, so a dotfile-managed or /var-style home works", () => {
    const real = makeTempDir("omf-real-");
    const link = join(makeTempDir("omf-link-"), "home");
    symlinkSync(real, link);
    expect(stateRoot({ OMF_HOME: link })).toBe(realpathSync.native(real));
  });

  it("throws when the home does not exist", () => {
    expect(() => stateRoot({ OMF_HOME: join(makeTempDir("omf-none-"), "absent") })).toThrow(/ENOENT/);
  });
});

describe("assertNoSymlinksBelow", () => {
  it("refuses a link at any level and names it relative to the root", () => {
    const root = newRoot();
    const outside = makeTempDir("omf-outside-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(outside, "f"), "x");
    symlinkSync(outside, join(root, "a", "dirlink"));
    symlinkSync(join(outside, "f"), join(root, "a", "b", "filelink"));
    symlinkSync(join(outside, "gone"), join(root, "a", "dangling"));

    expect(refusal(() => assertNoSymlinksBelow(root, join(root, "a", "dirlink", "x", "y"))).relPath).toBe("a/dirlink");
    expect(refusal(() => assertNoSymlinksBelow(root, join(root, "a", "b", "filelink"))).relPath).toBe("a/b/filelink");
    expect(refusal(() => assertNoSymlinksBelow(root, join(root, "a", "dangling"))).relPath).toBe("a/dangling");
  });

  it("accepts the root itself and ends the walk at a missing component", () => {
    const root = newRoot();
    mkdirSync(join(root, "a"));
    expect(() => assertNoSymlinksBelow(root, root)).not.toThrow();
    expect(() => assertNoSymlinksBelow(root, join(root, "a", "missing", "deeper"))).not.toThrow();
  });

  it("refuses a target outside the root, including a sibling that shares the prefix", () => {
    const root = newRoot();
    expect(codeOf(() => assertNoSymlinksBelow(root, join(`${root}-evil`, "x")))).toBe("outside_root");
    expect(codeOf(() => assertNoSymlinksBelow(root, join(root, "..", "x")))).toBe("outside_root");
  });
});

describe("listSymlinksBelow", () => {
  it("lists every link below dir without following it; skip names top-level entries that are not walked", () => {
    const root = newRoot();
    const outside = makeTempDir("omf-outside-");
    const dir = join(root, "p");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, "worktrees", "wt"), { recursive: true });
    symlinkSync(outside, join(dir, "sub", "inner"));
    symlinkSync(outside, join(dir, "worktrees", "wt", "node_modules"));

    expect(listSymlinksBelow(root, dir, { skip: ["worktrees"] })).toEqual(["p/sub/inner"]);
    expect(listSymlinksBelow(root, dir)).toEqual(["p/sub/inner", "p/worktrees/wt/node_modules"]);
  });

  it("reports a skipped entry that is itself a link, and returns [] for a missing dir", () => {
    const root = newRoot();
    const outside = makeTempDir("omf-outside-");
    mkdirSync(join(root, "p"));
    symlinkSync(outside, join(root, "p", "worktrees"));
    expect(listSymlinksBelow(root, join(root, "p"), { skip: ["worktrees"] })).toEqual(["p/worktrees"]);
    expect(listSymlinksBelow(root, join(root, "nothing"))).toEqual([]);
  });
});

describe("mkdirPrivate", () => {
  it("refuses a link component and creates nothing through it", () => {
    const root = newRoot();
    const outside = makeTempDir("omf-outside-");
    symlinkSync(outside, join(root, "v"));
    expect(refusal(() => mkdirPrivate(root, join(root, "v", "scenarios"))).relPath).toBe("v");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a component that is a regular file", () => {
    const root = newRoot();
    writeFileSync(join(root, "f"), "x");
    expect(codeOf(() => mkdirPrivate(root, join(root, "f", "g")))).toBe("exists");
  });

  it.each(["000", "277"])("creates directories at 0700 and files at 0600 under umask %s", async (mask) => {
    const root = newRoot();
    const url = pathToFileURL(resolve("dist", "core", "safe-fs.js")).href;
    // Run in a child so the umask is real; the built module is what the CLI uses.
    const script = `const [url, root, mask] = process.argv.slice(1);
const m = await import(url);
process.umask(parseInt(mask, 8));
m.mkdirPrivate(root, root + "/x/y");
m.writeNewNoFollow(root, root + "/x/y/f", "data");`;
    const run = await runChild(script, [url, root, mask]);
    expect(run.code).toBe(0);
    expect(modeOf(join(root, "x"))).toBe("700");
    expect(modeOf(join(root, "x", "y"))).toBe("700");
    expect(modeOf(join(root, "x", "y", "f"))).toBe("600");
  });
});

describe("readRegularNoFollow and writeNewNoFollow", () => {
  it("reads a regular file and refuses a link to one", () => {
    const root = newRoot();
    const outside = makeTempDir("omf-outside-");
    writeFileSync(join(root, "real.txt"), "hello");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    expect(readRegularNoFollow(root, join(root, "real.txt"), 100).toString("utf8")).toBe("hello");
    expect(refusal(() => readRegularNoFollow(root, join(root, "link.txt"), 100)).relPath).toBe("link.txt");
  });

  it("reports missing, too_large and not_regular_file with their codes", () => {
    const root = newRoot();
    writeFileSync(join(root, "ten.txt"), "0123456789");
    mkdirSync(join(root, "dir"));
    expect(codeOf(() => readRegularNoFollow(root, join(root, "absent.txt"), 100))).toBe("missing");
    expect(codeOf(() => readRegularNoFollow(root, join(root, "ten.txt"), 5))).toBe("too_large");
    expect(codeOf(() => readRegularNoFollow(root, join(root, "dir"), 100))).toBe("not_regular_file");
    expect(codeOf(() => readRegularNoFollow(root, join(root, "..", "x"), 100))).toBe("outside_root");
  });

  it("writes a new file at 0600, refuses to overwrite, and refuses to write through a link", () => {
    const root = newRoot();
    const outside = makeTempDir("omf-outside-");
    writeFileSync(join(outside, "victim.txt"), "KEEP");
    symlinkSync(join(outside, "victim.txt"), join(root, "out.txt"));

    writeNewNoFollow(root, join(root, "new.txt"), "data");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("data");
    expect(modeOf(join(root, "new.txt"))).toBe("600");
    expect(codeOf(() => writeNewNoFollow(root, join(root, "new.txt"), "again"))).toBe("exists");
    expect(refusal(() => writeNewNoFollow(root, join(root, "out.txt"), "PWNED")).relPath).toBe("out.txt");
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("KEEP");
  });
});
