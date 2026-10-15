import { pinnedImage } from "../../src/container/image-ref.js";
import {
  type ContainerRole,
  type ContainerSpec,
  type OwnedLabels,
  type RoleLimits,
  containerName,
  roleLimits,
  roleTmpfs,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS, type ImplementerConfig } from "../../src/core/config.js";

// Invented ids and digests; nothing here names a real image, path or home.
export const FIXTURE_WORK_ID = "w-0123456789ab";
export const FIXTURE_RUN_ID = "r-20261015T120000Z-ab12";
export const SUT_BASE = `example.test/omf/sut-base@sha256:${"a".repeat(64)}`;
export const HARNESS_BASE = `example.test/omf/harness-base@sha256:${"b".repeat(64)}`;
export const IMPLEMENTER_BASE = `example.test/omf/implementer-base@sha256:${"c".repeat(64)}`;

/** Explicit numbers, so the pinned argv of the implementer does not move when a default of `[implementer]` does. */
export const FIXTURE_IMPLEMENTER_LIMITS: ImplementerConfig = {
  ...CONFIG_DEFAULTS.implementer,
  memory_mb: 2048,
  cpus: 2,
  pids_limit: 512,
  tmp_tmpfs_mb: 256,
  work_tmpfs_mb: 1024,
  agent_tmpfs_mb: 256,
};

export const labelsFor = (role: ContainerRole, round = 1): OwnedLabels => ({
  work_id: FIXTURE_WORK_ID,
  run_id: FIXTURE_RUN_ID,
  round,
  role,
});

/** The limits the stations pass for `role`: `[judge]` defaults for a judge role, the fixture numbers for the implementer. */
export const limitsFor = (role: ContainerRole): RoleLimits =>
  role === "implementer"
    ? { kind: "implementer", implementer: FIXTURE_IMPLEMENTER_LIMITS }
    : { kind: "judge", judge: CONFIG_DEFAULTS.judge };

const imageFor = (role: ContainerRole): string =>
  role === "harness" ? HARNESS_BASE : role === "implementer" ? IMPLEMENTER_BASE : SUT_BASE;

export function specFor(role: ContainerRole, serial = 1, round = 1): ContainerSpec {
  const labels = labelsFor(role, round);
  const limits = limitsFor(role);
  return {
    name: containerName(labels, serial),
    image: pinnedImage(imageFor(role)),
    labels,
    tmpfs: roleTmpfs(role, limits),
    limits: roleLimits(role, limits),
  };
}
