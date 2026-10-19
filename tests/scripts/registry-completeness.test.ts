import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";
import {
  DEV_ONLY_TOP_LEVEL,
  checkEnforcementReadme,
  checkSchemasReferenced,
  checkShippedExist,
  checkTopLevel,
  repoFiles,
  shippedTopLevel,
} from "../helpers/registries.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/*
 * Registry inventory (hand-maintained lists and what makes a missing entry fail):
 *  - package.json "files" and scripts/pack-smoke.mjs allowlist: pack-smoke derives both from package.json; the
 *    top-level check below fails on a new entry that is in neither "files" nor DEV_ONLY_TOP_LEVEL.
 *  - FIXTURE_ALLOWLIST (src/scenario/fixtures.ts): tests/scenario/fixtures.test.ts already fails on a fixture
 *    file the list does not name and on a hash drift.
 *  - tests/enforcement/README.md table: checked in both directions here.
 *  - schemas/: every file must be named outside schemas/ here.
 *  - risk globs (DEFAULT_HIGH_RISK in src/work/risk.ts, EXTRA_HIGH_RISK_GLOBS in src/core/config.ts): these are
 *    policy data, not directory lists. tests/work/risk.test.ts and tests/core/config.test.ts cover their
 *    behaviour; no completeness check is added because there is no directory they must enumerate.
 *  - source roots: src/* subdirectories are covered wholesale by tsconfig "include": ["src"] and the coverage
 *    include "src/**" in vitest.config.ts, so no per-directory registry exists. Only top-level entries are checked.
 *  - kernel path manifest (#39): no such file exists in this tree, so there is nothing to check here.
 *  - golden argv files: src/container/golden.ts builds them from the role table; tests/container/golden.test.ts
 *    covers every role, so there is no second list.
 */
describe("registry completeness", () => {
  it("every top-level entry ships or is dev only", () => {
    const tops = repoFiles(ROOT).map((f) => f.split("/")[0] as string);
    expect(checkTopLevel(tops, shippedTopLevel(ROOT))).toEqual([]);
  });

  it("names the entry and the registry for an unregistered top-level directory, and passes once registered", () => {
    const tops = ["src", "newdir"];
    const shipped = shippedTopLevel(ROOT);
    const problems = checkTopLevel(tops, shipped);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"newdir"');
    expect(problems[0]).toContain("package.json");
    expect(problems[0]).toContain("DEV_ONLY_TOP_LEVEL");
    expect(checkTopLevel(tops, shipped, [...DEV_ONLY_TOP_LEVEL, "newdir"])).toEqual([]);
    expect(checkTopLevel(tops, [...shipped, "newdir"])).toEqual([]);
  });

  it("every package.json files entry exists", () => {
    const tops = repoFiles(ROOT).map((f) => f.split("/")[0] as string);
    expect(checkShippedExist(shippedTopLevel(ROOT), tops)).toEqual([]);
    expect(checkShippedExist(["gone", "dist"], ["src"])).toEqual([
      'package.json "files" names "gone", which is not in the repository',
    ]);
  });

  it("scripts/pack-smoke.mjs derives its allowlist from package.json files", () => {
    const src = readFileSync(join(ROOT, "scripts/pack-smoke.mjs"), "utf8");
    expect(src).toMatch(/rootPkg\.files/);
    const files = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files as string[];
    for (const name of files) expect(src).not.toContain(`"${name}"`);
  });

  it("the license, third-party notice and README stay in package.json files, so pack-smoke requires them", () => {
    const files = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files as string[];
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]));
  });

  it("every enforcement test has a README row and every row has a file", () => {
    expect(checkEnforcementReadme(ROOT)).toEqual([]);
  });

  it("fails an enforcement test without a row and a row without a test, then passes after registration", () => {
    const root = makeTempDir("omf-registry-");
    const dir = join(root, "tests/enforcement");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "README.md"),
      "| Test | Claim | Spec |\n|---|---|---|\n| `A.test.ts` | a | §1 |\n| `Ghost.test.ts` | b | §2 |\n",
    );
    writeFileSync(join(dir, "A.test.ts"), "");
    writeFileSync(join(dir, "New.test.ts"), "");
    const problems = checkEnforcementReadme(root);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("tests/enforcement/New.test.ts has no row");
    expect(problems.join("\n")).toContain('names "Ghost.test.ts", which does not exist');
    writeFileSync(join(dir, "Ghost.test.ts"), "");
    writeFileSync(
      join(dir, "README.md"),
      "| Test | Claim | Spec |\n|---|---|---|\n| `A.test.ts` | a | §1 |\n| `Ghost.test.ts` | b | §2 |\n| `New.test.ts` | c | §3 |\n",
    );
    expect(checkEnforcementReadme(root)).toEqual([]);
  });

  it("every schema file is named outside schemas/", () => {
    expect(checkSchemasReferenced(ROOT)).toEqual([]);
  });

  it("fails a schema nobody names, then passes once a use site names it", () => {
    const root = makeTempDir("omf-registry-");
    mkdirSync(join(root, "schemas"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "schemas/orphan.schema.json"), "{}");
    expect(checkSchemasReferenced(root, ["src"])).toEqual([
      "schemas/orphan.schema.json is named in none of src (the schema registry is its use sites)",
    ]);
    writeFileSync(join(root, "src/use.ts"), 'validate("orphan.schema.json", x);\n');
    expect(checkSchemasReferenced(root, ["src"])).toEqual([]);
  });
});
