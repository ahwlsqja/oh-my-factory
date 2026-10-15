import { pinnedImage } from "../../src/container/image-ref.js";
import {
  type ContainerRole,
  type ContainerSpec,
  type OwnedLabels,
  containerName,
  roleTmpfs,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";

// Invented ids and digests; nothing here names a real image, path or home.
export const FIXTURE_WORK_ID = "w-0123456789ab";
export const FIXTURE_RUN_ID = "r-20261015T120000Z-ab12";
export const SUT_BASE = `example.test/omf/sut-base@sha256:${"a".repeat(64)}`;
export const HARNESS_BASE = `example.test/omf/harness-base@sha256:${"b".repeat(64)}`;

export const labelsFor = (role: ContainerRole, round = 1): OwnedLabels => ({
  work_id: FIXTURE_WORK_ID,
  run_id: FIXTURE_RUN_ID,
  round,
  role,
});

/** A spec with the defaults of `[judge]`: what the stations will pass for `role`. */
export function specFor(role: ContainerRole, serial = 1, round = 1): ContainerSpec {
  const labels = labelsFor(role, round);
  const judge = CONFIG_DEFAULTS.judge;
  return {
    name: containerName(labels, serial),
    image: pinnedImage(role === "harness" ? HARNESS_BASE : SUT_BASE),
    labels,
    tmpfs: roleTmpfs(role, judge),
    limits: { memory_mb: judge.memory_mb, cpus: judge.cpus, pids: judge.pids_limit },
  };
}
