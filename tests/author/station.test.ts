import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { standingSeal } from "../../src/author/standing.js";
import { type AuthorRefusalCode, type SealItemDeps, sealItem, standingSealStation } from "../../src/author/station.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { loadRunIsolation } from "../../src/isolation/record.js";
import { sealLockFile } from "../../src/seal/seal.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import type { StationContext } from "../../src/work/sequencer.js";
import {
  AUTHOR_KEY,
  type AuthorConfigOptions,
  type ScriptedAuthor,
  scriptedAuthor,
  withOverrides,
  writeAuthorConfig,
} from "../helpers/author-session.js";
import { NOW, addOpen, resolveOpen } from "../helpers/decision-fixture.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { type LineFixture, ROUND1, ROUND2, setupLine, writeYaml } from "../helpers/line-fixture.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";

const EARLIER = "r-20261001T090000Z-aaaa";
const OTHER_ITEM = "r-20261002T090000Z-cccc";

function rig(config: AuthorConfigOptions = {}, lineOptions: { decisions?: boolean } = {}) {
  const l = setupLine(lineOptions);
  writeAuthorConfig(l, config);
  const yaml = writeYaml(l, "round2.yaml", ROUND2);
  const runtime = new MemoryRuntime();
  const deps = (over: Partial<SealItemDeps> = {}): SealItemDeps => ({
    location: l.f.fx.location,
    workId: l.f.workId,
    runtime,
    env: { OMF_AUTHOR_API_KEY: AUTHOR_KEY },
    now: () => NOW,
    session: (_credential, passId) => scriptedAuthor(l, yaml, passId),
    ...over,
  });
  return { l, yaml, runtime, deps };
}

const authorEvents = (l: LineFixture) =>
  ledgerEvents(l.f.fx, "isolation.measured").filter((event) => event.payload.stage === "author");
const passDirs = (l: LineFixture): string[] => {
  const runs = join(l.f.item.dir, "runs");
  return existsSync(runs) ? readdirSync(runs) : [];
};

