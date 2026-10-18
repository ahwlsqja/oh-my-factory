import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: S11.5.outer-contracts-hold
// The outer suite is an independent check of the kernel: it may use the built executable and files, never the code
// it checks. If it imported src/, dist/ or tests/, a defect in the kernel could hide inside the check, and the suite of
// an old release could not be run against a new build. Only node: modules and files inside outer/ are allowed.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUTER = join(ROOT, "outer");
/** Every way a module is named in .mjs source: static import, `export from`, dynamic import() and require(). */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function outerFiles(): string[] {
  if (!existsSync(OUTER)) return [];
  return readdirSync(OUTER, { recursive: true, encoding: "utf8" })
    .map((name) => name.split("\\").join("/"))
    .filter((name) => statSync(join(OUTER, name)).isFile())
    .sort();
}

/** The id in `contracts/K07-name.mjs`. */
const idOf = (name: string): string => name.slice("contracts/".length, "contracts/K01".length);

describe("W-outer-no-src-import", () => {
  it("has one file per contract K01 to K09, each opening with the promise it checks", () => {
    const contracts = outerFiles().filter((name) => /^contracts\/K\d\d-.+\.mjs$/.test(name));
    expect(contracts.map(idOf)).toEqual(["K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08", "K09"]);
    for (const name of contracts) {
      const opening = readFileSync(join(OUTER, name), "utf8").startsWith(`// ${idOf(name)}: `);
      expect(opening, `${name} must open with "// ${idOf(name)}: "`).toBe(true);
    }
  });

  it("imports only node: modules and files inside outer/", () => {
    const bad: string[] = [];
    for (const name of outerFiles().filter((file) => file.endsWith(".mjs"))) {
      const text = readFileSync(join(OUTER, name), "utf8");
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith("node:")) continue;
        const target = specifier.startsWith(".") ? resolve(dirname(join(OUTER, name)), specifier) : null;
        if (target === null || !target.startsWith(OUTER + sep)) bad.push(`${name} imports ${specifier}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("has no manifest of its own and no stateful fake daemon", () => {
    const files = outerFiles();
    expect(files.filter((name) => name === "package.json" || /fake/i.test(name))).toEqual([]);
    const naming = files.filter((name) => /FakeDocker|fake-docker/.test(readFileSync(join(OUTER, name), "utf8")));
    expect(naming).toEqual([]);
  });
});
