import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The last task of M3d keeps three promises honest: the enforcement README names every enforcement test and
// no file that is gone, the two READMEs state the shared disclosure pool, and the re-check of the "Depends on"
// list is recorded with a result per row. docs/plans/ is gitignored, so nothing here reads it.
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const enforcementFiles = (): string[] =>
  readdirSync(new URL("tests/enforcement/", ROOT)).filter((name) => name.endsWith(".test.ts")).sort();

describe("enforcement README, final pass", () => {
  it("names every tests/enforcement test file", () => {
    const readme = read("tests/enforcement/README.md");
    expect(enforcementFiles().filter((name) => !readme.includes(`\`${name}\``))).toEqual([]);
  });

  it("names no enforcement test file that does not exist", () => {
    const readme = read("tests/enforcement/README.md");
    const named = [...readme.matchAll(/`([A-Za-z0-9-]+\.test\.ts)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((name) => !existsSync(new URL(`tests/enforcement/${name}`, ROOT)))).toEqual([]);
  });

  it("states what M3d leaves partial or unenforced", () => {
    const readme = read("tests/enforcement/README.md");
    expect(readme).toContain("Status after M3d");
    expect(readme).toContain("re-run the same canary");
    expect(readme).toContain("forge a `human:*` reseal event");
    expect(readme).toContain("one per-goal `disclosure` budget");
  });
});

describe("the READMEs state the shared disclosure pool", () => {
  it("README.md", () => {
    expect(read("README.md")).toMatch(/draw from the same pool/);
  });

  it("README.ko.md", () => {
    expect(read("README.ko.md")).toMatch(/같은 예산을 나눠 쓰/);
  });
});

describe("M3d re-check of the Depends-on list", () => {
  const doc = (): string => read("docs/design/2026-10-14-omf-m3d-recheck.md");
  const rows = (): string[] => doc().split("\n").filter((line) => /^\| R\d+ \|/.test(line));

  it("has one row per dependency, each with a recorded result", () => {
    expect(rows().length).toBeGreaterThanOrEqual(17);
    const open = rows().filter((row) => {
      const result = (row.split("|").at(-2) ?? "").trim();
      return !/^(verified|diff: \S)/.test(result);
    });
    expect(open).toEqual([]);
  });

  it("names only repository paths that exist", () => {
    const named = [...doc().matchAll(/`((?:src|tests|schemas|docs\/design)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(8);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
  });
});
