import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// M3f makes more claims about containers than the repository can back, so this keeps the wording honest: every line
// that says a level was measured or that something is sealed must say "not enforced", unless
// docs/evidence/gated-runs.json holds a recorded, passing run of the gated tests that prove it (M3f-D22).
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const PAGE = "docs/container-judge.md";

/** M3e's rule, unchanged. */
const CLAIM = /measured:\s*"?L[123]\b|\bsealed\b/i;
const QUALIFIER = /not enforced/i;
const unqualifiedClaims = (text: string): string[] =>
  text.split("\n").filter((line) => CLAIM.test(line) && !QUALIFIER.test(line));

const CLAIM_FILES = [
  PAGE,
  "docs/isolation-and-gates.md",
  "src/core/doctor.ts",
  "src/cli/main.ts",
  "src/container/doctor-probe.ts",
] as const;

/** A recorded gated test name contains one of these fragments. Both must be recorded to lift the qualifier. */
const PROOF_FRAGMENTS = ["isolation-probe", "two-container-roundtrip"] as const;
const proofRecorded = (tests: readonly string[]): boolean =>
  PROOF_FRAGMENTS.every((fragment) => tests.some((test) => test.includes(fragment)));
const recordedTests = (): string[] => {
  const doc = JSON.parse(read("docs/evidence/gated-runs.json")) as { runs: { test: string }[] };
  return doc.runs.map((run) => run.test);
};

/** Phrases the page must keep: the limits of the finished milestone. */
const LIMITS = [
  "unmeasured candidate execution",
  "isolation_unmeasured",
  "`sleep`",
  "`VOLUME`",
  "tripwire",
  "local `unix://`",
  "pinned per run",
  "candidate-controlled",
  "single use",
  "sealed_failed",
  "not enforced",
] as const;

/** The first bullet that starts with `marker`, up to the next top-level bullet. */
function bulletOf(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`no bullet starts with ${marker}`);
  const next = text.indexOf("\n- **", start + marker.length);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("M3f claim rule", () => {
  it("lifts the qualifier only when both proving gated tests are recorded", () => {
    expect(proofRecorded([])).toBe(false);
    expect(proofRecorded(["G-real-isolation-probe"])).toBe(false);
    expect(proofRecorded(["G-real-isolation-probe", "G-two-container-roundtrip"])).toBe(true);
    expect(unqualifiedClaims("isolation measured: L2")).toHaveLength(1);
    expect(unqualifiedClaims("measured: L2 is not enforced until a gated run is recorded")).toEqual([]);
  });

  it.each(CLAIM_FILES)("%s makes no unqualified measured or sealed claim", (file) => {
    const claims = proofRecorded(recordedTests()) ? [] : unqualifiedClaims(read(file));
    expect(claims).toEqual([]);
  });
});

describe("docs/container-judge.md", () => {
  it("states the limits of the finished milestone", () => {
    const page = read(PAGE);
    expect(LIMITS.filter((phrase) => !page.includes(phrase))).toEqual([]);
  });

  it("names only repository paths that exist", () => {
    const named = [...read(PAGE).matchAll(/`((?:src|tests|schemas|docs|scripts)\/[A-Za-z0-9_./-]+)`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
  });

  it("is linked from both READMEs and the documentation index", () => {
    expect(read("README.md")).toContain("](docs/container-judge.md)");
    expect(read("README.ko.md")).toContain("](docs/container-judge.md)");
    expect(read("docs/README.md")).toContain("](container-judge.md)");
  });
});

describe("the READMEs describe the line as it is", () => {
  it("README.md: the isolation bullet names the judge, keeps its qualifier and no longer says GATE-3 is a placeholder", () => {
    const bullet = bulletOf(read("README.md"), "**Isolation is measured, not declared.**");
    expect(bullet).toContain("not enforced");
    expect(bullet).not.toMatch(/does not call GATE-3/);
  });

  it("README.ko.md: the same bullet", () => {
    const bullet = bulletOf(read("README.ko.md"), "**격리는 선언이 아니라 측정.**");
    expect(bullet).toContain("강제되지 않");
    expect(bullet).not.toMatch(/GATE-3 를 호출하지 않/);
  });
});

describe("enforcement README, M3f", () => {
  const files = readdirSync(new URL("tests/enforcement/", ROOT)).filter((name) => name.endsWith(".test.ts"));

  it("has exactly one table row per enforcement test file", () => {
    const lines = read("tests/enforcement/README.md").split("\n");
    const wrong = files.filter((name) => lines.filter((line) => line.startsWith(`| \`${name}\` |`)).length !== 1);
    expect(wrong).toEqual([]);
  });

  it("no longer calls the E2 feedback test partial, and the test has no todo left", () => {
    const row = read("tests/enforcement/README.md")
      .split("\n")
      .find((line) => line.startsWith("| `E2-w-b-canary-no-leak-feedback.test.ts` |"));
    expect(row).not.toContain("PARTIAL");
    expect(read("tests/enforcement/E2-w-b-canary-no-leak-feedback.test.ts")).not.toContain("it.todo");
  });

  it("states the status after M3f and what stays unenforced", () => {
    const readme = read("tests/enforcement/README.md");
    expect(readme).toContain("Status after M3f");
    expect(readme).toContain("unmeasured candidate execution");
  });
});
