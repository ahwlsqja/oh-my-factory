import { vi } from "vitest";
import { recordStarted } from "../../src/container/lifecycle.js";
import type { MeasureDeps, MeasuredContainer } from "../../src/container/measure.js";
import type { ContainerRole, ContainerSpec } from "../../src/container/spec.js";
import { ROLE_STAGE } from "../../src/container/spec.js";
import type { StageGolden } from "../../src/isolation/evaluate.js";
import { hostStage } from "../../src/isolation/evaluate.js";

export interface MeasuredCall {
  role: ContainerRole;
  name: string;
  golden: StageGolden;
}
/** Shared between the mocked module and the test that imports this file: both get the same instance. */
export const measureHook: { measured: MeasuredCall[]; failWith: ((role: ContainerRole) => Error | null) | null } = {
  measured: [],
  failWith: null,
};
export function resetMeasureHook(): void {
  measureHook.measured = [];
  measureHook.failWith = null;
}

/**
 * Same order as the real `createMeasured` for a golden container (create, then start), without the inspect and the probe,
 * which Task 4 proves. A role in `failWith` fails before anything is created, like a facts violation.
 */
export async function measureMockModule() {
  const real = await vi.importActual<typeof import("../../src/container/measure.js")>("../../src/container/measure.js");
  return {
    ...real,
    createMeasured: async (deps: MeasureDeps, spec: ContainerSpec, golden: StageGolden): Promise<MeasuredContainer> => {
      measureHook.measured.push({ role: spec.labels.role, name: spec.name, golden });
      const failure = measureHook.failWith?.(spec.labels.role) ?? null;
      if (failure !== null) throw failure;
      const handle = await deps.runtime.create(spec);
      await deps.runtime.start(handle);
      recordStarted(handle, spec.lifetime_s);
      return { handle, measurement: hostStage(ROLE_STAGE[spec.labels.role], deps.now()) };
    },
  };
}
