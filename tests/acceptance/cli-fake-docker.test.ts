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
  it("a null implementation never reaches success: its candidate fails the train split and the run ends blocked at GATE-3, exit 2", async () => {
    const line = await setupCliLine({ implementer: "null" });
    const run = line.cli(["run", line.workId]);
    expect(run.code, `${run.stdout}${run.stderr}`).toBe(2);
    expect(line.events("work.submitted")).toEqual([]);
    // The candidate reached the judge and was refused on its merits: no train scenario passed and the gates ran red.
    const round = line.events("judge.round_completed").at(-1)?.payload;
    expect(round).toMatchObject({ phase: "train", pass: 0 });
    expect(Number(round?.fail)).toBeGreaterThan(0);
    expect(line.events("gates.evaluated").at(-1)?.payload).toMatchObject({ status: "RED", failing: ["fast"] });
    // Under this fixture the author is unmeasured, so GATE-3 also fails and the parked outcome is blocked.
    expect(line.events("gate3.evaluated").at(-1)?.payload).toMatchObject({ passed: false, route: "J7" });
    expect(line.events("work.parked").at(-1)?.payload).toMatchObject({
      outcome: "blocked",
      reason_code: "gate_blocked",
    });
    expect(line.events("isolation.measured").map((event) => event.payload.stage)).not.toContain("author");
    expect(line.containers()).toEqual([]);
  }, 180_000);

  it("a working implementation, by contrast, passes the train split and gates green before the same GATE-3 stop", async () => {
    const line = await setupCliLine();
    const run = line.cli(["run", line.workId]);
    expect(run.code, `${run.stdout}${run.stderr}`).toBe(2);
    const round = line.events("judge.round_completed").at(-1)?.payload;
    expect(Number(round?.pass)).toBeGreaterThan(0);
    expect(round?.fail).toBe(0);
    expect(line.events("gates.evaluated").at(-1)?.payload).toMatchObject({ status: "GREEN", failing: [] });
    expect(line.events("work.submitted")).toEqual([]);
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
