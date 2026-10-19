import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// covers: S11.5.outer-contracts-hold
// The outer suite is an independent check of the kernel: it may use the built executable and files, never the code
// it checks. If it imported src/, dist/ or tests/, a defect in the kernel could hide inside the check, and the suite of
// an old release could not be run against a new build. Only node: modules and files inside outer/ are allowed.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUTER = join(ROOT, "outer");
/** Every way a module is named in source: static import, `export from`, side-effect import, dynamic import() and require(). */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;
/** A dynamic import or require whose argument is not a plain string literal, and `createRequire`: not checkable, so refused. */
const COMPUTED = /\b(?:import|require)\s*\(\s*(?!["'][^"'$]*["']\s*\))|\bcreateRequire\b/;
const CODE = /\.(?:mjs|cjs|js|ts|mts|cts)$/;
const FAKE_NAME = /fake|mock|stub/i;
const FAKE_BODY = /FakeDocker|(?:fake|mock|stub)[-_ ]?docker|createServer|node:(?:http|https|net)\b/i;

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => name.split("\\").join("/"))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

/** Every way a tree under `outer` reaches outside itself, carries its own manifest or hides a stateful fake daemon. */
function problemsIn(outer: string): string[] {
  const problems: string[] = [];
  for (const name of filesIn(outer)) {
    const file = join(outer, name);
    if (basename(name) === "package.json") problems.push(`${name} is a manifest of its own`);
    if (FAKE_NAME.test(basename(name))) problems.push(`${name} is named like a fake daemon`);
    const text = readFileSync(file, "utf8");
    if (extname(name) !== ".md" && FAKE_BODY.test(text)) problems.push(`${name} holds a fake daemon or a server`);
    if (!CODE.test(name)) continue;
    if (COMPUTED.test(text)) problems.push(`${name} names a module in a way that cannot be checked`);
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith("node:")) continue;
      const rel = specifier.startsWith(".") ? relative(outer, resolve(dirname(file), specifier)) : null;
      if (rel === null || rel.startsWith("..") || isAbsolute(rel)) problems.push(`${name} imports ${specifier}`);
    }
  }
  return problems;
}

const planted = (files: Record<string, string>): string[] => {
  const dir = join(makeTempDir("omf-outer-scan-"), "outer");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return problemsIn(dir);
};

function outerFiles(): string[] {
  return filesIn(OUTER);
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

  it("imports only node: modules and files inside outer/, has no manifest of its own and no stateful fake daemon", () => {
    expect(problemsIn(OUTER)).toEqual([]);
  });

  it("the scan flags every way out (positive controls) and passes the allowed forms", () => {
    const bad: Array<[string, Record<string, string>]> = [
      ["a bare package", { "a.mjs": 'import x from "vitest";\n' }],
      ["an absolute path", { "a.mjs": 'import x from "/etc/x.mjs";\n' }],
      ["src", { "contracts/a.mjs": 'import x from "../../src/x.js";\n' }],
      ["a sibling directory named outer-evil", { "contracts/a.mjs": 'import x from "../../outer-evil/x.mjs";\n' }],
      ["a dynamic import", { "a.mjs": 'const m = await import("../src/x.js");\n' }],
      ["a require", { "a.cjs": 'const m = require("../src/x.js");\n' }],
      ["a template literal", { "a.mjs": "const m = await import(`../src/x.js`);\n" }],
      ["a computed import", { "a.mjs": "const m = await import(path);\n" }],
      [
        "createRequire",
        { "a.mjs": 'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\n' },
      ],
      ["a side-effect import", { "a.js": 'import "../src/x.js";\n' }],
      ["a typescript file", { "a.ts": 'import x from "../tests/helpers/x.js";\n' }],
      ["an export from", { "a.mjs": 'export { x } from "../src/x.js";\n' }],
      ["a nested manifest", { "lib/package.json": "{}\n" }],
      ["a renamed fake daemon", { "lib/mock-daemon.mjs": "export {};\n" }],
      ["a stub daemon by name", { "lib/stub-dockerd.mjs": "export {};\n" }],
      ["a fake docker by content", { "lib/a.mjs": "const FakeDocker = 1;\n" }],
      ["a fake docker by spelling", { "lib/a.mjs": "// fake_docker state\n" }],
      ["a server", { "lib/a.mjs": 'import { createServer } from "node:http";\n' }],
    ];
    for (const [name, files] of bad) expect(planted(files), name).not.toEqual([]);
    expect(
      planted({
        "run.mjs":
          'import { readFileSync } from "node:fs";\nimport { x } from "./lib/h.mjs";\nimport y from "../outer/lib/h.mjs";\n',
        "lib/h.mjs": "export const x = 1;\n",
        "README.md": "The stateful fake daemon stays with the in-repo tests.\n",
      }),
    ).toEqual([]);
  });
});
