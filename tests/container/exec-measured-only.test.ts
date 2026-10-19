import { describe, expect, it } from "vitest";
import { createMeasured } from "../../src/container/measure.js";
import { TEST_SECRET } from "../helpers/container-fixture.js";
import { type MeasureFixture, measureFixture } from "../helpers/measure-fixture.js";

// A key reaches an agent container only through a handle that `createMeasured` returned, that is, after the container was
// judged golden. A handle made any other way (a bare `create`, a copy of a handle) is refused for a secret exec.
const PLAIN = { argv: ["env"], timeoutMs: 1000, maxOutputBytes: 1000 } as const;
/** The author stage is measured with a deferred record: its measurement is bound to a seal that does not exist yet. */
const deferred = (f: MeasureFixture) => ({ runtime: f.deps.runtime, now: f.deps.now, defer: (): void => undefined });
const secret = (reads: { n: number }) => ({
  name: "CODEX_API_KEY" as const,
  reveal: () => {
    reads.n += 1;
    return TEST_SECRET;
  },
});

describe("a secret exec needs a handle made by createMeasured", () => {
  it("accepts the handle createMeasured returned", async () => {
    const f = await measureFixture({ probe: "vendor:codex\nsocket:0\nend\n" });
    const { handle } = await createMeasured(deferred(f), f.spec("author"), f.golden("author"));
    const reads = { n: 0 };
    await f.deps.runtime.exec(handle, { ...PLAIN, secret: secret(reads) });
    expect(reads.n).toBe(1);
  });

  it("refuses a handle from a bare create, and a copy of a measured handle, before the value is read", async () => {
    const f = await measureFixture({ probe: "vendor:codex\nsocket:0\nend\n" });
    const bare = await f.deps.runtime.create(f.spec("author", 2));
    const measured = await createMeasured(deferred(f), f.spec("author"), f.golden("author"));
    const reads = { n: 0 };
    for (const handle of [bare, { ...measured.handle }]) {
      await expect(f.deps.runtime.exec(handle, { ...PLAIN, secret: secret(reads) })).rejects.toMatchObject({
        code: "invalid_exec",
      });
    }
    expect(reads.n).toBe(0);
  });

  it("still runs an exec without a secret on any handle", async () => {
    const f = await measureFixture({ probe: "vendor:codex\nsocket:0\nend\n" });
    const bare = await f.deps.runtime.create(f.spec("author", 2));
    await f.deps.runtime.start(bare);
    await expect(f.deps.runtime.exec(bare, PLAIN)).resolves.toBeDefined();
  });
});
