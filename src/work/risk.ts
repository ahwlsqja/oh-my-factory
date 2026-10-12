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
    globs: [".github/workflows/**", ".github/actions/**", ".gitlab-ci.yml", ".circleci/**", "Jenkinsfile", "azure-pipelines.yml"],
  },
  { rule: "auth", globs: ["**/auth/**", "**/authn/**", "**/authz/**", "**/oauth/**", "**/*auth*.*"] },
  { rule: "migration", globs: ["**/migrations/**", "**/migrate/**", "db/migrate/**", "**/*.sql"] },
  {
    rule: "test",
    globs: ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/*_spec.*"],
  },
  { rule: "goal-factory", globs: [".omf/**", ".factory/**", ".claude/**", ".codex/**", "AGENTS.md", "CLAUDE.md", "**/goal.md"] },
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
  return segments[0]?.toLowerCase() !== ".git";
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

  const rules: Array<{ rule: RiskRule; matches: (path: string) => boolean }> = [
    ...DEFAULT_HIGH_RISK.map(({ rule, globs }) => ({ rule, matches: picomatch([...globs], MATCH_OPTIONS) })),
  ];
  if (input.watchedGlobs.length > 0) rules.push({ rule: "watched-path", matches: picomatch([...input.watchedGlobs], MATCH_OPTIONS) });
  if (input.extraGlobs.length > 0) rules.push({ rule: "extra", matches: picomatch([...input.extraGlobs], MATCH_OPTIONS) });

  const found = new Set<RiskRule>();
  const paths = new Set<string>();
  for (const raw of input.declaredPaths) {
    const path = normalizePath(raw);
    if (!isClassifiable(raw, path)) {
      found.add("unclassifiable");
      continue;
    }
    const below = input.tracked.filter((file) => file.startsWith(`${path}/`));
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
