import { join } from "node:path";
import { expect, it } from "vitest";
import { ContainerWorkCopyFactory } from "../../src/container/work-copy.js";
import { Ledger } from "../../src/core/ledger.js";
import { revertPatch } from "../../src/git/ops.js";
import { trackRuntime } from "../../src/judge/state.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { calcFixture } from "../helpers/prove-fixture.js";
import { describeGated } from "./helpers.js";
import {
  GATED_LABELS,
  GATED_SCOPE,
  gatedBaseImage,
  gatedJudgeConfig,
  gatedRuntime,
  ownedLeftovers,
} from "./lifecycle-support.js";

const OPTIONS = { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 };

describeGated("G-work-copy-real", (ctx) => {
  it("runs a staged tree in a real read-only container, re-extracts after a patch, measures L2 and leaves nothing behind", async () => {
    const base = gatedBaseImage(ctx);
    const runtime = trackRuntime(gatedRuntime(ctx));
    const image = await runtime.ensureImage(base);
    const fx = calcFixture();
    const dir = realTempDir("omf-gated-wc-");
    const ledger = new Ledger(dir, () => new Date());
    const factory = new ContainerWorkCopyFactory({
      runtime,
      measure: { runtime, sink: ledger, scope: GATED_SCOPE, itemDir: join(dir, "item"), now: () => new Date() },
      image,
      build: [],
      labels: GATED_LABELS,
      config: gatedJudgeConfig(ctx, base),
      stageRoot: join(dir, "judge"),
      forbidden: [dir],
    });
    try {
      const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
      expect(await copy.run(["cat", "src/calc.mjs"], OPTIONS)).toMatchObject({
        kind: "exited",
        status: 0,
        stdout: expect.stringContaining("a + b"),
      });
      const write = await copy.run(["sh", "-c", "echo x > /etc/omf-probe"], OPTIONS); // the root filesystem is read-only
      expect(write.kind === "exited" && write.status !== 0).toBe(true);
      expect(await copy.isClean()).toBe(true);
      const patch = await revertPatch(fx.quarantine, fx.base, fx.head, ["src/calc.mjs"]);
      expect(await copy.applyPatch(patch, { reverse: true })).toBe(true);
      expect(await copy.run(["cat", "src/calc.mjs"], OPTIONS)).toMatchObject({
        stdout: expect.stringContaining("a - b"),
      });
      await copy.dispose();
    } finally {
      runtime.close();
    }
    const measured = ledger.readVerified().filter((event) => event.type === "isolation.measured");
    expect(measured.length).toBeGreaterThanOrEqual(2); // the first container and the one made after the patch
    expect(measured.every((event) => event.payload.level === "L2")).toBe(true);
    expect(ownedLeftovers(ctx)).toEqual([]);
  }, 300_000);
});
