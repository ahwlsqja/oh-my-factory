import { type GitTarget, HostGitError } from "../git/hardened.js";
import { readBlob } from "../git/ops.js";

export type BoundedBlob = Buffer | "too_large" | "unreadable";

/**
 * One blob of a quarantine commit, at most `maxBytes` of it. The bytes come from a container, so an oversize or
 * unreadable blob (a directory or a gitlink under that path, a failed read) is an answer, not an exception: the callers
 * map both to their own closed codes. One byte more than the cap is requested so a blob over it is told from one at it.
 */
export async function readBounded(
  target: GitTarget,
  sha: string,
  path: string,
  maxBytes: number,
): Promise<BoundedBlob> {
  let bytes: Buffer | null;
  try {
    bytes = await readBlob(target, sha, path, maxBytes + 1);
  } catch (error) {
    if (error instanceof HostGitError && error.code === "output_limit") return "too_large";
    if (error instanceof HostGitError && error.code === "git_failed") return "unreadable";
    throw error;
  }
  if (bytes === null) return "unreadable";
  return bytes.length > maxBytes ? "too_large" : bytes;
}
