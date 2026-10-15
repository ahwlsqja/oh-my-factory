import type { AuditSurface } from "../audit/canary-scan.js";
import type { GitTarget } from "../git/hardened.js";
import type { StationContext } from "../work/sequencer.js";

/** What the implementer station hands to the judge stations (M3g plugs the real S3 in behind `CandidateSource`). */
export interface CandidateRef {
  quarantine: GitTarget;
  /** Full hex shas. */
  base: string;
  head: string;
  /** The ONE source of explicit test paths: the same array reaches proveTest and runAudit (M3e-D9). */
  explicitTestPaths: readonly string[];
  /** worktree, implementer_log and prompt surfaces (M3g); S5 builds diff and commit_messages itself from the quarantine. */
  surfaces: readonly AuditSurface[];
}

/** `null` = S3 produced no candidate; every station that needs one then stops. Also asked at round 0 by the entry check. */
export interface CandidateSource {
  current(ctx: StationContext): Promise<CandidateRef | null>;
}
