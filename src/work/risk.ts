import picomatch from "picomatch";
import { normalizePath } from "./fingerprint.js";
import type { RiskAssessment, RiskRule } from "./types.js";

/**
 * Paths a work item must not touch without a person's approval (spec §4.4, D4). Each entry names one rule;
 * the rule label is all that reaches the ledger. Matching is case-insensitive and includes dot paths, so
 * `.GitHub/Workflows` on a case-insensitive filesystem is still CI.
 */
export const DEFAULT_HIGH_RISK: ReadonlyArray<{ rule: RiskRule; globs: readonly string[] }> = [
  {
    rule: "ci",
    globs: [
      ".github/workflows/**",
      ".github/actions/**",
      ".gitlab-ci.yml",
      ".circleci/**",
      "Jenkinsfile",
      "azure-pipelines.yml",
    ],
  },
  { rule: "auth", globs: ["**/auth/**", "**/authn/**", "**/authz/**", "**/oauth/**", "**/*auth*.*"] },
  { rule: "migration", globs: ["**/migrations/**", "**/migrate/**", "db/migrate/**", "**/*.sql"] },
  {
    rule: "test",
    globs: ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/*_spec.*"],
  },
  {
    rule: "goal-factory",
    globs: [".omf/**", ".factory/**", ".claude/**", ".codex/**", "AGENTS.md", "CLAUDE.md", "**/goal.md"],
  },
  {
    rule: "lockfile",
    globs: [
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/bun.lock",
      "**/bun.lockb",
      "**/Cargo.lock",
      "**/go.sum",
      "**/poetry.lock",
      "**/uv.lock",
      "**/Gemfile.lock",
      "**/composer.lock",
    ],
  },
];

const testRule = DEFAULT_HIGH_RISK.find((entry) => entry.rule === "test");
if (testRule === undefined) throw new Error("DEFAULT_HIGH_RISK has no test rule");
/** The globs of the `test` rule: the one definition of a test file shared by `classifyRisk`, `proveTest` and the audit. */
export const TEST_GLOBS: readonly string[] = testRule.globs;

export interface RiskInput {
  /** Literal repo-relative files or directories the candidate says it will touch. */
  declaredPaths: readonly string[];
  /** `watched_paths` of the locked metrics. Only a `watched-path` label leaves this function, never the metric. */
  watchedGlobs: readonly string[];
  /** `EXTRA_HIGH_RISK_GLOBS` (core/config.ts). */
  extraGlobs: readonly string[];
  /** `trackedFiles(repo)`. Injected so the function stays pure. */
  tracked: readonly string[];
}

const MATCH_OPTIONS = { dot: true, nocase: true } as const;
const GLOB_CHARS = /[*?[\]{}()!]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Fail closed: a declaration that is not a plain relative path inside the repository cannot be judged. */
function isClassifiable(raw: string, normalized: string): boolean {
  if (normalized === "" || normalized === ".") return false;
  if (raw.includes("\\") || CONTROL_CHARS.test(raw) || GLOB_CHARS.test(raw)) return false;
  // normalizePath strips a leading "/", so an absolute path is detected on the raw text.
  if (raw.startsWith("/")) return false;
  const segments = normalized.split("/");
  if (segments.includes("..")) return false;
  return !segments.some((segment) => segment.toLowerCase() === ".git");
}

/**
 * The mechanical risk class of a candidate (spec §4.4, D4). A declared path is high when any rule glob matches
 * it, matches it as a directory (`<path>/_` probes `dir/**` globs), or matches a tracked file below it. A new
 * untracked file under a high-risk glob is high by pattern alone. No declaration, or one that cannot be judged,
 * is high: the model chooses paths, code chooses the class.
 *
 * Pure: the same input in any order gives the same output. `rules` and `paths` are deduplicated and sorted.
 */
export function classifyRisk(input: RiskInput): RiskAssessment {
  if (input.declaredPaths.length === 0) return { class: "high", rules: ["undeclared"], paths: [] };

  // A declared test path is not high by itself: before the implementation there is no diff to weaken. The audit adds the
  // `test-weakening` rule (or the conservative `test` rule) from the real diff, and risk only rises from there.
  const rules: Array<{ rule: RiskRule; matches: (path: string) => boolean }> = [
    ...DEFAULT_HIGH_RISK.filter(({ rule }) => rule !== "test").map(({ rule, globs }) => ({
      rule,
      matches: picomatch([...globs], MATCH_OPTIONS),
    })),
  ];
  if (input.watchedGlobs.length > 0)
    rules.push({ rule: "watched-path", matches: picomatch([...input.watchedGlobs], MATCH_OPTIONS) });
  if (input.extraGlobs.length > 0)
    rules.push({ rule: "extra", matches: picomatch([...input.extraGlobs], MATCH_OPTIONS) });

  const found = new Set<RiskRule>();
  const paths = new Set<string>();
  for (const raw of input.declaredPaths) {
    const path = normalizePath(raw);
    if (!isClassifiable(raw, path)) {
      found.add("unclassifiable");
      continue;
    }
    const lower = path.toLowerCase();
    const below = input.tracked.filter((file) => file.toLowerCase().startsWith(`${lower}/`));
    const candidates = [path, `${path}/_`, ...below];
    for (const { rule, matches } of rules) {
      if (candidates.some((candidate) => matches(candidate))) {
        found.add(rule);
        paths.add(path);
      }
    }
  }
  const sorted = [...found].sort();
  return { class: sorted.length > 0 ? "high" : "normal", rules: sorted, paths: [...paths].sort() };
}

