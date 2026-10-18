import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotGoldenError } from "../../src/container/measure.js";
import type { UserRepoErrorCode } from "../../src/git/user-repo.js";
import type { HistoryScan } from "../../src/implementer/history-scan.js";
import type { ImportFailure } from "../../src/implementer/import.js";
import {
  type Refusal,
  discardRoundStage,
  measureRefusal,
  reasonFor,
  refusedCandidateEvent,
  roundStageDir,
  stopFor,
} from "../../src/implementer/refusals.js";
import type { ImplementerFailureCode } from "../../src/implementer/session.js";
import type { BundleCode, PrepareCode } from "../../src/implementer/workspace.js";
import { makeTempDir } from "../helpers/tmp.js";

const USER_REPO: UserRepoErrorCode[] = [
  "git_dir_unsupported",
  "repo_has_drivers",
  "head_unborn",
  "base_missing",
  "base_not_commit",
  "export_too_large",
  "submodule_present",
  "lfs_pointers",
  "ref_checked_out",
  "ref_not_ours",
  "ref_update_failed",
];
const PREPARE: PrepareCode[] = ["tool_missing", "extract_failed", "init_failed"];
const SESSION: ImplementerFailureCode[] = ["timeout", "spawn_failed", "nonzero_exit", "output_limit", "misconfigured"];
const IMPORT: ImportFailure[] = [
  "bundle_invalid",
  "fsck_failed",
  "head_missing",
  "too_many_commits",
  "history_not_linear",
  "root_tree_mismatch",
  "context_mismatch",
];
const SCAN: Exclude<HistoryScan["status"], "clean">[] = ["credential", "canary", "incomplete"];
const BUNDLE: BundleCode[] = ["finalize_failed", "bundle_too_large", "bundle_malformed"];

const reasons = (refusals: Refusal[]): string[] => [...new Set(refusals.map(reasonFor))];

// The line routes by reason code: infra_failure is "the environment, try again" and gate_blocked is "a person looks".
// A code that moved between them would silently change who is asked, so the table is pinned here.
describe("reasonFor", () => {
  it("sends the environment, the container and the session to infra_failure", () => {
    expect(reasons([{ from: "environment" }, { from: "kill" }])).toEqual(["infra_failure"]);
    expect(reasons(PREPARE.map((code): Refusal => ({ from: "prepare", code })))).toEqual(["infra_failure"]);
    expect(reasons(SESSION.map((code): Refusal => ({ from: "session", code })))).toEqual(["infra_failure"]);
    expect(reasonFor({ from: "bundle", code: "finalize_failed" })).toBe("infra_failure");
    expect(reasonFor({ from: "measure", not_golden: false })).toBe("infra_failure");
  });

  it("sends the repository, the inputs, the returned bytes and every leak to gate_blocked", () => {
    expect(reasons(USER_REPO.map((code): Refusal => ({ from: "user_repo", code })))).toEqual(["gate_blocked"]);
    expect(reasons(IMPORT.map((code): Refusal => ({ from: "import", code })))).toEqual(["gate_blocked"]);
    expect(reasons(SCAN.map((status): Refusal => ({ from: "scan", status })))).toEqual(["gate_blocked"]);
    expect(reasons(BUNDLE.slice(1).map((code): Refusal => ({ from: "bundle", code })))).toEqual(["gate_blocked"]);
    expect(
      reasons([
        { from: "vendor" },
        { from: "context" },
        { from: "guard" },
        { from: "request_invalid" },
        { from: "measure", not_golden: true },
      ]),
    ).toEqual(["gate_blocked"]);
  });

  it("returns a station result that carries the code and nothing else", () => {
    expect(stopFor({ from: "kill" })).toEqual({ kind: "blocked", reason_code: "infra_failure" });
  });
});

describe("measureRefusal", () => {
  it("is not golden for a NotGoldenError, bare or as a cause, and infra for anything else", () => {
    expect(measureRefusal(new NotGoldenError([]))).toEqual({ from: "measure", not_golden: true });
    expect(measureRefusal(new Error("create failed", { cause: new NotGoldenError([]) }))).toEqual({
      from: "measure",
      not_golden: true,
    });
    expect(measureRefusal(new Error("planted-daemon-text"))).toEqual({ from: "measure", not_golden: false });
  });
});

describe("refusedCandidateEvent", () => {
  const scope = { goal_id: "g-test", work_id: "w-0123456789ab", run_id: "r-20261015T120000Z-ab12" };

  it("records a refused round: nothing published, what was not reached stays not_checked", () => {
    const event = refusedCandidateEvent(scope, 2, { scan: "credential", commits: 3 });
    expect(event).toMatchObject({
      actor: "omf",
      type: "implementer.candidate_checked",
      payload: {
        round: 2,
        commits: 3,
        scan: "credential",
        plan: "not_checked",
        request: "not_checked",
        import_failure: null,
        published: false,
      },
    });
  });
});

describe("discardRoundStage", () => {
  it("removes the round's stage directory with everything in it, and a second call is harmless", () => {
    const root = makeTempDir("omf-stage-");
    const round = roundStageDir(root, 1);
    mkdirSync(join(round, "quarantine"), { recursive: true });
    mkdirSync(join(round, "tree-1"), { recursive: true });
    writeFileSync(join(round, "tree-1", "a.txt"), "a");
    mkdirSync(join(root, "round-2"), { recursive: true });
    discardRoundStage(root, 1);
    discardRoundStage(root, 1);
    expect(existsSync(round)).toBe(false);
    expect(existsSync(join(root, "round-2"))).toBe(true);
  });
});
