import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containerSpecFor } from "../../src/container/golden.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { commitChain } from "../../src/git/ops.js";
import { combineLineEnd } from "../../src/implementer/station.js";
import { MUTATING_VERBS } from "../helpers/fake-docker.js";
import { goodScript, IMPLEMENTER_IMAGE, implementerRig, MODEL, SENTINEL_KEY } from "../helpers/implementer-fixture.js";
import type { ImplementerFailureCode, ImplementerSession, SessionRequest } from "../../src/implementer/session.js";
import { RUN } from "../helpers/judge-seed.js";

describe("S3 station, happy path", () => {
  it("runs the stub implementer, publishes one branch and fills the untrusted inputs", async () => {
    const rig = implementerRig();
    const ctx = rig.ctx();
    const result = await rig.stations.S3.run(ctx);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.progress_digest : null).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.inputs.plan_summary).toContain("Plan: add src/feature.js");
    expect(ctx.inputs.implementer_notes).toBe("stub finished");
    expect(rig.omfRefs()).toEqual([`refs/heads/omf/${rig.workId}`]);
  });

  it("leaves one event of each kind in the ledger, and the measured stage is L2", async () => {
    const rig = implementerRig();
    await rig.stations.S3.run(rig.ctx());
    expect(rig.events("implementer.base_fixed")).toHaveLength(1);
    const [session] = rig.events("implementer.session_completed");
    expect(session?.payload).toMatchObject({
      round: 1,
      vendor: "stub",
      model: null,
      outcome: "completed",
      workspace: "captured",
      log_credential_hits: 0,
      injected_secret_names: ["ANTHROPIC_API_KEY"],
      cost_micro_usd: 1234,
    });
    expect(rig.events("implementer.publish_intended")).toHaveLength(1);
    const [checked] = rig.events("implementer.candidate_checked");
    expect(checked?.payload).toMatchObject({
      round: 1,
      commits: 2,
      plan: "ok",
      request: "none",
      scan: "clean",
      import_failure: null,
      published: true,
    });
    expect(checked?.payload.head_sha).toBe(rig.branch());
    const measured = rig.events("isolation.measured").filter((event) => event.payload.stage === "implementer");
    expect(measured).toHaveLength(1);
    expect(measured[0]?.payload).toMatchObject({ level: "L2", violations: [] });
  });

  it("hands S4 to S6 a candidate whose base is the context commit, through the candidate source", async () => {
    const rig = implementerRig();
    const ctx = rig.ctx();
    await rig.stations.S3.run(ctx);
    const ref = await rig.stations.candidates.current(ctx);
    if (ref === null) throw new Error("the station held no candidate");
    const chain = await commitChain(ref.quarantine, ref.head);
    expect(chain).toHaveLength(4); // base, context, plan, feature
    expect(ref.base).toBe(chain[1]?.sha);
    expect(ref.head).toBe(rig.branch());
    expect(ref.explicitTestPaths).toEqual(["tests/run.sh"]);
    expect(ref.surfaces.map((surface) => surface.kind).sort()).toEqual(["implementer_log", "prompt", "worktree"]);
    expect(await rig.stations.candidates.current(rig.ctx({ round: 2 }))).toBeNull();
    expect(await rig.stations.candidates.current({ ...ctx, runId: "r-20261014T000000Z-ffff" })).toBeNull();
  });

  it("hands the key to the one session exec, and only after the container was measured golden", async () => {
    const rig = implementerRig();
    await rig.stations.S3.run(rig.ctx());
    const withKey = rig.spy.execs.filter((exec) => exec.secret !== null);
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toMatchObject({ secret: "ANTHROPIC_API_KEY", measured: 1 });
    expect(rig.spy.execs[0]?.argv).toEqual([...CONTAINER_PROBE_ARGV]); // the probe ran first, without the key
    expect(rig.spy.execs[0]?.secret).toBeNull();
    expect(JSON.stringify(rig.fake.state.calls)).not.toContain(SENTINEL_KEY);
  });

  it("records the session's cost and passes the model and the remaining budget to it", async () => {
    const rig = implementerRig({ cost: 1234 });
    const { ledger } = rig.s.f.fx;
    const scope = { goal_id: rig.s.f.scope.goal_id, work_id: rig.workId, run_id: RUN };
    ledger.append({
      actor: "omf",
      type: "work.limits_set",
      payload: { ...scope, max_rounds: 3, max_model_micro_usd: 5_000_000 },
    });
    ledger.append({ actor: "omf", type: "work.spend", payload: { ...scope, station: "S3", micro_usd: 1_250_000 } });
    await rig.stations.S3.run(rig.ctx());
    expect(rig.spends).toEqual([1234]);
    expect(rig.requests[0]).toMatchObject({ model: MODEL, maxBudgetUsd: 3.75 });
  });

  it.each(["nonzero_exit", "timeout", "output_limit"] as const satisfies readonly ImplementerFailureCode[])(
    "a session that ends with %s records the budget it was given as its spend, so failing rounds cannot exceed the limit",
    async (code) => {
      const asked: SessionRequest[] = [];
      const rig = implementerRig({
        session: () =>
          ({
            id: "failing",
            vendor: "stub",
            model: null,
            async run(_container, request) {
              asked.push(request);
              return { ok: false, code, log: "", credential_hits: 0, durationMs: 1 };
            },
          }) satisfies ImplementerSession,
      });
      const { ledger } = rig.s.f.fx;
      const scope = { goal_id: rig.s.f.scope.goal_id, work_id: rig.workId, run_id: RUN };
      const LIMIT = 5_000_000;
      ledger.append({
        actor: "omf",
        type: "work.limits_set",
        payload: { ...scope, max_rounds: 3, max_model_micro_usd: LIMIT },
      });
      let recorded = 0;
      for (const round of [1, 2, 3]) {
        await rig.stations.S3.run(
          rig.ctx({
            round,
            recordSpend: (micro) => {
              rig.spends.push(micro);
              recorded += micro ?? 0;
              ledger.append({
                actor: "omf",
                type: "work.spend",
                payload: { ...scope, station: "S3", micro_usd: micro },
              });
            },
          }),
        );
      }
      expect(asked.map((request) => request.maxBudgetUsd)).toEqual([5, 0, 0]);
      expect(rig.spends).toEqual([LIMIT, 0, 0]);
      expect(recorded).toBeLessThanOrEqual(LIMIT);
    },
  );

  it("counts a key in the raw log, writes the log redacted at 0600 and does not stop", async () => {
    const rig = implementerRig({ log: (key) => `env: ANTHROPIC_API_KEY=${key}` });
    const result = await rig.stations.S3.run(rig.ctx());
    expect(result.kind).toBe("ok");
    expect(rig.events("implementer.session_completed")[0]?.payload.log_credential_hits).toBe(1);
    const dir = join(rig.itemDir, "runs", RUN, "implementer", "round-1");
    const log = readFileSync(join(dir, "implementer.log"), "utf8");
    expect(log).toContain("[redacted]");
    expect(log).not.toContain(SENTINEL_KEY);
    for (const name of ["implementer.log", "prompt.txt", "settings.json"]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it.each([0, 1, 2, 3])(
    "cuts an over-long log at a character boundary (padding %i), so the file on disk hashes to the digest in the ledger",
    async (pad) => {
      const LIMIT = 1024 * 1024;
      // A run of four-byte characters: depending on the padding, the cap falls inside one of them.
      const rig = implementerRig({
        implementerToml: `max_log_bytes = ${LIMIT}`,
        log: () => `${"a".repeat(pad)}${"\u{1F600}".repeat(LIMIT / 4 + 10)}`,
      });
      expect((await rig.stations.S3.run(rig.ctx())).kind).toBe("ok");
      const file = readFileSync(join(rig.itemDir, "runs", RUN, "implementer", "round-1", "implementer.log"));
      const [event] = rig.events("implementer.session_completed");
      expect(event?.payload.log_sha256).toBe(createHash("sha256").update(file).digest("hex"));
      expect(event?.payload.log_bytes).toBe(file.length);
      expect(file.length).toBeLessThanOrEqual(LIMIT);
      expect(file.toString("utf8")).not.toContain("\ufffd");
    },
  );

  it("restarts round 2 from the recorded base with the released feedback, never from the first head", async () => {
    const rig = implementerRig({
      script: (workId, session) => goodScript(workId, `round${session}`),
      released: ["masked feedback text"],
    });
    expect((await rig.stations.S3.run(rig.ctx())).kind).toBe("ok");
    const first = rig.branch();
    expect((await rig.stations.S3.run(rig.ctx({ round: 2 }))).kind).toBe("ok");
    const second = rig.branch();
    expect(second).not.toBe(first);
    const ref = await rig.stations.candidates.current(rig.ctx({ round: 2 }));
    if (ref === null) throw new Error("round 2 held no candidate");
    const chain = await commitChain(ref.quarantine, ref.head);
    expect(chain.map((entry) => entry.sha)).not.toContain(first);
    expect(chain).toHaveLength(4);
    expect(rig.events("implementer.base_fixed")).toHaveLength(1);
    expect(rig.requests).toHaveLength(2);
    expect(rig.requests[1]?.prompt).toContain("masked feedback text");
  });

  it("works when the base already tracks other items' .omf files and a root spec.md, intent.md and plan.md", async () => {
    const rig = implementerRig();
    rig.commit({
      ".omf/w-aaaaaaaaaaaa/plan.md": "an older plan\n",
      "spec.md": "# the project's own spec\n",
      "intent.md": "# the project's own intent\n",
      "plan.md": "a root plan\n",
    });
    const ctx = rig.ctx();
    expect((await rig.stations.S3.run(ctx)).kind).toBe("ok");
    expect(ctx.inputs.plan_summary).toContain("Plan: add src/feature.js");
  });
});

describe("S3 station, guards that run before the container", () => {
  it("scans the base tarball for canaries before the first exec, so a committed canary starts nothing", async () => {
    const rig = implementerRig();
    const canary = rig.s.scenarios[0]?.canary ?? "";
    rig.commit({ "docs/notes.md": `see ${canary}\n` });
    // The working tree no longer holds it (so the repository poka-yoke finds nothing), but the base commit still does.
    rmSync(join(rig.repo, "docs", "notes.md"));
    const result = await rig.stations.S3.run(rig.ctx());
    expect(result).toMatchObject({ kind: "blocked", reason_code: "gate_blocked" });
    expect(rig.fake.verbs().filter((verb) => MUTATING_VERBS.has(verb))).toEqual([]);
    expect(rig.omfRefs()).toEqual([]);
  });

  it("sweeps a leftover implementer container and stage directory of an earlier run before it creates its own", async () => {
    const rig = implementerRig();
    const earlier = "r-20261013T000000Z-0001";
    const stage = join(rig.itemDir, "runs", earlier, "implementer-stage", "round-1");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "leftover"), "x");
    const image = await rig.spy.runtime.ensureImage(pinnedImage(IMPLEMENTER_IMAGE));
    const spec = containerSpecFor({
      role: "implementer",
      image: image.id,
      labels: { work_id: rig.workId, run_id: earlier, round: 1 },
      serial: 900,
      limits: { kind: "implementer", implementer: CONFIG_DEFAULTS.implementer },
    });
    await rig.spy.runtime.create(spec);
    const before = rig.fake.state.calls.length;
    await rig.stations.S3.run(rig.ctx());
    expect(Object.keys(rig.fake.state.containers)).not.toContain(spec.name);
    expect(existsSync(stage)).toBe(false);
    const verbs = rig.fake.verbs().slice(before);
    expect(verbs.indexOf("rm")).toBeGreaterThanOrEqual(0);
    expect(verbs.indexOf("rm")).toBeLessThan(verbs.indexOf("create"));
  });
});

describe("line end", () => {
  it("dispose removes a container the station could not remove itself, and is safe to repeat", async () => {
    const rig = implementerRig();
    rig.spy.failRemoves = 1;
    expect((await rig.stations.S3.run(rig.ctx())).kind).toBe("ok");
    expect(Object.keys(rig.fake.state.containers)).toHaveLength(1);
    await rig.stations.dispose();
    await rig.stations.dispose();
    expect(Object.keys(rig.fake.state.containers)).toEqual([]);
  });

  it("combineLineEnd awaits every function in order and drops their errors", async () => {
    const order: string[] = [];
    const end = combineLineEnd(
      async () => {
        order.push("first");
        throw new Error("cleanup failed");
      },
      async () => {
        await Promise.resolve();
        order.push("second");
      },
    );
    await expect(end()).resolves.toBeUndefined();
    expect(order).toEqual(["first", "second"]);
  });
});
