import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanaryIndexEntry } from "../../src/audit/attribute.js";
import { textSurface } from "../../src/audit/canary-scan.js";
import type { RoundScope } from "../../src/audit/work-audit.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { CommandResult } from "../../src/gate/ports.js";
import type { CandidateRef } from "../../src/judge/candidate.js";
import { type S5Deps, s5Station } from "../../src/judge/s5-station.js";
import { foldSeals } from "../../src/scenario/events.js";
import { listVaultCanaryIndex, setDir } from "../../src/vault/vault.js";
import {
  type Classification,
  type EvidenceInputs,
  classifyOutcome,
  emptyEvidenceInputs,
} from "../../src/work/classify.js";
import type { Station, StationContext } from "../../src/work/sequencer.js";
import { NOW } from "./decision-fixture.js";
import { allStations, boardOf, cleanInputs } from "./evidence-fixture.js";
import { type GitFixture, gitFixture } from "./git-fixture.js";
import { type LineFixture, ROUND2, sealStored, setupLine, writeYaml } from "./line-fixture.js";
import { BUGGY, FIXED, testFile } from "./prove-fixture.js";
import { TempWorkCopyFactory } from "./temp-work-copy.js";
import { makeTempDir } from "./tmp.js";

export const RUN_ID = "r-20261014T000100Z-ab01";

const exited = (status: number): CommandResult => ({ kind: "exited", status, signal: null, stdout: "", stderr: "" });

export interface S5Options {
  /** What the declared gate does: `error` is a runner that could not start it (the line reads it as skipped). */
  gate?: "pass" | "fail" | "error";
  /** Index into the vault's canaries; that canary is written into the head commit, so it is on the diff surface. */
  diffCanary?: number;
  /** Extra files the head commit adds. */
  head?: Record<string, string>;
  explicit?: readonly string[];
}

export interface S5Fixture {
  line: LineFixture;
  git: GitFixture;
  /** Every canary of the sealed set with its scenario. */
  index: CanaryIndexEntry[];
  candidate: CandidateRef;
  /** The state S4 would have left; the station sets `flawed_signal`. */
  round: { round: number; candidate_sha: string; flawed_signal: boolean };
  /** Feedback released so far (the `feedback` surface). */
  released: string[];
  /** The implementer's log (the `implementer_log` surface). */
  implementerLog: { text: string };
  /** Every command the work copies were asked to run, in order. */
  commands: string[][];
  deps: S5Deps;
  station: Station;
  ctx(round?: number): StationContext;
  scope(round?: number): RoundScope;
  events(type: string): LedgerEvent[];
  /** Edits the first scenario's canary in its vault file, so the set no longer matches its seal; returns the new canary. */
  tamper(): string;
}

export async function s5Fixture(options: S5Options = {}): Promise<S5Fixture> {
  const line = setupLine();
  await sealStored(line, writeYaml(line, "round2.yaml", ROUND2));
  const { f } = line;
  const { records } = foldSeals(f.fx.ledger.readVerified(), f.scope);
  const { index } = listVaultCanaryIndex(line.vault, f.workId, records);
  const note = options.diffCanary === undefined ? "" : `// ${index[options.diffCanary]?.canary}\n`;
  const git = gitFixture(
    { "src/calc.mjs": BUGGY },
    {
      "src/calc.mjs": `${FIXED}${note}`,
      "tests/calc.test.mjs": testFile("assert.equal(add(1, 2), 3);"),
      ...options.head,
    },
  );
  const released: string[] = [];
  const implementerLog = { text: "" };
  const commands: string[][] = [];
  const candidate: CandidateRef = {
    quarantine: git.quarantine,
    base: git.base,
    head: git.head,
    explicitTestPaths: options.explicit ?? [],
    surfaces: [
      textSurface("worktree", "a clean working tree"),
      {
        kind: "implementer_log",
        async *read() {
          yield Buffer.from(`log: ${implementerLog.text}`);
        },
      },
      textSurface("prompt", "a clean prompt"),
    ],
  };
  const round = { round: 1, candidate_sha: git.head, flawed_signal: false };
  const gate = options.gate ?? "pass";
  const deps: S5Deps = {
    location: f.fx.location,
    candidates: { current: async () => candidate },
    feedback: { released: () => released },
    round: () => round,
    copies: async () => {
      let calls = 0;
      return new TempWorkCopyFactory({
        parent: makeTempDir("omf-s5-copies-"),
        exec: (root) => ({
          async run(argv) {
            calls += 1;
            commands.push([...argv]);
            if (calls === 1) {
              return gate === "error"
                ? { kind: "error", code: null, message: "scripted" }
                : exited(gate === "pass" ? 0 : 1);
            }
            return exited(readFileSync(join(root, "src/calc.mjs"), "utf8").includes("a + b") ? 0 : 1);
          },
        }),
      });
    },
  };
  const scope = (n = 1): RoundScope => ({ goal_id: f.fx.goalId, work_id: f.workId, run_id: RUN_ID, round: n });
  return {
    line,
    git,
    index,
    candidate,
    round,
    released,
    implementerLog,
    commands,
    deps,
    station: s5Station(deps),
    scope,
    ctx: (n = 1) => ({
      runId: RUN_ID,
      workId: f.workId,
      goalId: f.fx.goalId,
      round: n,
      resumed: false,
      entryState: "ready",
      item: f.item,
      now: () => NOW,
      inputs: emptyEvidenceInputs(),
      recordSpend: () => {},
    }),
    events: (type) => f.fx.ledger.readVerified().filter((event) => event.type === type),
    tamper() {
      const entry = index[0];
      if (entry === undefined) throw new Error("the sealed set has no scenario");
      const file = join(setDir(line.vault, { work_id: f.workId, seal_id: entry.seal_id }), `${entry.scenario_id}.yaml`);
      const forged = `omf-canary-${"f".repeat(32)}`;
      writeFileSync(file, readFileSync(file, "utf8").replace(entry.canary, forged));
      return forged;
    },
  };
}

/**
 * What the real classifier makes of the inputs S5 produced, with every other input clean and run-wide isolation at L2
 * (S5 reads the run's isolation honestly, and it is `unmeasured` until the author and implementer stages exist).
 */
export function classifyS5(inputs: EvidenceInputs): Classification {
  return classifyOutcome({
    stop: { kind: "none" },
    stations: allStations("ok"),
    gates: boardOf("pass").aggregate(),
    inputs: {
      ...cleanInputs(),
      gate_line: inputs.gate_line,
      gate_verdict: inputs.gate_verdict,
      audit: inputs.audit,
      high_risk_paths_touched: inputs.high_risk_paths_touched,
    },
    decisions_unmeasured: [],
    gate4_warnings: [],
    injected_gates: [],
    declared_level: "L2",
  });
}
