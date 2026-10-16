import { rmSync } from "node:fs";
import { join } from "node:path";
import { NotGoldenError } from "../container/measure.js";
import type { NewEvent } from "../core/ledger.js";
import type { UserRepoErrorCode } from "../git/user-repo.js";
import type { StationResult } from "../work/sequencer.js";
import type { ReasonCode } from "../work/w-events.js";
import { type CandidateFacts, type ImplementerScope, candidateCheckedEvent } from "./events.js";
import type { HistoryScan } from "./history-scan.js";
import type { ImportFailure } from "./import.js";
import type { ImplementerFailureCode } from "./session.js";
import type { BundleCode, PrepareCode } from "./workspace.js";

/**
 * Every way the S3 station can refuse, by where it happened. The station never builds a reason code itself and never
 * passes on text: a refusal is one of these, and `reasonFor` is the only place that turns it into a code (M3g-D9,
 * spec §5.6). Environment and container trouble is `infra_failure`, so a rerun can fix it. Anything a person has to look
 * at (a repository this stage will not export, inputs that leak, bytes the container returned that do not check out, a
 * credential or canary in a result) is `gate_blocked`.
 */
export type Refusal =
  | { from: "environment" } // no credential, no image, no context, daemon down, endpoint not local
  | { from: "vendor" } // the config names an implementer vendor this version does not run (only Claude)
  | { from: "user_repo"; code: UserRepoErrorCode }
  | { from: "context" } // intent_leak, a canary in the inputs, the item's own .omf directory already tracked, a base that changed
  | { from: "guard" } // the line guard (sealed material in the repository), or the hardened git module refusing hostile data
  | { from: "measure"; not_golden: boolean }
  | { from: "prepare"; code: PrepareCode }
  | { from: "session"; code: ImplementerFailureCode }
  | { from: "kill" }
  | { from: "bundle"; code: BundleCode }
  | { from: "import"; code: ImportFailure }
  | { from: "scan"; status: Exclude<HistoryScan["status"], "clean"> }
  | { from: "request_invalid" };

// One Record per code type: adding a code to Tasks 3 to 6 without a row here does not compile.
const USER_REPO = {
  git_dir_unsupported: "gate_blocked",
  repo_has_drivers: "gate_blocked",
  head_unborn: "gate_blocked",
  base_missing: "gate_blocked",
  base_not_commit: "gate_blocked",
  export_too_large: "gate_blocked",
  submodule_present: "gate_blocked",
  lfs_pointers: "gate_blocked",
  ref_checked_out: "gate_blocked",
  ref_not_ours: "gate_blocked",
  ref_update_failed: "gate_blocked",
} as const satisfies Record<UserRepoErrorCode, ReasonCode>;
const PREPARE = {
  tool_missing: "infra_failure",
  extract_failed: "infra_failure",
  init_failed: "infra_failure",
} as const satisfies Record<PrepareCode, ReasonCode>;
const SESSION = {
  timeout: "infra_failure",
  spawn_failed: "infra_failure",
  nonzero_exit: "infra_failure",
  output_limit: "infra_failure",
  misconfigured: "infra_failure",
} as const satisfies Record<ImplementerFailureCode, ReasonCode>;
const BUNDLE = {
  finalize_failed: "infra_failure",
  bundle_too_large: "gate_blocked",
  bundle_malformed: "gate_blocked",
} as const satisfies Record<BundleCode, ReasonCode>;
const IMPORT = {
  bundle_invalid: "gate_blocked",
  fsck_failed: "gate_blocked",
  head_missing: "gate_blocked",
  too_many_commits: "gate_blocked",
  history_not_linear: "gate_blocked",
  root_tree_mismatch: "gate_blocked",
  context_mismatch: "gate_blocked",
} as const satisfies Record<ImportFailure, ReasonCode>;

export function reasonFor(refusal: Refusal): ReasonCode {
  switch (refusal.from) {
    case "environment":
    case "kill":
      return "infra_failure";
    case "user_repo":
      return USER_REPO[refusal.code];
    case "prepare":
      return PREPARE[refusal.code];
    case "session":
      return SESSION[refusal.code];
    case "bundle":
      return BUNDLE[refusal.code];
    case "import":
      return IMPORT[refusal.code];
    case "measure":
      return refusal.not_golden ? "gate_blocked" : "infra_failure";
    case "vendor":
    case "context":
    case "guard":
    case "scan":
    case "request_invalid":
      return "gate_blocked";
  }
}

/** The station result of a refusal: the code and nothing else, so no daemon or git text can ride along. */
export const stopFor = (refusal: Refusal): StationResult => ({ kind: "blocked", reason_code: reasonFor(refusal) });

/**
 * A container that is not golden is a refusal for a person (the L1 is already recorded and the key was never handed
 * over); any other failure of create, inspect or probe is the environment. The same rule as S4's, with the cause chain
 * read because `createMeasured` wraps what it cannot classify.
 */
export function measureRefusal(error: unknown): Refusal {
  const notGolden =
    error instanceof NotGoldenError || (error instanceof Error && error.cause instanceof NotGoldenError);
  return { from: "measure", not_golden: notGolden };
}

/** `<stageRoot>/round-<n>`: the one directory a round stages its bundle, quarantine and exported tree in. */
export const roundStageDir = (stageRoot: string, round: number): string => join(stageRoot, `round-${round}`);

/**
 * Deleted as a whole on every refusal after the first byte came back, so a key or a canary that reached the quarantine
 * or the exported tree never stays on disk. Idempotent.
 */
export function discardRoundStage(stageRoot: string, round: number): void {
  rmSync(roundStageDir(stageRoot, round), { recursive: true, force: true });
}

/**
 * The `candidate_checked` event of a round that did not publish. `published` cannot be given: a refused round never
 * publishes, and the type says so.
 */
export function refusedCandidateEvent(
  scope: ImplementerScope,
  round: number,
  over: Partial<Omit<CandidateFacts, "round" | "published">> = {},
): NewEvent {
  return candidateCheckedEvent(scope, {
    round,
    head_sha: null,
    context_sha: null,
    commits: 0,
    plan: "not_checked",
    plan_why: null,
    request: "not_checked",
    scan: "not_run",
    import_failure: null,
    ...over,
    published: false,
  });
}
