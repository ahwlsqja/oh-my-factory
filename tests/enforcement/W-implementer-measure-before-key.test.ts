import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MeasureError, NotGoldenError, createMeasured } from "../../src/container/measure.js";
import { isolationPath } from "../../src/isolation/record.js";
import { TEST_SECRET, secretHandle } from "../helpers/container-fixture.js";
import { RUN, type MeasureFixture, type Tamper, measureFixture, verbOf } from "../helpers/measure-fixture.js";

// W-implementer-measure-before-key: the way a station uses the container layer is "measure, then hand over the key". The key is
// handed over only to a container whose recorded measurement is golden; in every refusal no call at all carried it.
async function measureThenRun(f: MeasureFixture): Promise<void> {
  const { handle } = await createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"));
  await f.deps.runtime.exec(handle, {
    argv: ["claude", "-p"],
    secret: secretHandle(),
    timeoutMs: 1000,
    maxOutputBytes: 1000,
  });
}

function expectNeverCarried(f: MeasureFixture): void {
  expect(f.envs.every((env) => env === undefined)).toBe(true);
  expect(f.seen.some((argv) => argv.includes("ANTHROPIC_API_KEY"))).toBe(false);
  expect(JSON.stringify(f.seen)).not.toContain(TEST_SECRET);
}

interface Refusal {
  label: string;
  tamper: Tamper;
  options: { imageEnv?: string[] };
  error: typeof NotGoldenError | typeof MeasureError;
}
const REFUSALS: Refusal[] = [
  {
    label: "a tampered inspect (privileged)",
    tamper: { inspect: (doc) => void (doc.HostConfig.Privileged = true) },
    options: {},
    error: NotGoldenError,
  },
  {
    label: "an image that bakes in the key name",
    tamper: {},
    options: { imageEnv: ["PATH=/usr/bin", "ANTHROPIC_API_KEY=not-a-real-value"] },
    error: NotGoldenError,
  },
  {
    label: "a codex binary found by the probe",
    tamper: { probe: "vendor:codex\nsocket:0\nend\n" },
    options: {},
    error: NotGoldenError,
  },
  { label: "a probe that cannot be read", tamper: { probe: "socket:0\n" }, options: {}, error: MeasureError },
];

describe("W-implementer-measure-before-key", () => {
  it.each(REFUSALS)(
    "$label: the measurement fails and no call carried the secret",
    async ({ tamper, options, error }) => {
      const f = await measureFixture(tamper, options);
      await expect(measureThenRun(f)).rejects.toBeInstanceOf(error);
      expectNeverCarried(f);
      expect(f.lifecycle().at(-1)).toBe("rm");
      expect(f.lifecycle().filter((verb) => verb === "exec").length).toBeLessThanOrEqual(1);
    },
  );

  it("a golden container is measured L2 first; then exactly one later exec carries the name, the value only in the client's environment", async () => {
    const f = await measureFixture();
    await measureThenRun(f);
    const execs = f.seen.flatMap((argv, at) => (verbOf(argv) === "exec" ? [at] : []));
    expect(execs).toHaveLength(2);
    const [probe, key] = execs as [number, number];
    expect(f.envs[probe]).toBeUndefined();
    expect(f.envs[key]).toEqual({ ANTHROPIC_API_KEY: TEST_SECRET });
    expect(f.envs.filter((env) => env !== undefined)).toHaveLength(1);
    expect(f.seen[key]).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(f.seen)).not.toContain(TEST_SECRET);
    expect(f.run().stages.implementer).toMatchObject({ level: "L2", measurements: 1 });
    const record = readFileSync(isolationPath(f.itemDir, RUN), "utf8");
    expect(record).not.toContain(TEST_SECRET);
    expect(JSON.stringify(f.isolationEvents())).not.toContain(TEST_SECRET);
  });
});
