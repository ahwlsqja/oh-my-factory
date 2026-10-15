import { forbiddenPaths } from "../container/golden.js";
import type { ProjectLocation } from "../core/paths.js";
import { locationEnv } from "../vault/line-guard.js";

/**
 * What no judge container may be given a path to, for one project location. Every station (the train split, the work
 * copies and the test split) takes it from here, so they judge a mount against the same set whatever the process
 * environment holds.
 */
export function judgeForbiddenPaths(location: ProjectLocation): string[] {
  return forbiddenPaths(location, locationEnv(location));
}
