import { join } from "node:path";
import { expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { buildRoundImages, type RoundScenario, runJudgeRound } from "../../src/judge/round.js";
import { disposeImages, trackRuntime } from "../../src/judge/state.js";
import { gitFixture } from "../helpers/git-fixture.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { describeGated } from "./helpers.js";
import {
  GATED_LABELS,
  GATED_SCOPE,
  gatedBaseImage,
  gatedHarnessImage,
  gatedJudgeConfig,
  gatedRuntime,
  ownedLeftovers,
} from "./lifecycle-support.js";

const SCENARIOS: RoundScenario[] = [
  {
    scenario_ref: "0123456789abcdef",
    split: "train",
    kind: "behavior",
    category: "interface",
    set: {
      scenario_ref: "0123456789abcdef",
      steps: [
        {
          invoke: { argv: ["world"], stdin: "" },
          expect: { exit_code: 0, stdout_matches: { kind: "exact", text: "hello world\n" }, json_path: null },
        },
      ],
    },
  },
];

const RUN = ["sh", "/work/app.sh"];

describeGated("G-two-container-roundtrip", (ctx) => {
  it("judges a correct candidate as pass and a wrong one as fail, measures every container L2, and leaves only the cached harness image", async () => {
    const base = gatedBaseImage(ctx);
    const harnessBase = gatedHarnessImage(ctx);
    const config = gatedJudgeConfig(ctx, base, harnessBase);
    const runtime = trackRuntime(gatedRuntime(ctx));
    // base prints "bye", head prints "hello": the same scenario passes on head and fails on base.
    const fx = gitFixture({ "app.sh": 'echo bye "$1"\n' }, { "app.sh": 'echo hello "$1"\n' });
    const dir = realTempDir("omf-gated-rt-");
    const ledger = new Ledger(dir, () => new Date());
    const judge = async (sha: string, round: number) => {
      const labels = { ...GATED_LABELS, role: "sut" as const, round };
      const images = await buildRoundImages({
        runtime,
        config,
        contract: { build: ["true"], run: RUN },
        candidate: { quarantine: fx.quarantine, sha },
        labels,
        contextRoot: join(dir, "ctx"),
      });
      try {
        const verdict = await runJudgeRound({
          runtime,
          measure: { runtime, sink: ledger, scope: GATED_SCOPE, itemDir: join(dir, "item"), now: () => new Date() },
          config,
          images,
          scenarios: SCENARIOS,
          phase: "train",
          candidate_sha: sha,
          run: RUN,
          stageRoot: join(dir, "judge"),
          forbidden: [dir],
          round,
          now: () => new Date(),
        });
        return verdict.counts;
      } finally {
        await disposeImages(runtime, images);
      }
    };
    try {
      expect(await judge(fx.head, 1)).toMatchObject({ total: 1, pass: 1, fail: 0 });
      expect(await judge(fx.base, 2)).toMatchObject({ total: 1, pass: 0, fail: 1 });
    } finally {
      runtime.close();
    }
    const measured = ledger.readVerified().filter((event) => event.type === "isolation.measured");
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((event) => event.payload.level === "L2")).toBe(true);
    expect(ownedLeftovers(ctx)).toEqual([]);
  }, 900_000);
});
