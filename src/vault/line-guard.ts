import { dirname } from "node:path";
import type { ProjectLocation } from "../core/paths.js";
import { SymlinkRefusedError, UnsafePathError, assertStateTreeClean } from "../core/safe-fs.js";
import { PokaYokeError, assertNoSealedInRepo } from "./pokayoke.js";

/**
 * The environment a location implies. `location.dir` is `<home>/projects/<id>`, so the OMF home is two levels
 * up. The guards take it from here, not from `process.env`: the `decide` actions and the stage functions
 * receive a location only, and a default environment would point them at the real home (spec §8).
 */
export function locationEnv(location: ProjectLocation): NodeJS.ProcessEnv {
  return { OMF_HOME: dirname(dirname(location.dir)) };
}

/**
 * The guard run at line entry, before every station and in the `decide` write actions (M3c rule 4, spec §8,
 * M3c-D13, D15): no symlink below the project state, and no sealed material in the repository or an OMF
 * worktree. Throws `SymlinkRefusedError`, `UnsafePathError` or `PokaYokeError`.
 */
export function assertLineSafe(location: ProjectLocation, env: NodeJS.ProcessEnv = locationEnv(location)): void {
  assertStateTreeClean(location, env);
  assertNoSealedInRepo(location, env);
}

export type GuardRefusal = "sealed_material_in_repo" | "symlink_in_state" | "unsafe_state_path";

/** The closed code of a guard refusal, or null when `err` is something else and must be rethrown. */
export function guardRefusal(err: unknown): GuardRefusal | null {
  if (err instanceof PokaYokeError) return "sealed_material_in_repo";
  if (err instanceof SymlinkRefusedError) return "symlink_in_state";
  if (err instanceof UnsafePathError) return "unsafe_state_path";
  return null;
}
