import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditPath, loadAudit } from "../../src/audit/work-audit.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { WorkCopyError } from "../../src/container/work-copy.js";
import { GateInfrastructureError } from "../../src/gate/run-gates.js";
import { judgeStations } from "../../src/judge/stations.js";
import { WorkCopiesError } from "../../src/judge/work-copies.js";
import { RUN_ID, type S5Fixture, classifyS5, s5Fixture } from "../helpers/s5-fixture.js";

const SHA256 = /^[0-9a-f]{64}$/;

describe("S5 audit station", () => {
  it("runs the declared gate in a work copy, audits the quarantine diff and fills the round's inputs", async () => {
    const fx = await s5Fixture();
    const ctx = fx.ctx();
    const result = await fx.station.run(ctx);

    expect(result).toMatchObject({ kind: "ok" });
    expect((result as { progress_digest: string }).progress_digest).toMatch(SHA256);
    // The gate once, then prove-test twice (head, and head with the change reverted): all of it ran in the copies.
    expect(fx.commands).toEqual([
      ["npm", "test"],
      ["npm", "test"],
      ["npm", "test"],
    ]);
    expect(ctx.inputs.gate_line).toBe("OMF_GATES: fast=pass full=skip deep=skip");
    expect(ctx.inputs.gate_verdict).toBe("GREEN");
    expect(ctx.inputs.audit).toEqual({
      canary_hits: 0,
      tests_edited: false,
      prove_test: "pass",
      judge_config_touched: false,
    });
    expect(ctx.inputs.high_risk_paths_touched).toEqual([]);
    expect(ctx.inputs.isolation_level).toBe("unmeasured");
    expect(fx.round.flawed_signal).toBe(false);

    expect(fx.events("gates.evaluated").map((e) => e.payload)).toEqual([
      expect.objectContaining({ run_id: RUN_ID, round: 1, status: "GREEN" }),
    ]);
    expect(fx.events("audit.completed").map((e) => e.payload)).toEqual([
      expect.objectContaining({ run_id: RUN_ID, round: 1, head_sha: fx.git.head, prove_status: "PROVEN" }),
    ]);
    const events = fx.line.f.fx.ledger.readVerified();
    expect(loadAudit(ctx.item.dir, fx.scope(), events)).not.toBeNull();
    expect(existsSync(auditPath(ctx.item.dir, RUN_ID, 1))).toBe(true);
  });

  it("takes the item's own context files as the projections, and a root spec.md as an ordinary file", async () => {
    const fx = await s5Fixture({
      head: (workId) => ({
        [`.omf/${workId}/spec.md`]: "x\n",
        [`.omf/${workId}/intent.md`]: "x\n",
        "spec.md": "y\n",
      }),
    });
    expect(await fx.station.run(fx.ctx())).toMatchObject({ kind: "ok" });
    expect(fx.events("audit.completed")[0]?.payload.projections_touched).toBe(2);
  });

  it("reads the diff from the quarantine and the released feedback from the slot", async () => {
    const fx = await s5Fixture({ diffCanary: 0 });
    // The worktree surface is clean text: the only way to see this canary on a diff is the quarantine commit.
    fx.released.push(`released ${fx.index[1]?.canary}`);
    const ctx = fx.ctx();
    await fx.station.run(ctx);

    const report = loadAudit(ctx.item.dir, fx.scope(), fx.line.f.fx.ledger.readVerified());
    expect(report?.canary).toMatchObject({
      status: "scanned",
      total: 2,
      hits: [
        { surface: "diff", count: 1 },
        { surface: "feedback", count: 1 },
      ],
    });
    expect(ctx.inputs.audit.canary_hits).toBe(2);
    expect(fx.round.flawed_signal).toBe(true);
  });

  it.each([
    { gate: "fail", verdict: "RED", rule: "gates_failed" },
    { gate: "error", verdict: "MISCONFIGURED", rule: "gates_misconfigured" },
  ] as const)("a $verdict line is recorded as an input, flags the round and classifies as $rule", async (t) => {
    const fx = await s5Fixture({ gate: t.gate });
    const ctx = fx.ctx();
    expect(await fx.station.run(ctx)).toMatchObject({ kind: "ok" });

    expect(ctx.inputs.gate_verdict).toBe(t.verdict);
    expect(fx.events("gates.evaluated")[0]?.payload).toMatchObject({ status: t.verdict });
    expect(fx.round.flawed_signal).toBe(true);
    expect(classifyS5(ctx.inputs).rule).toBe(t.rule);
  });

  const fails = (error: Error) => async () => {
    throw error;
  };
  const STOPS: { name: string; arrange: (fx: S5Fixture) => void; reason: string }[] = [
    {
      name: "S4 left no round state",
      arrange: (fx) => Object.assign(fx.deps, { round: () => null }),
      reason: "station_error",
    },
    {
      name: "the head is not the judged commit",
      arrange: (fx) => Object.assign(fx.round, { candidate_sha: "0".repeat(40) }),
      reason: "gate_blocked",
    },
    {
      name: "S3 produced no candidate",
      arrange: (fx) => Object.assign(fx.deps, { candidates: { current: async () => null } }),
      reason: "infra_failure",
    },
    {
      name: "the declared build fails",
      arrange: (fx) => Object.assign(fx.deps, { copies: fails(new WorkCopyError("build_failed")) }),
      reason: "infra_failure",
    },
    {
      name: "a container is not golden",
      arrange: (fx) => Object.assign(fx.deps, { copies: fails(new WorkCopyError("not_golden")) }),
      reason: "gate_blocked",
    },
    {
      name: "a gate's container is lost",
      arrange: (fx) =>
        Object.assign(fx.deps, {
          steps: {
            runGates: async () => {
              throw new GateInfrastructureError("full", "workcopy_container_gone");
            },
          },
        }),
      reason: "infra_failure",
    },
    {
      name: "no base image is configured",
      arrange: (fx) => Object.assign(fx.deps, { copies: fails(new WorkCopiesError("image_not_configured")) }),
      reason: "infra_failure",
    },
    {
      name: "the goal lock is unreadable",
      arrange: (fx) => Object.assign(fx.deps, { watchedGlobs: () => null }),
      reason: "gate_blocked",
    },
  ];

  it.each(STOPS)("blocks with a closed code and records nothing when $name", async (t) => {
    const fx = await s5Fixture();
    t.arrange(fx);
    const ctx = fx.ctx();
    expect(await fx.station.run(ctx)).toEqual({ kind: "blocked", reason_code: t.reason });
    expect(fx.events("gates.evaluated")).toHaveLength(0);
    expect(fx.events("audit.completed")).toHaveLength(0);
    expect(ctx.inputs.gate_line).toBe("not run");
    expect(fx.round.flawed_signal).toBe(false);
  });

  it("is the S5 of judgeStations, which refuses to run before S4 has built the round", async () => {
    const fx = await s5Fixture();
    // Any runtime call would fail the test: the stop comes before a container is touched.
    const runtime = new Proxy({} as ContainerRuntime, {
      get: (_target, prop) =>
        prop === "context"
          ? null
          : () => {
              throw new Error(`unexpected runtime call: ${String(prop)}`);
            },
    });
    const stations = judgeStations({
      location: fx.line.f.fx.location,
      runtime,
      candidates: fx.deps.candidates,
      feedback: { put: () => {}, take: () => null, released: () => [] },
    });
    expect(stations.S5.id).toBe("S5");
    expect(await stations.S5.run(fx.ctx())).toEqual({ kind: "blocked", reason_code: "station_error" });
  });
});
