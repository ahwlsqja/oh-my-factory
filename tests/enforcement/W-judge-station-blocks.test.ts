import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NotGoldenError } from "../../src/container/measure.js";
import { JudgeRoundError } from "../../src/judge/round.js";
import type { ReasonCode } from "../../src/work/w-events.js";
import { type Rig, type RigOptions, s4Rig } from "../helpers/judge-rig.js";
import { scenarioFile } from "../helpers/scenario-fixture.js";

const PLANTED = "planted-daemon-text-4417";

interface Case {
  name: string;
  options?: RigOptions;
  arrange?: (r: Rig) => void;
  code: ReasonCode;
  /** True when S4 must stop before it asks the engine to build anything. */
  beforeBuild: boolean;
}

const tamper = (r: Rig): void => {
  const file = scenarioFile(r.s, 0);
  writeFileSync(file, readFileSync(file, "utf8").replace("key-1", "key-9"));
};
const roundFault = (code: ConstructorParameters<typeof JudgeRoundError>[0]): RigOptions => ({
  roundError: new JudgeRoundError(code),
});

const CASES: Case[] = [
  { name: "no candidate", options: { candidate: null }, code: "infra_failure", beforeBuild: true },
  { name: "no docker context", options: { context: null }, code: "infra_failure", beforeBuild: true },
  { name: "daemon down", options: { info: { ok: false, failure: PLANTED } }, code: "infra_failure", beforeBuild: true },
  { name: "non-local endpoint", options: { local: false }, code: "infra_failure", beforeBuild: true },
  { name: "base images unset", options: { judge: null }, code: "infra_failure", beforeBuild: true },
  { name: "image build fails", options: { buildError: new Error(PLANTED) }, code: "infra_failure", beforeBuild: false },
  { name: "runtime fault in the round", options: roundFault("round_error"), code: "infra_failure", beforeBuild: false },
  {
    name: "verdict disagrees with the relay",
    options: roundFault("verdict_mismatch"),
    code: "infra_failure",
    beforeBuild: false,
  },
  {
    name: "a container is not golden",
    options: { roundError: new NotGoldenError([]) },
    code: "gate_blocked",
    beforeBuild: false,
  },
  { name: "the round has no scenarios", options: roundFault("no_scenarios"), code: "gate_blocked", beforeBuild: false },
  { name: "the set was edited after the seal", arrange: tamper, code: "gate_blocked", beforeBuild: true },
  { name: "no standing seal", options: { seal: false }, code: "gate_blocked", beforeBuild: true },
];

// M3f-D4, D8: every way S4 cannot judge ends the station with one closed code. Nothing the daemon, the build or an error
// said reaches the result, the inputs or the ledger, and a set that cannot be trusted is never run.
describe("W-judge-station-blocks", () => {
  it.each(CASES)("$name stops S4 with $code", async ({ options, arrange, code, beforeBuild }) => {
    const r = s4Rig(options);
    arrange?.(r);
    const ctx = r.ctx();
    const result = await r.station.run(ctx);
    expect(result).toEqual({ kind: "blocked", reason_code: code });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(ctx.inputs.sealed.train).toBe("not run");
    expect(r.s.f.fx.ledger.readVerified().some((event) => event.type === "judge.round_completed")).toBe(false);
    if (beforeBuild) expect(r.engine.built).toHaveLength(0);
  });
});
