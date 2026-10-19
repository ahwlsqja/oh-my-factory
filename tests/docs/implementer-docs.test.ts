import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The implementer boundary, E6 and the real run are written as gated suites and have not been recorded, so the documents must say
// "not enforced" for each until docs/evidence/gated-runs.json holds a passing record of it. They must also state what the design
// cannot promise: the key is readable by candidate code, the network is open, the default bridge reaches other containers.
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const PAGE = "docs/implementer.md";
const SUITES = ["G-implementer-boundary-real", "G-implementer-real-run", "G-e6-l2-leak-redteam"] as const;
const recorded = (): string[] =>
  (JSON.parse(read("docs/evidence/gated-runs.json")) as { runs: { test: string }[] }).runs.map((run) => run.test);
const unrecorded = (): string[] => SUITES.filter((name) => !recorded().includes(name));

const script = (await import(fileURLToPath(new URL("scripts/gated-docker.mjs", ROOT)))) as {
  parseArgs: (argv: string[]) => { only: string | null; record: boolean; model: boolean } | { error: string };
  colimaPlan: () => { start: string[]; stop: string[] };
};

const CLAIM = /measured:\s*"?L[123]\b|\bsealed\b|\bproven\b|\bis enforced\b/i;
const QUALIFIER = /not enforced|unproven|not proven/i;
const saysNotEnforced = (text: string, suite: string): boolean =>
  text.split("\n").some((line) => line.includes(suite) && /not enforced/i.test(line));

describe("docs/implementer.md", () => {
  it("states the exposure, the limits and the requirements the design cannot enforce", () => {
    const page = read(PAGE);
    const required = [
      "can read and use the key",
      "spend limit",
      "dedicated Anthropic workspace",
      "open egress",
      "default bridge",
      "other containers",
      "host gateway",
      "dedicated docker context",
      "`filter=lfs`",
      "global git configuration",
      "submodule",
      "repository's own git configuration",
      "unrelated root",
      "`.omf/<work-id>/`",
      "passwd",
      "65532",
      "baked",
      "not enforced",
    ];
    expect(required.filter((phrase) => !page.includes(phrase))).toEqual([]);
  });

  it("says not enforced for every gated suite that is not recorded and makes no unqualified measured or sealed claim", () => {
    const page = read(PAGE);
    expect(unrecorded().filter((suite) => !saysNotEnforced(page, `\`${suite}\``))).toEqual([]);
    expect(page.split("\n").filter((line) => CLAIM.test(line) && !QUALIFIER.test(line))).toEqual([]);
  });

  it("the prepared owner command parses with the driver's own argument parser and the colima commands equal its plan", () => {
    const page = read(PAGE);
    const line = page.split("\n").find((l) => l.startsWith("OMF_IMPLEMENTER_API_KEY="));
    expect(line).toBeDefined();
    const flags = (line ?? "").split(" -- ")[1]?.split(" ") ?? [];
    expect(script.parseArgs(flags)).toEqual({ only: "G-implementer-real-run", record: true, model: true });
    const plan = script.colimaPlan();
    expect(page).toContain(plan.start.join(" "));
    expect(page).toContain(plan.stop.join(" "));
    expect(JSON.parse(read("package.json")).scripts["test:gated"]).toBe("node scripts/gated-docker.mjs");
  });

  it("names only repository paths that exist and is linked from both READMEs and the documentation index", () => {
    const named = [...read(PAGE).matchAll(/`((?:src|tests|schemas|docs|scripts)\/[A-Za-z0-9_./-]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(named.length).toBeGreaterThan(1);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
    expect(read("README.md")).toContain("](docs/implementer.md)");
    expect(read("README.ko.md")).toContain("](docs/implementer.md)");
    expect(read("docs/README.md")).toContain("](implementer.md)");
  });
});

describe("the other documents", () => {
  it("isolation-and-gates.md names every unrecorded gated suite as not enforced", () => {
    const page = read("docs/isolation-and-gates.md");
    expect(unrecorded().filter((suite) => !saysNotEnforced(page, suite))).toEqual([]);
  });

  it("no document holds a key shape or a full canary literal, and the README rows are current", () => {
    const docs = readdirSync(new URL("docs/", ROOT)).filter((name) => name.endsWith(".md"));
    for (const file of ["README.md", "README.ko.md", ...docs.map((name) => `docs/${name}`)]) {
      expect(read(file), file).not.toMatch(/sk-ant-[A-Za-z0-9_-]{6,}/);
      expect(read(file), file).not.toMatch(/omf-canary-[0-9a-f]{32}/);
    }
    expect(read("README.md")).not.toMatch(/the implementer and author containers do not exist yet/);
    expect(read("README.md")).toMatch(/advisory `implementer` row/);
    expect(read("README.ko.md")).toMatch(/`implementer` 항목/);
  });
});
