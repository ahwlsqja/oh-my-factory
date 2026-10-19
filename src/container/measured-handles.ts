import type { ContainerHandle } from "./runtime.js";

/**
 * The handles `createMeasured` returned, that is, containers judged golden for their role. A secret exec is refused on any
 * other handle, so the order "measure, then hand over the key" holds in the runtime and not only in the one caller that
 * follows it today. Identity, not shape: a copy of a handle is not in the set.
 */
const measured = new WeakSet<ContainerHandle>();

/** Called by `createMeasured` once the judgment passed, and by nothing else in shipped code. */
export function markMeasured(handle: ContainerHandle): ContainerHandle {
  measured.add(handle);
  return handle;
}

export const isMeasured = (handle: ContainerHandle): boolean => measured.has(handle);
