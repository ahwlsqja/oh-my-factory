import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forbiddenPaths } from "../../src/container/golden.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import { realEngine } from "../../src/judge/engine.js";
import { runJudgeRound } from "../../src/judge/round.js";
import { containerTestJudge } from "../../src/judge/test-judge.js";
import { containerWorkCopies } from "../../src/judge/work-copies.js";
import { locationEnv } from "../../src/vault/line-guard.js";
import type { StationContext } from "../../src/work/sequencer.js";
import { NOW, setupDecisionItem } from "../helpers/decision-fixture.js";
import { TEST, contextOf, roundState, verdictOf } from "../helpers/s6-fixture.js";
import { setupLine } from "../helpers/line.js";

const built = vi.hoisted(() => ({ forbidden: [] as readonly string[][] }));

vi.mock("../../src/container/work-copy.js", () => ({
  ContainerWorkCopyFactory: class {
    constructor(input: { forbidden: string[] }) {
      built.forbidden = [...built.forbidden, input.forbidden];
    }
  },
}));
vi.mock("../../src/judge/round.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/judge/round.js")>()),
  runJudgeRound: vi.fn(),
}));

const IMAGE = `node@sha256:${"a".repeat(64)}`;
const INFO: ImageInfo = { id: `sha256:${"b".repeat(64)}` as ImageId, env_names: ["PATH"], user: "", volumes: [] };

afterEach(() => {
  vi.unstubAllEnvs();
  built.forbidden = [];
});

describe("the forbidden-path set of the three judge stations", () => {
  it("is the same for one location whatever the process environment holds", async () => {
    // A different home in the process environment must not move what any station forbids.
    vi.stubEnv("HOME", "/somewhere/else/entirely");
    vi.stubEnv("OMF_HOME", "/somewhere/else/entirely/.omf");

    const l = setupLine();
    const expected = forbiddenPaths(l.fx.location, locationEnv(l.fx.location));

    const s4 = realEngine().forbiddenPaths(l.fx.location);

    vi.mocked(runJudgeRound).mockResolvedValueOnce(verdictOf("test", TEST, []));
    await containerTestJudge({ location: l.fx.location, runtime: {} as ContainerRuntime })({
      ctx: contextOf(l),
      state: roundState(),
      scenarios: TEST,
    });
    const s6 = vi.mocked(runJudgeRound).mock.calls[0]?.[0].forbidden;

    const f = setupDecisionItem();
    appendFileSync(
      join(l.fx.location.dir, "config.toml"),
      `\n[judge]\nsut_base_image = "${IMAGE}"\ndocker_context = "colima-omf-m3f"\n`,
    );
    const runtime = new Proxy({} as ContainerRuntime, {
      get: (_t, prop) => (prop === "context" ? "colima-omf-m3f" : async () => INFO),
    });
    const ctx = {
      runId: "r-20261014T000100Z-ab01",
      workId: f.workId,
      goalId: f.scope.goal_id,
      round: 1,
      item: f.item,
      now: () => NOW,
    } as StationContext;
    await containerWorkCopies({ location: l.fx.location, runtime }, ctx, { build: ["true"] });
    const s5 = built.forbidden[0];

    expect(s4).toEqual(expected);
    expect(s6).toEqual(expected);
    expect(s5).toEqual(expected);
  });
});
