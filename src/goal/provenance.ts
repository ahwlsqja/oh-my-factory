import type { RunnerKind } from "../adapters/measure-cmd.js";
import type { TreeObservation } from "./git.js";

/**
 * Where a measurement ran, in words that hold on any machine. A host run starts in the repository root; a
 * Docker run mounts that root read-only at `/work`. No absolute path of the person's machine appears here.
 */
export type WorkingDirectoryContract =
  | "repository root (host, no isolation)"
  | "/work (repository root, read-only mount)";

/**
 * What a person needs to judge a measurement's context (host state only, like the rest of the gap report).
 * It holds a commit id, a dirty-state count and a hash, never a path of the machine and never a metric value.
 */
export interface MeasurementProvenance {
  /** HEAD when the observation was taken. */
  revision: string;
  /** `dirty` when `git status` listed any change, including untracked files that are not ignored. */
  tree: "clean" | "dirty";
  /** How many paths `git status` listed; a renamed path counts once. */
  changed_paths: number;
  /** The same hash the ledger records as `input_sha256` for each measured metric. */
  fingerprint: string;
  /** The tree was observed once, before the first metric ran, at `captured_at`. */
  captured_at: string;
  working_directory: WorkingDirectoryContract;
  /** What the fingerprint cannot show. Fixed text, so a reader sees the same limits on every report. */
  limits: readonly string[];
}

export const PROVENANCE_LIMITS: readonly string[] = [
  "The tree was observed once, before the first metric ran; it was not watched while the metrics ran.",
  "The fingerprint covers HEAD and the list of changed paths, not file contents: an edit to a file that was already modified keeps the same fingerprint.",
  "An edit made while a metric runs can change its value without changing this record.",
  "Gitignored files are not part of the observation.",
];

export function provenanceOf(
  observation: TreeObservation,
  capturedAt: Date,
  runner: RunnerKind,
): MeasurementProvenance {
  return {
    revision: observation.head,
    tree: observation.changedPaths === 0 ? "clean" : "dirty",
    changed_paths: observation.changedPaths,
    fingerprint: observation.fingerprint,
    captured_at: capturedAt.toISOString(),
    working_directory:
      runner === "docker" ? "/work (repository root, read-only mount)" : "repository root (host, no isolation)",
    limits: PROVENANCE_LIMITS,
  };
}

/** The lines a person reads after the gap lines. Printed to a terminal and kept out of every model-facing surface. */
export function provenanceLines(p: MeasurementProvenance): string[] {
  const state =
    p.tree === "clean" ? "clean" : `dirty, ${p.changed_paths} changed ${p.changed_paths === 1 ? "path" : "paths"}`;
  return [
    `measured at revision ${p.revision.slice(0, 12)} (${state}), observed ${p.captured_at}`,
    `working directory: ${p.working_directory}`,
    `fingerprint: ${p.fingerprint.slice(0, 12)} (recorded in the ledger as input_sha256)`,
    ...p.limits.map((limit) => `limit: ${limit}`),
  ];
}
