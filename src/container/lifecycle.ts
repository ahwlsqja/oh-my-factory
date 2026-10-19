import type { ContainerHandle } from "./runtime.js";

/**
 * What the host knows about the life of a container it started, kept so that a container that is no longer running can be
 * attributed: the host stopped it, its lifetime ran out, or it stopped early on its own (`stopCause` in running.ts).
 * Keyed by container name, which is unique within a process (serial, run id and round are in it). In memory only: a container
 * of an earlier process is the sweep's business, not a step's.
 */
interface Life {
  /** Host clock reading just after `docker start` returned. */
  startedMs: number | null;
  /** The seconds the container sleeps for (`lifetime_s` of its spec). */
  lifetimeS: number | null;
  /** The host removed or stopped it (a release, a recreate, a cleanup, a sweep): its absence is the host's doing. */
  endedByHost: boolean;
}

const lives = new Map<string, Life>();

/**
 * The host clock the lifetime is measured on, in milliseconds. Monotonic, so a wall-clock step cannot move it. A seam for
 * tests; nothing under `src/` replaces it.
 */
export const hostClock: { now: () => number } = { now: () => performance.now() };

/**
 * The slack the lifetime check gives, milliseconds: it only absorbs the difference between the host's clock and the daemon's
 * and the latency of the calls around `docker start`. A live round never gets near the lifetime, because every bound is 1.5 times
 * the worst case of the calls made while the container is alive (`judgeLifetimeSeconds`).
 */
export const LIFETIME_SLACK_MS = 5000;

const lifeOf = (name: string): Life => {
  let life = lives.get(name);
  if (life === undefined) {
    life = { startedMs: null, lifetimeS: null, endedByHost: false };
    lives.set(name, life);
  }
  return life;
};

/** Called right after `docker start` returned for a container with a lifetime: its sleep began no earlier than this. */
export function recordStarted(handle: Pick<ContainerHandle, "name">, lifetimeS: number): void {
  // A fresh record: an earlier container of the same name (a rerun of a round) must not lend its end to this one.
  lives.set(handle.name, { startedMs: hostClock.now(), lifetimeS, endedByHost: false });
}

/** The host removed or stopped this container (or is about to): a later absence or stop is not the candidate's doing. */
export function markHostEnded(handle: Pick<ContainerHandle, "name"> | string): void {
  lifeOf(typeof handle === "string" ? handle : handle.name).endedByHost = true;
}

export const endedByHost = (handle: Pick<ContainerHandle, "name">): boolean =>
  lives.get(handle.name)?.endedByHost === true;

/**
 * True when the container's sleep has run (or is within `LIFETIME_SLACK_MS` of running) out on the host clock, measured from the
 * recorded start. `null` when no start was recorded: the elapsed time cannot be known.
 */
export function lifetimeElapsed(handle: Pick<ContainerHandle, "name">): boolean | null {
  const life = lives.get(handle.name);
  if (life === undefined || life.startedMs === null || life.lifetimeS === null) return null;
  return hostClock.now() - life.startedMs >= life.lifetimeS * 1000 - LIFETIME_SLACK_MS;
}

/** Test seam: forget every container and restore the clock. */
export function resetLifecycle(): void {
  lives.clear();
  hostClock.now = () => performance.now();
}