describe("sealItem", () => {
  it("seals: the measurement is bound to the stored seal and the run isolation reads the author stage", async () => {
    const { l, deps } = rig();
    const result = await sealItem(deps());
    expect(result).toMatchObject({ status: "sealed", round: 1, author_measured: true, gate2: "pass" });
    const events = ledgerEvents(l.f.fx);
    const seal = events.find((event) => event.type === "seal.completed");
    const measured = authorEvents(l);
    expect(measured).toHaveLength(1);
    expect(measured[0]?.payload.author_scope).toEqual({ seal_seq: seal?.seq, set_sha256: seal?.payload.set_sha256 });
    expect(measured[0]?.seq).toBeGreaterThan(seal?.seq ?? Number.POSITIVE_INFINITY);
    const passId = String(measured[0]?.payload.run_id);
    expect(loadRunIsolation(l.f.item.dir, { ...l.f.scope, run_id: passId }, events).stages.author?.level).toBe("L2");
    expect(passDirs(l)).toEqual([passId]);
    expect(events.filter((event) => event.type === "author.session_completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(AUTHOR_KEY);
  });

  it("is idempotent: a standing seal with a measured author answers already_sealed with no key, no daemon and no event", async () => {
    const { l, runtime, deps } = rig();
    let infoCalls = 0;
    const counting = withOverrides(runtime, {
      info: async () => {
        infoCalls += 1;
        return { ok: true, server_version: "memory" };
      },
    });
    const first = await sealItem(deps({ runtime: counting }));
    const before = ledgerEvents(l.f.fx).length;
    const again = await sealItem(
      deps({
        runtime: counting,
        env: {},
        session: () => {
          throw new Error("no session may start");
        },
      }),
    );
    expect(first.status).toBe("sealed");
    expect(again).toMatchObject({ status: "already_sealed", author_measured: true });
    expect(infoCalls).toBe(1);
    expect(ledgerEvents(l.f.fx)).toHaveLength(before);
  });

  it("stops at J7 when the container is not golden: seal.failed, the violations in the event, no scenario, no measurement", async () => {
    const { l, yaml, deps } = rig();
    const result = await sealItem(
      deps({
        session: (_credential, passId) =>
          scriptedAuthor(l, yaml, passId, { failure: "not_golden", violations: ["privileged"] }),
      }),
    );
    expect(result).toEqual({ status: "blocked", route: "J7", code: "not_golden" });
    expect(ledgerEvents(l.f.fx, "seal.completed")).toHaveLength(0);
    expect(ledgerEvents(l.f.fx, "seal.failed")).toHaveLength(1);
    expect(authorEvents(l)).toHaveLength(0);
    expect(ledgerEvents(l.f.fx, "author.session_completed")[0]?.payload).toMatchObject({
      outcome: "not_golden",
      violation_codes: ["privileged"],
    });
  });

  it("refuses with author_call_cap once the item has used its calls, with no new container and no new event", async () => {
    const { l, deps } = rig({ authorLines: ["max_calls = 1"] });
    const first = await sealItem(
      deps({
        session: (_credential, passId) =>
          scriptedAuthor(l, writeYaml(l, "x.yaml", ROUND2), passId, { failure: "no_output" }),
      }),
    );
    expect(first).toEqual({ status: "retry", code: "no_output" });
    const recorded = ledgerEvents(l.f.fx, "author.session_completed");
    expect(recorded).toHaveLength(1);
    const second = await sealItem(deps());
    expect(second).toEqual({ status: "refused", code: "author_call_cap" });
    expect(ledgerEvents(l.f.fx, "author.session_completed")).toHaveLength(1);
  });

  it("does not spend a call on a pass that GATE-1 refuses: the model never ran", async () => {
    const { l, deps } = rig({ authorLines: ["max_calls = 2"] });
    addOpen(l.f, "d-extra", "compatibility");
    let runs = 0;
    const counting = (): SealItemDeps =>
      deps({
        session: (_credential, passId) => {
          const inner = scriptedAuthor(l, writeYaml(l, "x.yaml", ROUND2), passId);
          return {
            ...inner,
            run: async (request) => {
              runs += 1;
              return inner.run(request);
            },
          };
        },
      });
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await sealItem(counting())).toEqual({ status: "blocked", route: "J2", code: "gate1_not_passing" });
    }
    expect(runs).toBe(0);
    expect(ledgerEvents(l.f.fx, "author.session_started")).toHaveLength(0);
    expect(ledgerEvents(l.f.fx, "author.session_completed")).toHaveLength(0);
    expect(passDirs(l)).toEqual([]);
    resolveOpen(l.f, "d-extra");
    // The extra decision is not linked by the scenarios, so GATE-2 sends the pass back; the model did run.
    expect(await sealItem(counting())).toEqual({ status: "retry", code: "gate2_back_to_s2" });
    expect(ledgerEvents(l.f.fx, "author.session_started")).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it("counts a pass killed after its start record: the next pass is refused at the cap", async () => {
    const { l, deps } = rig({ authorLines: ["max_calls = 1"] });
    await expect(
      sealItem(
        deps({
          session: () => ({
            ...scriptedAuthor(l, writeYaml(l, "x.yaml", ROUND2), "unused"),
            run: async () => {
              throw new Error("host killed before the call finished");
            },
          }),
        }),
      ),
    ).rejects.toThrow(/host killed/);
    expect(ledgerEvents(l.f.fx, "author.session_completed")).toHaveLength(0);
    expect(ledgerEvents(l.f.fx, "author.session_started")).toHaveLength(1);
    let ran = 0;
    const second = await sealItem(
      deps({
        session: (_credential, passId) => ({
          ...scriptedAuthor(l, writeYaml(l, "y.yaml", ROUND2), passId),
          run: async () => {
            ran += 1;
            throw new Error("no model run may start");
          },
        }),
      }),
    );
    expect(second).toEqual({ status: "refused", code: "author_call_cap" });
    expect(ran).toBe(0);
    expect(ledgerEvents(l.f.fx, "author.session_started")).toHaveLength(1);
  });

  it("sweeps the orphan of a killed pass even when the next seal is refused at the cap", async () => {
    const { l, runtime, deps } = rig({ authorLines: ["max_calls = 1"] });
    await expect(
      sealItem(
        deps({
          session: () => ({
            ...scriptedAuthor(l, writeYaml(l, "x.yaml", ROUND2), "unused"),
            run: async () => {
              throw new Error("host killed before the call finished");
            },
          }),
        }),
      ),
    ).rejects.toThrow(/host killed/);
    const killed = String(ledgerEvents(l.f.fx, "author.session_started")[0]?.payload.pass_id);
    runtime.owned = [{ kind: "container", name: `omf-author-${killed}-1-1`, run_id: killed }];
    expect(await sealItem(deps())).toEqual({ status: "refused", code: "author_call_cap" });
    expect(runtime.owned).toEqual([]);
  });

  it("lets only the pass that took the last call run, when another pass checked the ledger before it was written", async () => {
    const { l, yaml, runtime, deps } = rig({ authorLines: ["max_calls = 1"] });
    let runs = 0;
    const counted = (passId: string) => {
      const inner = scriptedAuthor(l, yaml, passId);
      return {
        ...inner,
        run: async (request: Parameters<typeof inner.run>[0]) => {
          runs += 1;
          return inner.run(request);
        },
      };
    };
    let startedA = (): void => undefined;
    const aStarted = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const a = sealItem(
      deps({
        session: (_credential, passId) => {
          startedA();
          return counted(passId);
        },
      }),
    );
    // B reads the ledger before A wrote anything, then waits until A is through and has released seal.lock.
    const b = sealItem(
      deps({
        runtime: withOverrides(runtime, {
          info: async () => {
            await aStarted;
            await a;
            return { ok: true, server_version: "memory" };
          },
        }),
        session: (_credential, passId) => counted(passId),
      }),
    );
    expect(await a).toMatchObject({ status: "sealed" });
    expect(await b).toEqual({ status: "refused", code: "author_call_cap" });
    expect(runs).toBe(1);
    expect(ledgerEvents(l.f.fx, "author.session_started")).toHaveLength(1);
  });

  it("counts one call per pass, however many events the pass left", async () => {
    const { l, deps } = rig({ authorLines: ["max_calls = 1"] });
    const first = await sealItem(
      deps({
        session: (_credential, passId) =>
          scriptedAuthor(l, writeYaml(l, "x.yaml", ROUND2), passId, { failure: "no_output" }),
      }),
    );
    expect(first).toEqual({ status: "retry", code: "no_output" });
    // One started and one completed event share the pass id: still one call.
    expect(ledgerEvents(l.f.fx, "author.session_started")).toHaveLength(1);
    expect(ledgerEvents(l.f.fx, "author.session_completed")).toHaveLength(1);
    expect(await sealItem(deps())).toEqual({ status: "refused", code: "author_call_cap" });
  });

  it("answers retry for an author-quality failure and for a GATE-2 back_to_S2", async () => {
    const { l, deps } = rig();
    const failed = await sealItem(
      deps({
        session: (_credential, passId) =>
          scriptedAuthor(l, writeYaml(l, "x.yaml", ROUND2), passId, { failure: "no_output" }),
      }),
    );
    expect(failed).toEqual({ status: "retry", code: "no_output" });
    const weak = writeYaml(l, "round1.yaml", ROUND1);
    const back = await sealItem(deps({ session: (_credential, passId) => scriptedAuthor(l, weak, passId) }));
    expect(back).toEqual({ status: "retry", code: "gate2_back_to_s2" });
    expect(standingSeal(ledgerEvents(l.f.fx), l.f.scope, l.f.item.dir, l.vault)).toBeNull();
  });

  it("leaves the seal stored, not sealed, when no measurement reaches the ledger, and a rerun reseals it", async () => {
    const { l, yaml, deps } = rig();
    const first = await sealItem(
      deps({ session: (_credential, passId) => scriptedAuthor(l, yaml, passId, { measurement: null }) }),
    );
    expect(first).toMatchObject({ status: "stored", round: 1, author_measured: false, gate2: "pass" });
    const unmeasured = loadRunIsolation(
      l.f.item.dir,
      { ...l.f.scope, run_id: "r-20261014T000000Z-0001" },
      ledgerEvents(l.f.fx),
    );
    expect(unmeasured.stages.author).toBeNull();
    const second = await sealItem(deps());
    expect(second).toMatchObject({ status: "sealed", round: 2, author_measured: true });
    expect(ledgerEvents(l.f.fx, "seal.completed")).toHaveLength(2);
    expect(standingSeal(ledgerEvents(l.f.fx), l.f.scope, l.f.item.dir, l.vault)).toMatchObject({
      author_measured: true,
    });
  });

  const cases: Array<{
    code: AuthorRefusalCode;
    config?: AuthorConfigOptions;
    env?: NodeJS.ProcessEnv;
    runtime?: ContainerRuntime;
  }> = [
    { code: "same_vendor", config: { roles: "same_vendor" } },
    { code: "author_vendor_unsupported", config: { roles: "swapped" } },
    { code: "docker_context_unset", config: { context: null } },
    { code: "author_image_unset", config: { image: null } },
    { code: "author_key_missing", env: {} },
    {
      code: "docker_unreachable",
      runtime: withOverrides(new MemoryRuntime(), {
        info: async () => ({ ok: false, failure: "Cannot connect to the Docker daemon" }),
      }),
    },
    {
      code: "endpoint_not_local",
      runtime: withOverrides(new MemoryRuntime(), { endpoint: async () => ({ kind: "tcp", local: false }) }),
    },
  ];

  it.each(cases)("refuses with $code and writes nothing", async ({ code, config, env, runtime }) => {
    const r = rig(config);
    const before = ledgerEvents(r.l.f.fx).length;
    let sessions = 0;
    const result = await sealItem(
      r.deps({
        ...(env === undefined ? {} : { env }),
        ...(runtime === undefined ? {} : { runtime }),
        session: () => {
          sessions += 1;
          throw new Error("no session may start");
        },
      }),
    );
    expect(result).toEqual({ status: "refused", code });
    expect(ledgerEvents(r.l.f.fx)).toHaveLength(before);
    expect(passDirs(r.l)).toEqual([]);
    expect(sessions).toBe(0);
  });

  it("sweeps author containers of earlier passes of this item, and nothing else", async () => {
    const r = rig();
    mkdirSync(join(r.l.f.item.dir, "runs", EARLIER), { recursive: true });
    r.runtime.owned = [
      { kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "container", name: `omf-implementer-${EARLIER}-1-2`, run_id: EARLIER },
      { kind: "container", name: `omf-sut-${EARLIER}-1-3`, run_id: EARLIER },
      { kind: "container", name: `omf-author-${OTHER_ITEM}-1-1`, run_id: OTHER_ITEM },
    ];
    expect((await sealItem(r.deps())).status).toBe("sealed");
    expect(r.runtime.owned.map((resource) => resource.name).sort()).toEqual(
      [`omf-author-${OTHER_ITEM}-1-1`, `omf-implementer-${EARLIER}-1-2`, `omf-sut-${EARLIER}-1-3`].sort(),
    );
  });

  it("stops at J7 and sweeps nothing while another seal pass holds seal.lock", async () => {
    const r = rig();
    mkdirSync(join(r.l.f.item.dir, "runs", EARLIER), { recursive: true });
    r.runtime.owned = [{ kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER }];
    const lock = sealLockFile(r.l.f.item.dir);
    acquireLock(lock);
    try {
      expect(await sealItem(r.deps())).toEqual({ status: "blocked", route: "J7", code: "seal_in_progress" });
    } finally {
      releaseLock(lock);
    }
    expect(r.runtime.owned).toHaveLength(1);
  });

  it("gives the session neither the vault path, the repository nor the state root", async () => {
    const r = rig();
    let seen: ScriptedAuthor | null = null;
    await sealItem(
      r.deps({
        session: (_credential, passId) => {
          seen = scriptedAuthor(r.l, r.yaml, passId);
          return seen;
        },
      }),
    );
    const text = JSON.stringify((seen as ScriptedAuthor | null)?.requests ?? []);
    expect(text.length).toBeGreaterThan(2);
    for (const secret of [r.l.f.fx.location.dir, r.l.f.fx.repo, dirname(dirname(r.l.f.fx.location.dir))]) {
      expect(text).not.toContain(secret);
    }
  });
});

function ctxFor(l: LineFixture, entryState: "ready" | "in_progress" = "ready"): StationContext {
  return {
    runId: "r-20261014T000000Z-0001",
    workId: l.f.workId,
    goalId: l.f.scope.goal_id,
    round: 0,
    resumed: false,
    entryState,
    item: l.f.item,
    now: () => NOW,
    inputs: emptyEvidenceInputs(),
    recordSpend: () => {},
  };
}

describe("standingSealStation", () => {
  it("answers ok with the set digest of the standing seal and needs no author", async () => {
    const r = rig();
    await sealItem(r.deps());
    const sealed = ledgerEvents(r.l.f.fx, "seal.completed")[0];
    const station = standingSealStation(r.l.f.fx.location);
    expect(station.id).toBe("S2");
    expect(await station.run(ctxFor(r.l))).toEqual({ kind: "ok", progress_digest: sealed?.payload.set_sha256 });
  });

  it("blocks with scenarios_need_review when GATE-1 passes but no seal stands", async () => {
    const r = rig();
    expect(await standingSealStation(r.l.f.fx.location).run(ctxFor(r.l))).toEqual({
      kind: "blocked",
      reason_code: "scenarios_need_review",
    });
    expect(ledgerEvents(r.l.f.fx, "seal.requested")).toHaveLength(0);
  });

  it("blocks with j2_open when a ready item's GATE-1 is not passing", async () => {
    const r = rig({}, { decisions: false });
    expect(await standingSealStation(r.l.f.fx.location).run(ctxFor(r.l))).toEqual({
      kind: "blocked",
      reason_code: "j2_open",
    });
  });
});
