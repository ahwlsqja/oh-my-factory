import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST = new URL("../../docs/maintainers/kernel-paths.txt", import.meta.url);
const lines = readFileSync(MANIFEST, "utf8").split("\n");
const patterns = lines.slice(0, -1).filter((line) => !line.startsWith("#"));
const options = { dot: true, strictBrackets: true };
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
// Only the CLI presentation/entrypoint root is partly non-kernel; sensitive CLI files are protected explicitly.
const NON_KERNEL_ROOTS = new Set(["cli"]);

function unclassifiedSourceRoots(paths: readonly string[]): string[] {
  const matches = picomatch(patterns, options);
  const unclassified = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith("src/")) continue;
    const root = path.split("/")[1] ?? "";
    if (!NON_KERNEL_ROOTS.has(root) && !matches(path)) unclassified.add(root);
  }
  return [...unclassified].sort();
}

describe("kernel path manifest", () => {
  it("contains unique, valid relative picomatch patterns that name current repository paths", () => {
    expect(lines.at(-1), "manifest must end with a newline").toBe("");
    expect(patterns.length).toBeGreaterThan(0);
    expect(new Set(patterns).size, "duplicate kernel pattern").toBe(patterns.length);
    for (const pattern of patterns) {
      expect(pattern, "blank or padded pattern").toBe(pattern.trim());
      expect(pattern.length, "blank pattern").toBeGreaterThan(0);
      expect(/\p{Cc}/u.test(pattern), `control character in ${JSON.stringify(pattern)}`).toBe(false);
      expect(pattern.startsWith("/") || pattern.startsWith("!"), pattern).toBe(false);
      expect(pattern.includes("\\") || pattern.split("/").includes(".."), pattern).toBe(false);
      // Strict bracket parsing catches malformed globs; a valid typo must still match an actual path.
      const matches = picomatch(pattern, options);
      expect(
        files.some((file) => matches(file)),
        `kernel pattern matches no repository path: ${pattern}`,
      ).toBe(true);
    }
  });

  it("classifies each current source root and rejects a newly added unclassified root", () => {
    expect(files.some((path) => path.startsWith("src/cli/"))).toBe(true);
    expect(unclassifiedSourceRoots(files), "new source roots need explicit classification and human review").toEqual(
      [],
    );
    expect(unclassifiedSourceRoots([...files, "src/new-trust-boundary/entry.ts"])).toEqual(["new-trust-boundary"]);
  });

  it("covers trust-boundary regressions and self-protection without classifying all documentation as kernel", () => {
    const matches = picomatch(patterns, options);
    const criticalPaths = [
      "src/core/ledger.ts",
      "src/core/canonical-json.ts",
      "src/goal/approve.ts",
      "src/scenario/gate2.ts",
      "src/feedback/release.ts",
      "src/work/outcome.ts",
      "src/decision/gate1.ts",
      "src/cli/decide-sign.ts",
      "src/cli/confirm.ts",
      "src/author/station.ts",
      "outer/run.mjs",
      "docs/requirements.json",
      "scripts/conformance-matrix.mjs",
      "src/git/hardened.ts",
      "src/adapters/process-group.ts",
      "src/container/measure.ts",
      "src/work/classify.ts",
      "harness/main.mjs",
      "fixtures/echo-everything.mjs",
      "tests/global-setup.ts",
      "tests/helpers/bin-shims/claude",
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      "package.json",
      "package-lock.json",
      "vitest.config.ts",
      "docs/design/2026-10-12-omf-v0-design.md",
      "docs/ko/design/2026-10-12-omf-v0-design.md",
      "docs/maintainers/kernel-paths.txt",
      "tests/docs/kernel-paths.test.ts",
      "docs/maintainers/development-workflow.md",
      "AGENTS.md",
      "CLAUDE.md",
    ];
    for (const path of criticalPaths) expect(matches(path), `unprotected trust boundary: ${path}`).toBe(true);
    for (const path of ["README.md", "examples/hello-goal/README.md", "docs/maintainers/testing.md"]) {
      expect(matches(path), `unrelated documentation classified as kernel: ${path}`).toBe(false);
    }
  });
});
