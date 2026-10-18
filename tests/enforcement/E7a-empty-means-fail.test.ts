// covers: S5.0.empty-means-fail
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { goalLockFile } from "../../src/goal/goal-lock.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import { EVIDENCE_JSON, trustedRecommendation } from "../../src/work/evidence.js";
import { GateBoard, type GateStatus, aggregateGates, gate1 } from "../../src/work/gates.js";
import { GATE_IDS, type GateId, NOT_RUN } from "../../src/work/line-types.js";
import {
  type ExecOptions,
  cleanInputs,
  finished,
  injectedGates,
  passGate,
  setupLine,
} from "../helpers/line-enforce.js";

// Spec §5.0 and §11 (E7, first part): an empty result is a failure. A gate that never ran, a gate that
// could not decide, a station that produced nothing and a file nobody wrote must never read as a pass. The
// judge's missing verdict file is the other half of E7 (M3f). Positive controls: the same fixture reaches
// `success` when every gate passes and every input is produced.
describe("E7a-empty-means-fail", () => {
  it.each(GATE_IDS)("%s: never visited, not_run and fail each fail the aggregate; only pass passes", (gate) => {
    const others: Partial<Record<GateId, GateStatus>> = Object.fromEntries(
      GATE_IDS.filter((id) => id !== gate).map((id) => [id, "pass"]),
    );
    expect(aggregateGates({ ...others, [gate]: "pass" }).verdict).toBe("pass");
    for (const status of [undefined, "not_run", "fail"] as const) {
      const aggregate = aggregateGates(status === undefined ? others : { ...others, [gate]: status });
      expect(aggregate.verdict, `${gate} ${String(status)}`).toBe("fail");
      expect(aggregate.failing).toEqual([gate]);
    }
  });

  it("an empty board fails, and a round-1 pass does not survive into round 2", () => {
    expect(new GateBoard().aggregate().verdict).toBe("fail");
    const board = new GateBoard();
    for (const gate of GATE_IDS) board.record({ gate, verdict: "pass", reasons: [] });
    expect(board.aggregate().verdict).toBe("pass");
    board.startRound();
    expect(board.status("GATE-3")).toBe("not_visited");
    expect(board.status("GATE-4")).toBe("not_visited");
    expect(board.aggregate().verdict).toBe("fail");
  });

  it("the default line fails closed: with no seal GATE-2 fails, the loop runs out, GATE-3 is never visited", async () => {
    const line = setupLine();
    const { result, ran } = await line.exec();
    const done = finished(result);
    expect(done).toMatchObject({ outcome: "blocked", reason_code: "gate2_exhausted" });
    expect(done.evidence.recommendation).not.toBe("merge_recommended");
    expect(done.evidence.gates.per_gate).toEqual({
      "GATE-1": "pass",
      "GATE-2": "fail",
      "GATE-3": "not_visited",
      "GATE-4": "fail",
    });
    expect(ran).toEqual(["S1", "S2", "S2", "S2"]);
    expect(line.state()).toBe("ready");
  });

  it("GATE-1 cannot be replaced through LineOptions, and nothing is written when it is tried", async () => {
    const line = setupLine();
    const before = line.events().length;
    await expect(line.exec({ gates: { "GATE-1": passGate("GATE-2") } as never })).rejects.toThrow(TypeError);
    expect(line.events().length).toBe(before);
  });

  it("GATE-1 is not_run, never pass, when the goal lock is missing", async () => {
    const line = setupLine();
    rmSync(goalLockFile(line.location.dir, line.f.fx.goalId));
    const verdict = await gate1().evaluate({
      location: line.location,
      item: line.f.item,
      events: line.events(),
      now: new Date(),
      runId: "r-20261014T000000Z-ab12",
      round: 0,
      resumed: false,
      inputs: emptyEvidenceInputs(),
    });
    expect(verdict).toEqual({ gate: "GATE-1", verdict: "not_run", reasons: ["gate_error"] });
  });

  it("a success through injected gates is human_needed, never merge_recommended (control: it is a success)", async () => {
    const line = setupLine({ maxRounds: 3 });
    const done = finished((await line.exec({ gates: injectedGates() })).result);
    expect(done.outcome).toBe("success");
    expect(done.evidence.recommendation).toBe("human_needed");
    expect(done.evidence.unverified_areas).toContainEqual({ code: "injected_gate", decision_id: null });
    expect(done.disposition).toMatchObject({ action: "submit", recommendation: "human_needed" });
  });

  const EMPTY: [string, ExecOptions, string][] = [
    [
      "a round-2 S5 that writes nothing",
      {
        scripts: {
          S5: (ctx) => {
            if (ctx.round === 1) Object.assign(ctx.inputs, cleanInputs());
            return { kind: "ok" };
          },
          S6: (ctx) => (ctx.round === 1 ? { kind: "rework", progress_digest: "1".repeat(64) } : { kind: "ok" }),
        },
      },
      "evidence_incomplete",
    ],
    [
      "gate_line not run",
      {
        scripts: {
          S5: (ctx) => {
            Object.assign(ctx.inputs, cleanInputs());
            ctx.inputs.gate_line = NOT_RUN;
            return { kind: "ok" };
          },
        },
      },
      "evidence_incomplete",
    ],
    ["a missing S4", { omit: ["S4"] }, "station_skipped"],
    ["a skipped S6", { scripts: { S6: () => ({ kind: "skipped" }) } }, "station_skipped"],
    [
      "an S7 that throws",
      {
        scripts: {
          S7: () => {
            throw new Error("boom");
          },
        },
      },
      "station_error",
    ],
  ];

  it.each(EMPTY)("%s never yields success", async (_name, options, reason) => {
    const line = setupLine({ maxRounds: 3 });
    const done = finished((await line.exec({ ...options, gates: injectedGates() })).result);
    expect(done).toMatchObject({ outcome: "blocked", reason_code: reason });
    expect(done.evidence.recommendation).not.toBe("merge_recommended");
  });

  it("trustedRecommendation takes the recommendation from the ledger and ignores a doctored file", async () => {
    const line = setupLine();
    const done = finished((await line.exec({ gates: injectedGates() })).result);
    expect(done.evidence.recommendation).toBe("human_needed");
    const file = join(line.itemDir, EVIDENCE_JSON);
    const original = readFileSync(file, "utf8");
    const trusted = (): string => {
      const front = createMarkdownStore(line.location.dir).fetchWorkItemsByIds([line.workId])[0]?.front;
      if (front === undefined) throw new Error("the item vanished");
      return trustedRecommendation(line.itemDir, line.events(), front);
    };
    expect(trusted()).toBe("human_needed");

    const doc = JSON.parse(original) as Record<string, unknown>;
    const edits: [string, unknown][] = [
      [
        "recommendation flipped, unverified areas emptied",
        { ...doc, recommendation: "merge_recommended", unverified_areas: [] },
      ],
      ["another run id", { ...doc, run_id: "r-20261014T000000Z-ffff" }],
      ["another outcome", { ...doc, outcome: "blocked" }],
      ["an invalid file", {}],
    ];
    for (const [name, edited] of edits) {
      writeFileSync(file, JSON.stringify(edited));
      expect(trusted(), name).toBe("none");
    }
    rmSync(file);
    expect(trusted(), "a missing file").toBe("none");
    writeFileSync(file, original);
    expect(trusted(), "control: the real file again").toBe("human_needed");
  });
});
