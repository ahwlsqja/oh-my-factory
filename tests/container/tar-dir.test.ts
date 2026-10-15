import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TarError, type TarEntry, type TarErrorCode, tarOfDir, tarOfEntries } from "../../src/container/tar-dir.js";
import { walkTree } from "../../src/git/tree-walk.js";
import { put, realTempDir } from "../helpers/ops-fixture.js";

/** Name and type flag of every header in a ustar archive (the prefix field is joined back on). */
function headers(tar: Buffer): Array<{ name: string; type: string }> {
  const text = (block: Buffer, start: number, length: number): string =>
    block.toString("utf8", start, start + length).split("\0")[0] ?? "";
  const found: Array<{ name: string; type: string }> = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const prefix = text(block, 345, 155);
    const name = text(block, 0, 100);
    found.push({ name: prefix === "" ? name : `${prefix}/${name}`, type: String.fromCharCode(block[156] ?? 0) });
    const size = Number.parseInt(text(block, 124, 12).trim(), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

describe("tarOfDir", () => {
  it("extracts to the same tree with the host tar: long paths, an executable, an empty directory and a symlink", () => {
    const root = realTempDir("omf-tar-src-");
    const deep = `${"d".repeat(60)}/${"e".repeat(60)}`;
    put(root, "src/a.txt", "alpha\n");
    put(root, "bin/run.sh", "#!/bin/sh\n");
    chmodSync(join(root, "bin/run.sh"), 0o755);
    put(root, `${deep}/f.txt`, "long\n");
    mkdirSync(join(root, "empty"));
    symlinkSync("src/a.txt", join(root, "link"));
    const out = realTempDir("omf-tar-out-");
    const file = join(realTempDir("omf-tar-file-"), "tree.tar");
    writeFileSync(file, tarOfDir(root));
    execFileSync("tar", ["-xf", file, "-C", out]);
    expect(walkTree(out)).toEqual(walkTree(root));
    expect(readlinkSync(join(out, "link"))).toBe("src/a.txt");
    expect(readFileSync(join(out, deep, "f.txt"), "utf8")).toBe("long\n");
  });

  it("writes a symlink as a symlink entry and never reads what it points at", () => {
    const parent = realTempDir("omf-tar-esc-");
    put(parent, "outside/secret.txt", "TOP-SECRET\n");
    mkdirSync(join(parent, "tree"));
    symlinkSync("../outside", join(parent, "tree/link"));
    const tar = tarOfDir(join(parent, "tree"));
    expect(headers(tar)).toEqual([{ name: "link", type: "2" }]);
    expect(tar.includes("TOP-SECRET")).toBe(false);
  });
});

describe("tarOfEntries refusals", () => {
  const entry = (path: string, over: Partial<TarEntry> = {}): TarEntry => ({
    path,
    kind: "file",
    data: Buffer.from("x"),
    linkTarget: "",
    executable: false,
    ...over,
  });
  const ROWS: Array<[string, TarEntry, TarErrorCode]> = [
    ["a parent segment", entry("../x"), "path_escapes_root"],
    ["an absolute path", entry("/etc/x"), "path_escapes_root"],
    ["an empty segment", entry("a//b"), "path_escapes_root"],
    ["a single segment over 100 bytes", entry("x".repeat(101)), "path_too_long"],
    ["a link target over 100 bytes", entry("l", { kind: "symlink", linkTarget: "y".repeat(101) }), "link_too_long"],
  ];
  it.each(ROWS)("refuses %s", (_name, bad, code) => {
    let caught: unknown;
    try {
      tarOfEntries([bad]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TarError);
    expect((caught as TarError).code).toBe(code);
  });
});
