import type { GitTarget } from "../git/hardened.js";
import { type ChainEntry, rawDiff } from "../git/ops.js";
import { readBounded } from "./bounded-blob.js";
import { omfDir } from "./context-files.js";

/**
 * The plan-first rule (spec §5.1): the implementer's first commit adds the plan and nothing else, so a person reading the
 * branch sees the intent before the code. The check reads the commit chain of the imported bundle and one blob, never a
 * container file; the plan text is untrusted evidence, shown to a person and never decisive.
 */

export const PLAN_MAX_BYTES = 65_536;
export const PLAN_SUMMARY_CHARS = 2_000;

/** Per-item path: a base that already tracks other items' plans, or a root plan.md, never makes a new item fail. */
export const planPath = (workId: string): string => `${omfDir(workId)}/plan.md`;

export type PlanWhy = "no_commits" | "first_commit_not_plan_only" | "plan_empty" | "plan_not_text";
export type PlanCheck = { status: "ok"; summary: string } | { status: "missing"; why: PlanWhy };

const missing = (why: PlanWhy): PlanCheck => ({ status: "missing", why });
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** Newline and tab stay, so a multi-line plan reads as one; every other control and bidirectional-override character goes. */
const stripControl = (text: string): string =>
  text.replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, (char) =>
    char === "\n" || char === "\t" ? char : "",
  );

/**
 * `work` are the commits after the context commit, oldest first. The first must be exactly `A .omf/<work-id>/plan.md`: a
 * regular file of 1 to 65536 bytes, UTF-8, no NUL. A symlink, gitlink, oversize or binary file is `plan_not_text`.
 * `summary` is the first 2000 characters, control characters removed. It is not redacted here: the history scan that runs
 * before this check already refuses any blob that holds the credential.
 */
export async function checkPlanFirst(
  quarantine: GitTarget,
  workId: string,
  contextSha: string,
  work: readonly ChainEntry[],
): Promise<PlanCheck> {
  const first = work[0];
  if (first === undefined) return missing("no_commits");
  const path = planPath(workId);
  if (first.parents.length !== 1 || first.parents[0] !== contextSha) return missing("first_commit_not_plan_only");
  const changes = await rawDiff(quarantine, contextSha, first.sha);
  const [change] = changes;
  if (changes.length !== 1 || change === undefined || change.path !== path || change.status !== "A") {
    return missing("first_commit_not_plan_only");
  }
  if (!REGULAR_FILE_MODES.has(change.new_mode)) return missing("plan_not_text");
  const bytes = await readBounded(quarantine, first.sha, path, PLAN_MAX_BYTES);
  if (bytes === "too_large" || bytes === "unreadable") return missing("plan_not_text");
  if (bytes.length === 0) return missing("plan_empty");
  if (bytes.includes(0)) return missing("plan_not_text");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return missing("plan_not_text");
  }
  if (text.trim() === "") return missing("plan_empty");
  return { status: "ok", summary: [...stripControl(text)].slice(0, PLAN_SUMMARY_CHARS).join("") };
}
