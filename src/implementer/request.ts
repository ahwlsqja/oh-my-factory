import { safeText } from "../core/safe-text.js";
import { validateDef } from "../core/schema.js";
import type { GitTarget } from "../git/hardened.js";
import { blobId } from "../git/ops.js";
import { readBounded } from "./bounded-blob.js";
import { omfDir } from "./context-files.js";

/**
 * The implementer's way to ask a person (spec §6.2): it commits `.omf/<work-id>/request.json` naming a conflict between a
 * test and the spec. OMF reads that one file from the head tree of the imported bundle. Only the kind and the paths that
 * exist in the base tree survive; the note is free text from a container, so only whether one was there is kept. A file
 * that is present but unusable is `invalid`: the station stops that run without parking the item for good.
 */

export const REQUEST_MAX_BYTES = 16_384;
export const requestPath = (workId: string): string => `${omfDir(workId)}/request.json`;

export interface ConflictRequest {
  kind: "test_conflict" | "spec_conflict";
  /** At most 10, each present in the base tree, deduplicated and sorted. */
  paths: string[];
  note_present: boolean;
}
export type RequestRead = { status: "none" } | { status: "raised"; request: ConflictRequest } | { status: "invalid" };

export async function readConflictRequest(
  quarantine: GitTarget,
  workId: string,
  head: string,
  basePaths: ReadonlySet<string>,
): Promise<RequestRead> {
  const path = requestPath(workId);
  if ((await blobId(quarantine, head, path)) === null) return { status: "none" };
  const bytes = await readBounded(quarantine, head, path, REQUEST_MAX_BYTES);
  if (bytes === "too_large" || bytes === "unreadable") return { status: "invalid" };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { status: "invalid" };
  }
  if (!validateDef("implementer-event.schema.json", "request_file", doc).ok) return { status: "invalid" };
  // A path with a control, line-break or bidi/format character could hide or fake text where a person reads it.
  if ((doc as { paths: string[] }).paths.some((candidate) => safeText(candidate) !== candidate)) {
    return { status: "invalid" };
  }
  const file = doc as { kind: ConflictRequest["kind"]; paths: string[]; note?: string };
  return {
    status: "raised",
    request: {
      kind: file.kind,
      paths: [...new Set(file.paths)].filter((candidate) => basePaths.has(candidate)).sort(),
      note_present: (file.note ?? "").trim() !== "",
    },
  };
}