/**
 * The risk of paths that are known to be literal, such as the paths of a real git diff. Unlike `classifyRisk`, a glob character
 * in the path is just a character (`app/posts/[id]/page.tsx`, `.github/workflows/build[1].yml`): every rule matcher runs on the
 * path string itself. Only a control character, a backslash or an empty path cannot be judged. Every path that raised the class
 * is listed in `paths`, unclassifiable ones included. Declarations keep using `classifyRisk`.
 */
export function classifyLiteralPaths(input: {
  paths: readonly string[];
  watchedGlobs: readonly string[];
  extraGlobs: readonly string[];
  /**
   * The paths `findTestWeakening` flagged in the real diff. When given (even empty), a test change is high only for these
   * paths, under the rule `test-weakening`. When absent or `null` the weakening check could not run (no diff text), so every
   * test path stays high under the rule `test`.
   */
  weakeningPaths?: readonly string[] | null | undefined;
  /** Literal test paths or directories the project configured outside the default test globs; they stay `test` when the check could not run. */
  explicitTestPaths?: readonly string[] | undefined;
}): RiskAssessment {
  const checked = input.weakeningPaths !== undefined && input.weakeningPaths !== null;
  const rules: Array<{ rule: RiskRule; matches: (path: string) => boolean }> = [
    ...DEFAULT_HIGH_RISK.filter(({ rule }) => !(checked && rule === "test")).map(({ rule, globs }) => ({
      rule,
      matches:
        rule === "test"
          ? (path: string) => isTestPath(path, input.explicitTestPaths ?? [])
          : picomatch([...globs], MATCH_OPTIONS),
    })),
  ];
  if (checked) {
    const weakened = new Set((input.weakeningPaths ?? []).map((path) => normalizePath(path)));
    rules.push({ rule: "test-weakening", matches: (path) => weakened.has(path) });
  }
  if (input.watchedGlobs.length > 0)
    rules.push({ rule: "watched-path", matches: picomatch([...input.watchedGlobs], MATCH_OPTIONS) });
  if (input.extraGlobs.length > 0)
    rules.push({ rule: "extra", matches: picomatch([...input.extraGlobs], MATCH_OPTIONS) });

  const found = new Set<RiskRule>();
  const paths = new Set<string>();
  for (const raw of input.paths) {
    const path = normalizePath(raw);
    if (path === "" || raw.includes("\\") || CONTROL_CHARS.test(raw)) {
      found.add("unclassifiable");
      paths.add(raw);
      continue;
    }
    for (const { rule, matches } of rules) {
      if (matches(path)) {
        found.add(rule);
        paths.add(path);
      }
    }
  }
  const sorted = [...found].sort();
  return { class: sorted.length > 0 ? "high" : "normal", rules: sorted, paths: [...paths].sort() };
}

const testMatcher = picomatch([...TEST_GLOBS], MATCH_OPTIONS);

/**
 * True when `path` matches a `test` glob (case-insensitive, dot paths included, like `classifyRisk`) or equals an `explicit`
 * entry or lies below it as a directory. `explicit` is a list of literal repo-relative paths, anchored at the root; a glob in
 * it is a literal name. Never a guessed glob: a test directory outside `TEST_GLOBS` counts only when the caller lists it.
 */
export function isTestPath(path: string, explicit: readonly string[] = []): boolean {
  const normalized = normalizePath(path);
  if (normalized === "") return false;
  if (testMatcher(normalized)) return true;
  const lower = normalized.toLowerCase();
  return explicit.some((entry) => {
    const wanted = normalizePath(entry).toLowerCase();
    return wanted !== "" && (lower === wanted || lower.startsWith(`${wanted}/`));
  });
}

/**
 * The risk of a candidate after the audit recomputed it from the real diff: high if either assessment is high,
 * and the rules and paths are the sorted union. It never returns a class lower than `declared`, and it does not rewrite the
 * item's stored risk; the effective class lives in the audit record and the ledger event.
 */
export function raiseRisk(declared: RiskAssessment, recomputed: RiskAssessment): RiskAssessment {
  return {
    class: declared.class === "high" || recomputed.class === "high" ? "high" : "normal",
    rules: [...new Set([...declared.rules, ...recomputed.rules])].sort(),
    paths: [...new Set([...declared.paths, ...recomputed.paths])].sort(),
  };
}
