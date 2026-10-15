import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import { ContainerWorkCopyFactory } from "../../src/container/work-copy.js";
import { containerWorkCopies } from "../../src/judge/work-copies.js";
import type { StationContext } from "../../src/work/sequencer.js";
import { NOW, setupDecisionItem } from "../helpers/decision-fixture.js";

const IMAGE = `node@sha256:${"a".repeat(64)}`;
const INFO: ImageInfo = { id: `sha256:${"b".repeat(64)}` as ImageId, env_names: ["PATH"], user: "", volumes: [] };

/** Every method answers by name and fails, except `ensureImage`: the factory may do nothing else while it is built. */
function runtimeDouble() {
  const calls: string[] = [];
  const runtime = new Proxy({} as ContainerRuntime, {
    get: (_target, prop) => {
      if (prop === "context") return "colima-omf-m3f";
      return async () => {
        calls.push(String(prop));
        if (prop === "ensureImage") return INFO;
        throw new Error(`unexpected runtime call: ${String(prop)}`);
      };
    },
  });
  return { runtime, calls };
}

function setup() {
  const f = setupDecisionItem();
  // The factory reads only the ids, the item directory and the clock.
  const ctx = {
    runId: "r-20261014T000100Z-ab01",
    workId: f.workId,
    goalId: f.scope.goal_id,
    round: 1,
    item: f.item,
    now: () => NOW,
  } as StationContext;
  return { f, ctx, ...runtimeDouble() };
}

const CONTRACT = { build: ["npm", "run", "build"] };

describe("containerWorkCopies", () => {
  it("refuses to build copies while no image is configured, and touches no runtime", async () => {
    const s = setup();
    await expect(
      containerWorkCopies({ location: s.f.fx.location, runtime: s.runtime }, s.ctx, CONTRACT),
    ).rejects.toMatchObject({
      name: "WorkCopiesError",
      code: "image_not_configured",
    });
    expect(s.calls).toEqual([]);
  });

  it("returns the container-backed factory once the pinned base image is present", async () => {
    const s = setup();
    appendFileSync(
      join(s.f.fx.location.dir, "config.toml"),
      `\n[judge]\nsut_base_image = "${IMAGE}"\ndocker_context = "colima-omf-m3f"\n`,
    );
    const env = { ...s.f.fx.env, HOME: s.f.fx.home }; // the temp home, never the real one
    const copies = await containerWorkCopies({ location: s.f.fx.location, runtime: s.runtime, env }, s.ctx, CONTRACT);
    expect(copies).toBeInstanceOf(ContainerWorkCopyFactory);
    expect(s.calls).toEqual(["ensureImage"]);
  });
});
