import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writePrivateFile, writePrivateFileAtomic } from "../../src/core/private-fs.js";
import { makeTempDir } from "../helpers/tmp.js";

const PRIVATE_FS_MODULE = resolve("dist/core/private-fs.js");

/** Child: rewrites one file `rounds` times, alternating two large payloads, so a non-atomic write would tear. */
const WRITER = `
const { writePrivateFileAtomic } = await import(process.argv[1]);
const [file, rounds] = process.argv.slice(2);
for (let i = 0; i < Number(rounds); i++) writePrivateFileAtomic(file, (i % 2 === 0 ? "b" : "a").repeat(200000));
`;

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);

describe("writePrivateFile", () => {
  it("creates missing parents at 0700 and the file at 0600", () => {
    const root = makeTempDir();
    const file = join(root, "a", "b", "f.txt");
    writePrivateFile(file, "x");
    expect(mode(file)).toBe("600");
    expect(mode(join(root, "a", "b"))).toBe("700");
    expect(mode(join(root, "a"))).toBe("700");
  });

  it("tightens an existing looser file to 0600", () => {
    const file = join(makeTempDir(), "f.txt");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    writePrivateFile(file, "new", "w");
    expect(mode(file)).toBe("600");
  });

  it("refuses to overwrite with flag wx", () => {
    const file = join(makeTempDir(), "f.txt");
    writePrivateFile(file, "one", "wx");
    expect(() => writePrivateFile(file, "two", "wx")).toThrow();
  });
});

describe("writePrivateFileAtomic", () => {
  it("creates missing parents at 0700 and the file at 0600", () => {
    const root = makeTempDir();
    const file = join(root, "a", "item.md");
    writePrivateFileAtomic(file, "x");
    expect(readFileSync(file, "utf8")).toBe("x");
    expect(mode(file)).toBe("600");
    expect(mode(join(root, "a"))).toBe("700");
  });

  it("replaces an existing file, tightens a looser mode and leaves no temp file behind", () => {
    const dir = makeTempDir();
    const file = join(dir, "item.md");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    writePrivateFileAtomic(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(mode(file)).toBe("600");
    expect(readdirSync(dir)).toEqual(["item.md"]);
  });

  it("leaves no temp file behind when the rename fails", () => {
    const dir = makeTempDir();
    const target = join(dir, "item.md");
    mkdirSync(target);
    expect(() => writePrivateFileAtomic(target, "new")).toThrow(/\bE[A-Z]{3,}\b/);
    expect(readdirSync(dir)).toEqual(["item.md"]);
  });

  it("never shows a concurrent reader a torn file", async () => {
    const file = join(makeTempDir(), "item.md");
    const a = "a".repeat(200_000);
    const b = "b".repeat(200_000);
    writePrivateFileAtomic(file, a);
    const child = spawn(process.execPath, ["--input-type=module", "-e", WRITER, PRIVATE_FS_MODULE, file, "200"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    let running = true;
    const exited = new Promise<number>((done, fail) => {
      child.on("error", fail);
      child.on("exit", (code) => {
        running = false;
        done(code ?? -1);
      });
    });
    let reads = 0;
    while (running) {
      const text = readFileSync(file, "utf8");
      expect(text === a || text === b).toBe(true);
      reads++;
      await new Promise((resolveTick) => setImmediate(resolveTick));
    }
    expect(await exited).toBe(0);
    expect(reads).toBeGreaterThan(0);
  });
});
