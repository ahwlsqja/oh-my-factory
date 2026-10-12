import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import type { IntentCandidate } from "./types.js";

/** NFKC, lowercase, every run of non-letters and non-digits becomes one space, trimmed. */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Posix form: backslashes become slashes, empty and `.` segments (`./x`, `a//b`, `a/./b`, a trailing `/`) disappear. */
export function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * The idempotency key of a candidate (spec §4.4 step 5). It hashes the goal, the normalized title and the sorted,
 * deduplicated, normalized paths and nothing else: rewording the problem or the rationale neither defeats dedupe nor
 * creates a new item. A merely paraphrased title is a documented limit of a deterministic filter.
 */
export function fingerprintOf(goalId: string, candidate: Pick<IntentCandidate, "title" | "affected_paths">): string {
  const paths = [...new Set(candidate.affected_paths.map(normalizePath))].sort();
  return sha256Hex(canonicalize({ goal_id: goalId, title: normalizeTitle(candidate.title), paths }));
}

/** `w-` plus the first 12 hex digits. The work id is the idempotency key: creating an existing id is a no-op. */
export function workIdOf(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("a fingerprint is 64 lowercase hex digits");
  return `w-${fingerprint.slice(0, 12)}`;
}
