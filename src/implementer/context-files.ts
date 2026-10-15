import { createHash } from "node:crypto";
import { resolveJudgeFiles } from "../audit/judge-files.js";
import { type TarEntry, tarOfEntries } from "../container/tar-dir.js";
import type { LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { lintDecisionStrings, loadLeakContext } from "../decision/leak-lint.js";
import { renderSpec } from "../decision/spec-md.js";
import { foldDecisions } from "../decision/state.js";
import { FRONT_MATTER } from "../seal/prompt.js";
import { renderIntent } from "../work/intent-md.js";
import { lintCandidate } from "../work/seed-lint.js";
import type { WorkItem } from "../work/types.js";

/**
 * What the implementer container is given besides the base tree (spec §5.1, §5.4; M3-D15): `spec.md` and `intent.md` under a
 * per-item directory. People commit files with those names at the repository root (spec §11 rule 3) and a merged candidate leaves
 * them tracked, so a shared root path would collide with a repository's own files and with every later item.
 */

const WORK_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The id names a directory, so an id outside the pattern or made only of dots is refused. */
function requireWorkId(workId: string): void {
  if (!WORK_ID.test(workId) || /^\.+$/.test(workId)) {
    throw new Error("work id must match [A-Za-z0-9._-]{1,64} and must not be only dots");
  }
}

export const omfDir = (workId: string): string => {
  requireWorkId(workId);
  return `.omf/${workId}`;
};

export function contextPaths(workId: string): { spec: string; intent: string } {
  const dir = omfDir(workId);
  return { spec: `${dir}/spec.md`, intent: `${dir}/intent.md` };
}

/**
 * The paths whose edit the audit counts as touching a projection. The one source: the S5 station reads it, so the paths the container
 * is given and the paths the audit watches cannot drift apart. A repository's own root `spec.md` is an ordinary file.
 */
export function projectionPathsFor(workId: string): readonly string[] {
  const paths = contextPaths(workId);
  return [paths.spec, paths.intent];
}

export interface ContextFiles {
  spec: string;
  intent: string;
}

/**
 * `spec` is re-rendered from the folded ledger with the leak context (`renderSpec`), never copied from the host file, so a hand edit
 * of `spec.md` changes nothing and a decision that a goal re-lock made leak is withheld. `intent` is the verified item's intent without
 * its front matter (goal id, work id, fingerprint, rationale, paths), after the seal's own leak gate: `lintCandidate` plus
 * `lintDecisionStrings` under the current lock. A finding is `intent_leak` (the station stops `gate_blocked`). The interface checks of
 * `sealInputsFor` are not applied: they belong to the author. Throws what `loadLeakContext` throws when the goal has no lock.
 */
export function buildContextFiles(input: {
  location: ProjectLocation;
  item: WorkItem;
  events: readonly LedgerEvent[];
}): { ok: true; files: ContextFiles } | { ok: false; code: "intent_leak" } {
  const { location, item, events } = input;
  const scope = { goal_id: item.front.goal_id, work_id: item.front.work_id };
  const leak = loadLeakContext(location.dir, scope.goal_id, events);
  const candidate = item.intent.candidate;
  if (lintCandidate(candidate, leak.terms).length > 0 || lintDecisionStrings(candidate, leak).length > 0) {
    return { ok: false, code: "intent_leak" };
  }
  return {
    ok: true,
    files: {
      spec: renderSpec(foldDecisions(events, scope), { title: item.front.title }, leak),
      intent: renderIntent(item.intent).replace(FRONT_MATTER, ""),
    },
  };
}

/** A ustar archive of the two files under `.omf/<work-id>/`, fixed mtime and mode 0644, ready to extract into the container. */
export function contextTar(workId: string, files: ContextFiles): Buffer {
  const paths = contextPaths(workId);
  const entry = (path: string, text: string): TarEntry => ({
    path,
    kind: "file",
    data: Buffer.from(text, "utf8"),
    linkTarget: "",
    executable: false,
  });
  return tarOfEntries([entry(paths.spec, files.spec), entry(paths.intent, files.intent)]);
}

/** The git object id of a blob with these bytes: sha1 of `blob <length>\0` followed by the bytes. */
export function gitBlobSha1(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** The tracked files the test command names (exact argv tokens that are paths of the base tree): the judge-file resolver, so the two agree. */
export function explicitTestPathsFor(testCommand: readonly string[], baseTreePaths: readonly string[]): string[] {
  return resolveJudgeFiles([testCommand], baseTreePaths, []).tracked;
}
