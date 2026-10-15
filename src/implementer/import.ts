import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertOutsideAgentHomes, assertOutsideRepo } from "../core/paths.js";
import { HostGitError, createScratchGitDir, type GitTarget } from "../git/hardened.js";
import {
  type ChainEntry,
  type RawDiffEntry,
  blobId,
  bundleHeadSha,
  bundleVerify,
  commitChain,
  fsckStrict,
  rawDiff,
  resolveCommit,
  treeSha,
  unbundle,
} from "../git/ops.js";
import { type ContextFiles, contextPaths, gitBlobSha1 } from "./context-files.js";

/** More commits than this is not a session's work (spec §5.4): it is refused before any of them is looked at. */
export const MAX_IMPORT_COMMITS = 500;

export type ImportFailure =
  | "bundle_invalid"
  | "fsck_failed"
  | "head_missing"
  | "too_many_commits"
  | "history_not_linear"
  | "root_tree_mismatch"
  | "context_mismatch";

export interface ImportedCandidate {
  quarantine: GitTarget;
  /** The container's root commit: its tree equals the user's base tree. */
  root: string;
  /** The commit that added the two rendered context files. */
  context: string;
  head: string;
  /** The commits after the context commit, oldest first. */
  work: ChainEntry[];
}

export interface ImportInput {
  /** Absolute, outside the user's repository. The bundle and the quarantine live under it. */
  stageDir: string;
  repo: string;
  bundle: Buffer;
  workId: string;
  expect: { base_tree_sha: string; context: ContextFiles };
}

export type ImportResult = { ok: true; value: ImportedCandidate } | { ok: false; code: ImportFailure };

const refused = (code: ImportFailure): ImportResult => ({ ok: false, code });

/**
 * True when the context commit differs from the root by exactly the two rendered files: both added, both regular
 * non-executable files, each with the bytes the host rendered. A path that is not valid UTF-8 in the diff is a mismatch.
 */
async function contextMatches(
  quarantine: GitTarget,
  rootSha: string,
  contextSha: string,
  workId: string,
  expected: ContextFiles,
): Promise<boolean> {
  const paths = contextPaths(workId);
  const wanted = [
    { path: paths.intent, bytes: Buffer.from(expected.intent, "utf8") },
    { path: paths.spec, bytes: Buffer.from(expected.spec, "utf8") },
  ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  let diff: RawDiffEntry[];
  try {
    diff = await rawDiff(quarantine, rootSha, contextSha);
  } catch (error) {
    if (error instanceof HostGitError) throw error;
    return false;
  }
  if (diff.length !== wanted.length) return false;
  for (const [index, file] of wanted.entries()) {
    const seen = diff[index];
    if (
      seen === undefined ||
      seen.path !== file.path ||
      seen.status !== "A" ||
      seen.old_mode !== "000000" ||
      seen.new_mode !== "100644"
    ) {
      return false;
    }
    if ((await blobId(quarantine, contextSha, file.path)) !== gitBlobSha1(file.bytes)) return false;
  }
  return true;
}

async function admit(input: ImportInput, quarantineRoot: string, bundleFile: string): Promise<ImportResult> {
  const quarantine: GitTarget = { gitDir: await createScratchGitDir(quarantineRoot, input.repo) };
  if (!(await bundleVerify(quarantine, bundleFile))) return refused("bundle_invalid");
  try {
    await unbundle(quarantine, bundleFile);
  } catch (error) {
    if (error instanceof HostGitError && (error.code === "git_failed" || error.code === "output_limit")) {
      return refused("bundle_invalid");
    }
    throw error;
  }
  if (!(await fsckStrict(quarantine))) return refused("fsck_failed");

  const head = await bundleHeadSha(quarantine, bundleFile);
  if (head === null || (await resolveCommit(quarantine, head)) === null) return refused("head_missing");

  let chain: ChainEntry[];
  try {
    chain = await commitChain(quarantine, head, MAX_IMPORT_COMMITS + 1);
  } catch (error) {
    if (error instanceof HostGitError) throw error;
    return refused("too_many_commits");
  }
  if (chain.length > MAX_IMPORT_COMMITS) return refused("too_many_commits");
  const linear =
    chain.every((entry, index) =>
      index === 0
        ? entry.parents.length === 0
        : entry.parents.length === 1 && entry.parents[0] === chain[index - 1]?.sha,
    ) && chain.at(-1)?.sha === head;
  const [root, context] = chain;
  if (!linear || root === undefined) return refused("history_not_linear");

  if ((await treeSha(quarantine, root.sha)) !== input.expect.base_tree_sha) return refused("root_tree_mismatch");
  if (
    context === undefined ||
    !(await contextMatches(quarantine, root.sha, context.sha, input.workId, input.expect.context))
  ) {
    return refused("context_mismatch");
  }
  return { ok: true, value: { quarantine, root: root.sha, context: context.sha, head, work: chain.slice(2) } };
}

/**
 * Takes the bytes a container's script printed and returns a quarantine repository holding only objects the host has
 * checked (spec §5.4, §7). Order: write the bundle (0600, exclusive), create a fresh bare repository, `bundle verify`,
 * `unbundle` (objects, no ref, no transport), `fsck --strict`, then the shape: one ref named `HEAD`, a linear history of at
 * most 500 commits, a root commit whose tree is the user's base tree, and a second commit that adds exactly the two
 * rendered context files. Ref names, the container's `.git`, its config and its hooks are never read; nothing in the
 * bundle can name a file the host opens. On any refusal the quarantine is deleted; the bundle file is always deleted.
 * A git failure that says nothing about the bundle (a timeout, a bad git directory) is thrown, not turned into a code.
 */
export async function importBundle(input: ImportInput): Promise<ImportResult> {
  assertOutsideAgentHomes(input.stageDir);
  assertOutsideRepo(input.stageDir, input.repo);
  mkdirSync(input.stageDir, { recursive: true, mode: 0o700 });
  const bundleFile = join(input.stageDir, "bundle");
  writeFileSync(bundleFile, input.bundle, { flag: "wx", mode: 0o600 });
  const quarantineRoot = join(input.stageDir, "quarantine");
  try {
    const outcome = await admit(input, quarantineRoot, bundleFile);
    if (!outcome.ok) rmSync(quarantineRoot, { recursive: true, force: true });
    return outcome;
  } catch (error) {
    rmSync(quarantineRoot, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(bundleFile, { force: true });
  }
}
