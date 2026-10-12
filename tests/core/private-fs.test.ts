import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePrivateFile } from "../../src/core/private-fs.js";
import { makeTempDir } from "../helpers/tmp.js";

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
