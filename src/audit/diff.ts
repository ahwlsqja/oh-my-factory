import type { RawDiffEntry } from "../git/ops.js";
import { normalizePath } from "../work/fingerprint.js";
import { classifyLiteralPaths, isTestPath, raiseRisk } from "../work/risk.js";
import type { RiskAssessment } from "../work/types.js";

export interface DiffFacts {
  files: number;
  empty: boolean;
  /** Every touched path (A, M, D, T), sorted. */
  paths: string[];
  /** Status M, D or T on a path that `isTestPath` accepts: an existing test was changed or removed. */
  tests_edited: string[];
  /** Status A on a test path. */
  tests_added: number;
  /** Symlink (120000) or gitlink (160000) in the old or the new mode. */
  special_entries: number;
  /** Paths equal (case-insensitive, normalised) to one of `projectionPaths`. */
  projections_touched: string[];
}

const SPECIAL_MODES: ReadonlySet<string> = new Set(["120000", "160000"]);
const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A rename is a delete plus an add in the raw diff, so renaming a test counts as an edit. Pure: the same entries give the same facts. */
export function classifyDiff(
  entries: readonly RawDiffEntry[],
  explicitTestPaths: readonly string[],
  projectionPaths: readonly string[],
): DiffFacts {
  const projections = new Set(
    projectionPaths.map((path) => normalizePath(path).toLowerCase()).filter((path) => path !== ""),
  );
  const paths: string[] = [];
  const testsEdited: string[] = [];
  const projectionsTouched: string[] = [];
  let testsAdded = 0;
  let special = 0;
  for (const entry of entries) {
    paths.push(entry.path);
    if (isTestPath(entry.path, explicitTestPaths)) {
      if (entry.status === "A") testsAdded += 1;
      else testsEdited.push(entry.path);
    }
    if (SPECIAL_MODES.has(entry.old_mode) || SPECIAL_MODES.has(entry.new_mode)) special += 1;
    if (projections.has(normalizePath(entry.path).toLowerCase())) projectionsTouched.push(entry.path);
  }
  return {
    files: entries.length,
    empty: entries.length === 0,
    paths: paths.sort(byBytes),
    tests_edited: testsEdited.sort(byBytes),
    tests_added: testsAdded,
    special_entries: special,
    projections_touched: projectionsTouched.sort(byBytes),
  };
}

export interface RiskOutcome {
  /** null on an empty diff. */
  recomputed: RiskAssessment | null;
  effective: RiskAssessment;
  /** The effective assessment has a higher class or a rule the declaration did not have. */
  raised: boolean;
}

/**
 * The risk of the real diff, and the effective risk. An empty diff skips the recompute: `classifyRisk` would return
 * `undeclared` for zero paths, which is not a finding about the diff, so the effective risk is the declared one. Otherwise the diff's
 * own paths are classified as literal paths (a `[` in `app/posts/[id]/page.tsx` is not a glob) and `raiseRisk` can only raise.
 */
export function assessDiffRisk(
  facts: DiffFacts,
  declared: RiskAssessment,
  globs: { watchedGlobs: readonly string[]; extraGlobs: readonly string[] },
): RiskOutcome {
  if (facts.empty) return { recomputed: null, effective: declared, raised: false };
  const recomputed = classifyLiteralPaths({
    paths: facts.paths,
    watchedGlobs: globs.watchedGlobs,
    extraGlobs: globs.extraGlobs,
  });
  const effective = raiseRisk(declared, recomputed);
  const raised = effective.class !== declared.class || effective.rules.some((rule) => !declared.rules.includes(rule));
  return { recomputed, effective, raised };
}
