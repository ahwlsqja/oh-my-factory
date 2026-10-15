import { SURFACE_KINDS, textSurface } from "../../src/audit/canary-scan.js";
import type { AuditSurface, SurfaceKind } from "../../src/audit/canary-scan.js";
import type { AuditInput, RunScope } from "../../src/audit/work-audit.js";
import type { ProveTestResult } from "../../src/gate/prove-test.js";
import { type GitFixture, gitFixture } from "./git-fixture.js";

/** 21 characters: above MIN_CANARY_LENGTH, and no common word contains it. */
export const CANARY_TEXT = "CNRY-7f3a91c2e8b4d605";

export const PROVEN: ProveTestResult = { status: "PROVEN", reason: null, test_exit: 1, non_test_paths: 1, test_paths: 1 };

export type AuditFixture = GitFixture;

/**
 * `headChanges` maps a path to its new content, or to null to delete it. Every base gets `scripts/gates.mjs`, so the default
 * judge config always resolves one exact file and `judge_files_checked` is never zero by accident. A caller can override its content.
 */
export function auditFixture(baseFiles: Record<string, string>, headChanges: Record<string, string | null>): AuditFixture {
  return gitFixture({ "scripts/gates.mjs": "process.exit(0);\n", ...baseFiles }, headChanges);
}

/** All six required surfaces. Only `kind` (when given) holds the canary, so a hit names exactly one surface. */
export function surfacesWith(kind?: SurfaceKind): AuditSurface[] {
  return SURFACE_KINDS.map((k) => textSurface(k, k === kind ? `before ${CANARY_TEXT} after` : "nothing to see here"));
}

export function auditInput(fx: AuditFixture, overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    quarantine: fx.quarantine,
    base: fx.base,
    head: fx.head,
    declaredRisk: { class: "normal", rules: [], paths: [] },
    watchedGlobs: [],
    extraGlobs: [],
    judge: { gates: { fast: ["node", "scripts/gates.mjs"], full: null, deep: null, required: ["fast"] }, test_command: ["node", "--test"] },
    explicitTestPaths: [],
    projectionPaths: ["spec.md", "intent.md"],
    canaries: [CANARY_TEXT],
    surfaces: surfacesWith(),
    proveTest: PROVEN,
    ...overrides,
  };
}

/** Ids that match the patterns of the gate-event schema. */
export const SCOPE: RunScope = { goal_id: "g-audit-fixture", work_id: "w-0123456789ab", run_id: "r-20261014T091500Z-ab12" };
