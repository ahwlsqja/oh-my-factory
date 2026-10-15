import { join } from "node:path";
import type { MeasureDeps } from "../../src/container/measure.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import { type ContainerWorkCopyDeps, ContainerWorkCopyFactory, type Launch } from "../../src/container/work-copy.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { Ledger } from "../../src/core/ledger.js";
import { hostStage } from "../../src/isolation/evaluate.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import { realTempDir } from "./ops-fixture.js";

export const AT = new Date("2026-10-15T09:00:00Z");
export const IMAGE_INFO: ImageInfo = {
  id: `sha256:${"a".repeat(64)}` as ImageId,
  env_names: ["PATH"],
  user: "",
  volumes: [],
};
export const LABELS = { work_id: "w-0123456789ab", run_id: "r-20261015T090000Z-ab12", round: 1 };

/**
 * Creates the container on `runtime` and skips the daemon-side measurement, which Task 4 tests on its own. Used where the test is
 * about the work copy's lifecycle; the test of the default launch below uses the real `createMeasured`.
 */
export function stubLaunch(runtime: ContainerRuntime): Launch {
  return async (spec) => ({
    handle: await runtime.create(spec),
    measurement: {
      ...hostStage("sut", AT),
      mode: "container",
      level: "L2",
      violations: [],
      facts_sha256: "a".repeat(64),
    },
  });
}

export function measureDeps(runtime: ContainerRuntime): MeasureDeps {
  const dir = realTempDir("omf-measure-");
  return {
    runtime,
    sink: new Ledger(dir, () => AT),
    scope: { goal_id: "g-fast", work_id: LABELS.work_id, run_id: LABELS.run_id },
    itemDir: join(dir, "items", LABELS.work_id),
    now: () => AT,
  };
}

export function workCopyDeps(memory: MemoryRuntime, build: readonly string[] = []): ContainerWorkCopyDeps {
  return {
    runtime: memory,
    measure: measureDeps(memory),
    image: IMAGE_INFO,
    build,
    labels: LABELS,
    config: CONFIG_DEFAULTS.judge,
    stageRoot: realTempDir("omf-stage-"),
    forbidden: [],
  };
}

export function workCopies(
  memory: MemoryRuntime,
  options: { build?: readonly string[]; launch?: Launch } = {},
): { factory: ContainerWorkCopyFactory; stageRoot: string } {
  const deps = workCopyDeps(memory, options.build ?? []);
  return {
    factory: new ContainerWorkCopyFactory(deps, options.launch ?? stubLaunch(memory)),
    stageRoot: deps.stageRoot,
  };
}
