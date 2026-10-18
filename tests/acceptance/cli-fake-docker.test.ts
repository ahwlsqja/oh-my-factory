import { describe, expect, it } from "vitest";
import { setupCliLine } from "../helpers/cli-line.js";
import { MUTATING_VERBS, verbOf } from "../helpers/fake-docker.js";

// covers: S7.unmeasured-stage-no-claim
//
// The negative paths of the offline acceptance, through the built CLI over the stateful fake docker. Like the main walk
// (tests/enforcement/W-cli-fake-docker-unmeasured.test.ts) this is wiring: it shows the pipeline refusing, not a container
// being isolated.

const AUTHOR_KEY = "omf-sentinel-author-key-4d8e2b7a91c0f356";

describe("offline acceptance through the shipped CLI", () => {
  it("a null implementation never reaches success", async () => {
    const line = await setupCliLine({ implementer: "null" });
    const run = line.cli(["run", line.workId]);
    expect(run.code, `${run.stdout}${run.stderr}`).not.toBe(0);
    expect(line.events("work.submitted")).toEqual([]);
    expect(line.events("isolation.measured").map((event) => event.payload.stage)).not.toContain("author");
    expect(line.containers()).toEqual([]);
  }, 180_000);

  it("omf run before any seal is refused naming GATE-2: nothing started, no ledger event", async () => {
    const line = await setupCliLine({ sealed: false });
    const before = line.events().length;
    const run = line.cli(["run", line.workId]);
    const output = `${run.stdout}${run.stderr}`;
    expect(run.code, output).toBe(2);
    expect(output).toMatch(/GATE-2/);
    expect(output).toContain(`omf seal ${line.workId}`);
    expect(line.events()).toHaveLength(before);
    expect(line.bin.state().calls.filter((call) => MUTATING_VERBS.has(verbOf(call.argv)))).toEqual([]);
  }, 60_000);

  it("omf seal fails closed when nothing answers the container probe: no key sent, no seal, no author measurement", async () => {
    const line = await setupCliLine({ sealed: false });
    const seal = line.cli(["seal", line.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY });
    const output = `${seal.stdout}${seal.stderr}`;
    expect(seal.code, output).toBe(2);
    expect(output).not.toContain(AUTHOR_KEY);
    expect(line.events("seal.failed").map((event) => event.payload.code)).toEqual(["container_failed"]);
    expect(line.events("seal.completed")).toEqual([]);
    expect(line.events("isolation.measured")).toEqual([]);
    const calls = line.bin.state().calls;
    expect(
      calls.some((call) => verbOf(call.argv) === "create"),
      "the author container was created",
    ).toBe(true);
    expect(
      calls.filter((call) => call.argv.includes("CODEX_API_KEY")),
      "no exec carried the key before the measurement",
    ).toEqual([]);
    expect(line.containers()).toEqual([]);
  }, 60_000);
});
