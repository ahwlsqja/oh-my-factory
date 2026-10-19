import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// The three gated author suites are written and not recorded (M3h). This keeps the wording honest: docs/author.md carries
// "[not enforced: <id>]" for a suite exactly until docs/evidence/gated-runs.json holds a passing record for it, the suites are
// mapped as real_world requirements, and the READMEs no longer say the line's commands are missing.
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

const SUITES = [
  {
    id: "S5.3.author-boundary-real",
    suite: "G-author-boundary-real",
    file: "tests/gated/author-boundary-real.test.ts",
  },
  { id: "S5.3.author-answer-no-leak", suite: "G-author-canary", file: "tests/gated/author-canary.test.ts" },
  { id: "S5.0.skeleton-real-line", suite: "G-skeleton-real", file: "tests/gated/skeleton-real.test.ts" },
] as const;

const ROOT_DIR = fileURLToPath(ROOT);
const NESTED_CONFIG = fileURLToPath(new URL("../helpers/vitest.nested.config.ts", import.meta.url));

/** Runs the named gated suite files in a child vitest under `env` and reports how many of their tests ran, passed and were skipped. */
function runGated(
  files: string[],
  env: Record<string, string>,
): { total: number; passed: number; failed: number; skipped: number } {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OMF_") && !name.endsWith("_API_KEY")),
  );
  const out = join(makeTempDir("omf-gated-json-"), "report.json");
  spawnSync(
    process.execPath,
    [
      join(ROOT_DIR, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      NESTED_CONFIG,
      "--reporter=json",
      `--outputFile=${out}`,
      ...files,
    ],
    { cwd: ROOT_DIR, encoding: "utf8", env: { ...clean, ...env }, maxBuffer: 16 * 1024 * 1024 },
  );
  const report = JSON.parse(readFileSync(out, "utf8")) as {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
  };
  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
  };
}

interface Requirement {
  id: string;
  real_world: boolean;
  surfaces: string[];
  tests: { path: string; gated?: string }[];
}
const requirements = (): Requirement[] =>
  (JSON.parse(read("docs/requirements.json")) as { requirements: Requirement[] }).requirements;
const recorded = (): string[] =>
  (JSON.parse(read("docs/evidence/gated-runs.json")) as { runs: { test: string }[] }).runs.map((run) => run.test);

describe.each(SUITES)("$suite", ({ id, suite, file }) => {
  it("is a real_world requirement mapped by file and name, marked in its file and skipped without the switch", () => {
    const requirement = requirements().find((r) => r.id === id);
    expect(requirement?.real_world).toBe(true);
    expect(requirement?.surfaces).toContain("docs/author.md");
    expect(requirement?.tests.some((t) => t.path === file && t.gated === suite)).toBe(true);
    const source = read(file);
    // The matrix reads only a line that is exactly `// covers: <id>`; a mention inside prose does not count.
    expect(source.split("\n").map((line) => line.trim())).toContain(`// covers: ${id}`);
    // Anchored at the start of a line: a decoy in a string or a comment cannot satisfy it, and nothing else may open a suite.
    expect(source).toMatch(new RegExp(`^describeGated(?:Model)?\\("${suite}"`, "m"));
    expect(source).not.toMatch(/\bdescribe(?:\.\w+)*\(|\bdescribe\.\w+|^(?:it|test)(?:\.\w+)*\(/m);
  });

  it("is called not enforced in docs/author.md exactly until a passing record exists", () => {
    expect(read("docs/author.md").includes(`[not enforced: ${id}]`)).toBe(!recorded().includes(suite));
  });
});

describe("the gated suites are skipped without the switch", () => {
  const FILES = SUITES.map((s) => s.file);

  it("with no switch every test of the three author suites is skipped, none passes or fails", () => {
    const run = runGated(FILES, {});
    expect(run.total).toBeGreaterThan(0);
    expect(run).toEqual({ total: run.total, passed: 0, failed: 0, skipped: run.total });
  }, 120_000);

  it("under OMF_GATED=docker the two model suites are still skipped, so a docker run never spends money", () => {
    const run = runGated(
      SUITES.filter((s) => s.suite !== "G-author-boundary-real").map((s) => s.file),
      { OMF_GATED: "docker" },
    );
    expect(run.total).toBeGreaterThan(0);
    expect(run).toEqual({ total: run.total, passed: 0, failed: 0, skipped: run.total });
  }, 120_000);
});

describe("docs/author.md gated runs", () => {
  it("gives the command of each suite with the key passed on that command only", () => {
    const page = read("docs/author.md");
    const KEY = "<dedicated, spend-limited key>";
    for (const line of [
      "npm run test:gated -- --only G-author-boundary-real",
      `OMF_AUTHOR_API_KEY=${KEY} npm run test:gated -- --model --only G-author-canary`,
      `OMF_AUTHOR_API_KEY=${KEY} OMF_IMPLEMENTER_API_KEY=${KEY} npm run test:gated -- --model --only G-skeleton-real`,
    ]) {
      expect(page).toContain(line);
    }
    expect(page).toContain("never written to a file");
    expect(page).toContain("author spend is not recorded or bounded by OMF");
    expect(page).toContain("scripts/smoke-w.sh");
  });
});

describe("README status", () => {
  const warning = (text: string): string => {
    const start = text.indexOf("> [!WARNING]");
    const end = text.indexOf("\n\n", start);
    return text.slice(start, end).replace(/\n> /g, " ");
  };
  const NONE_EN = "no gated run of the author container or of the whole line is recorded";
  const NONE_KO = "작성자 컨테이너와 전체 라인의 게이트 실행은 기록된 것이 없으며";
  const authorRecorded = (): boolean => SUITES.some((s) => recorded().includes(s.suite));

  it("the English README names the three commands and says no author or whole-line run is recorded, until one is", () => {
    const text = warning(read("README.md"));
    expect(text).not.toContain("are not built yet");
    for (const verb of ["`omf seal`", "`omf run`", "`omf report`"]) expect(text).toContain(verb);
    expect(text.includes(NONE_EN)).toBe(!authorRecorded());
  });

  it("the Korean README says the same", () => {
    const text = warning(read("README.ko.md"));
    expect(text).not.toContain("아직 만들지 않았습니다");
    for (const verb of ["`omf seal`", "`omf run`", "`omf report`"]) expect(text).toContain(verb);
    expect(text.includes(NONE_KO)).toBe(!authorRecorded());
  });
});
