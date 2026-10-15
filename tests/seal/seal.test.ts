import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { runSealStage, sealLockFile } from "../../src/seal/seal.js";
import { readScenarioSet, setDir } from "../../src/vault/vault.js";
import { runChild } from "../helpers/child.js";
import {
  AUTHOR_STUB,
  authoredDoc,
  canaryFor,
  commandAuthor,
  countingSession,
  depsFor,
  sealFixture,
  startWork,
  stored,
} from "../helpers/seal-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

const record = (): string => makeTempDir("omf-rec-");

function sealEvents(s: ReturnType<typeof sealFixture>) {
  return s.f.fx.ledger.readVerified().filter((event) => event.type.startsWith("seal."));
}

describe("runSealStage: success", () => {
  it("writes the set first, then pins it with seal.completed under OMF's own stamp", async () => {
    const s = sealFixture();
    const dir = record();
    const fixture = join(dir, "authored.yaml");
    // The author tries to name its own id, exposure, status and author; OMF drops all four.
    const planted = ["scenario_id: s-evil", "exposure: 99", "status: retired", "author: {vendor: forged}"];
    writeFileSync(fixture, `${authoredDoc({ split: "train", argv: ["zebra-step-text-7"], extra: planted })}\n---\n${authoredDoc({ split: "test" })}\n`);

    const result = stored(await runSealStage(depsFor(s, commandAuthor("print", dir, fixture))));
    expect(result.round).toBe(1);
    expect(result.author).toEqual({ vendor: "command", model: "stub", at: s.now.toISOString(), isolation: "host_command" });
    expect(result.counts).toMatchObject({ authored: 2, stored: 2, behavior: 2, contradiction_canary: 0, train: 1, test: 1 });
    expect(result.counts.ignored_fields).toBeGreaterThanOrEqual(1);

    const ref = { work_id: s.f.workId, seal_id: result.seal_id };
    const read = readScenarioSet(s.vault, ref);
    if (!read.ok) throw new Error(read.reason);
    expect(read.set_sha256).toBe(result.set_sha256);
    for (const scenario of read.scenarios) {
      expect(scenario.author).toEqual(result.author);
      expect(scenario.scenario_id).not.toBe("s-evil");
      expect(scenario).not.toHaveProperty("status");
      expect(scenario).not.toHaveProperty("exposure");
    }

    const events = sealEvents(s);
    expect(events.map((event) => event.type)).toEqual(["seal.requested", "seal.completed"]);
    expect(events[1]?.payload).toMatchObject({
      round: 1,
      seal_id: result.seal_id,
      set_sha256: result.set_sha256,
      author: result.author,
      decisions_digest: events[0]?.payload.decisions_digest,
    });
    expect(existsSync(sealLockFile(s.f.item.dir)), "the lock is released").toBe(false);

    // Scenario text lives in the vault and never in the ledger (M3c-D10). The file is the positive control.
    const train = read.scenarios.find((scenario) => scenario.split === "train");
    if (train === undefined) throw new Error("no train scenario");
    expect(readFileSync(join(setDir(s.vault, ref), `${train.scenario_id}.yaml`), "utf8")).toContain("zebra-step-text-7");
    const ledgerText = readFileSync(s.f.fx.ledger.file, "utf8");
    for (const secret of ["zebra-step-text-7", train.canary, train.scenario_id]) expect(ledgerText).not.toContain(secret);
  });

  it("takes the next round on a re-seal, and the prompt holds decision ids and counts but no scenario", async () => {
    const s = sealFixture();
    const first = stored(await runSealStage(depsFor(s, commandAuthor("from_feedback", record()))));
    const dir = record();
    const feedback = { unlinked_decision_ids: ["d-cache"], weak: 2, contradictions: 0, invalid: 1 };
    const second = stored(await runSealStage(depsFor(s, commandAuthor("from_feedback", dir), { feedback })));
    expect([first.round, second.round]).toEqual([1, 2]);
    expect(second.seal_id).not.toBe(first.seal_id);
    expect(readdirSync(join(s.vault.dir, s.f.workId)).sort()).toEqual([first.seal_id, second.seal_id].sort());

    const prompt = readFileSync(join(dir, "stdin.txt"), "utf8");
    expect(prompt).toContain("- unlinked decision: d-cache");
    expect(prompt).toContain("- weak scenarios: 2");
    for (const n of [1, 2, 3, 4]) expect(prompt).not.toContain(canaryFor(n));
    expect(prompt).not.toContain("the status command reports ok");
    const old = readScenarioSet(s.vault, { work_id: s.f.workId, seal_id: first.seal_id });
    if (!old.ok) throw new Error(old.reason);
    for (const scenario of old.scenarios) expect(prompt).not.toContain(scenario.scenario_id);

    const requested = sealEvents(s).filter((event) => event.type === "seal.requested");
    expect(requested.map((event) => event.payload.feedback)).toEqual([null, { unlinked_decision_count: 1, weak: 2, contradictions: 0, invalid: 1 }]);
  });
});

describe("runSealStage: no set is stored", () => {
  it("a failed author run writes seal.failed and no files, and consumes no round", async () => {
    const s = sealFixture();
    const garbage = join(record(), "garbage.yaml");
    writeFileSync(garbage, "just words\n");
    const runs: Array<[string, string[], string]> = [
      ["exit3", [], "nonzero_exit"],
      ["empty", [], "no_output"],
      ["print", [garbage], "no_valid_scenarios"],
    ];
    for (const [mode, args, code] of runs) {
      expect(await runSealStage(depsFor(s, commandAuthor(mode, record(), ...args))), mode).toEqual({ status: "failed", code });
    }
    expect(sealEvents(s).filter((event) => event.type === "seal.failed").map((event) => event.payload.code)).toEqual(["nonzero_exit", "no_output", "no_valid_scenarios"]);
    expect(readdirSync(s.vault.dir), "nothing was written under the vault").toEqual([]);
    expect(stored(await runSealStage(depsFor(s, commandAuthor("from_feedback", record())))).round).toBe(1);
  });

  it("GATE-1 not passing is blocked_gate1: the author is never called and nothing is appended", async () => {
    const s = sealFixture("open");
    const session = countingSession();
    const before = s.f.fx.ledger.readVerified().length;
    const result = await runSealStage(depsFor(s, session));
    expect(result).toMatchObject({ status: "blocked_gate1", reasons: expect.arrayContaining([{ code: "interface_missing" }]) });
    expect(session.calls).toHaveLength(0);
    expect(s.f.fx.ledger.readVerified()).toHaveLength(before);
  });

  it("after work.started it reuses the seal that preceded it, and refuses when there is none", async () => {
    const withSeal = sealFixture();
    const first = stored(await runSealStage(depsFor(withSeal, commandAuthor("from_feedback", record()))));
    startWork(withSeal);
    const before = withSeal.f.fx.ledger.readVerified().length;
    const session = countingSession();
    const again = await runSealStage(depsFor(withSeal, session));
    expect(again).toMatchObject({ status: "reused", seal: { seal_id: first.seal_id, round: 1 } });
    expect(session.calls).toHaveLength(0);
    expect(withSeal.f.fx.ledger.readVerified()).toHaveLength(before);

    const without = sealFixture();
    startWork(without);
    expect(await runSealStage(depsFor(without, countingSession()))).toEqual({ status: "refused", reason: "implementation_started" });
    expect(sealEvents(without)).toEqual([]);
  });

  it("refuses with seal_in_progress while another run holds the seal lock", async () => {
    const s = sealFixture();
    const session = countingSession();
    acquireLock(sealLockFile(s.f.item.dir));
    try {
      expect(await runSealStage(depsFor(s, session))).toEqual({ status: "refused", reason: "seal_in_progress" });
    } finally {
      releaseLock(sealLockFile(s.f.item.dir));
    }
    expect(session.calls).toHaveLength(0);
    expect(sealEvents(s)).toEqual([]);
  });
});

/** Child: seals the item with a slow stub author, so two children overlap, and prints the result as JSON. */
const SEALER = `
const [dist, repo, workId, omfHome, stub, record] = process.argv.slice(1);
const load = (name) => import(dist + "/" + name);
const { runSealStage } = await load("seal/seal.js");
const { createCommandAuthor } = await load("seal/session.js");
const { resolveProject } = await load("core/paths.js");
const { openVault } = await load("vault/vault.js");
const { findWorkItem } = await load("adapters/state-markdown.js");
const { Ledger } = await load("core/ledger.js");
const { randomIds } = await load("scenario/intake.js");
const env = { ...process.env, OMF_HOME: omfHome };
const location = resolveProject(repo, env);
const result = await runSealStage({
  location,
  item: findWorkItem(location.dir, workId),
  session: createCommandAuthor({ command: [process.execPath, stub, "from_feedback", record, "-", "700"] }),
  ledger: new Ledger(location.dir),
  vault: openVault(location, env),
  now: () => new Date("2026-10-14T00:00:00.000Z"),
  ids: randomIds(),
  env,
});
process.stdout.write(JSON.stringify({ status: result.status, seal_id: result.seal_id ?? null }));
`;

describe("runSealStage: concurrency", () => {
  it("two processes sealing one item never delete or overwrite each other's set", async () => {
    const s = sealFixture();
    const args = (): string[] => [resolve("dist"), s.f.fx.repo, s.f.workId, s.f.fx.env.OMF_HOME ?? "", AUTHOR_STUB, record()];
    const runs = await Promise.all([runChild(SEALER, args()), runChild(SEALER, args())]);
    expect(runs.map((run) => run.code)).toEqual([0, 0]);
    const results = runs.map((run) => JSON.parse(run.out) as { status: string; seal_id: string | null });
    expect(results.every((result) => result.status === "stored" || result.status === "refused")).toBe(true);
    expect(results.some((result) => result.status === "stored")).toBe(true);

    const completed = sealEvents(s).filter((event) => event.type === "seal.completed");
    expect(completed).toHaveLength(results.filter((result) => result.status === "stored").length);
    expect(completed.map((event) => event.payload.round)).toEqual(completed.map((_, index) => index + 1));
    for (const event of completed) {
      const read = readScenarioSet(s.vault, { work_id: s.f.workId, seal_id: String(event.payload.seal_id) });
      if (!read.ok) throw new Error(`a seal.completed names a set that is not there: ${read.reason}`);
      expect(read.set_sha256).toBe(event.payload.set_sha256);
    }
    expect(existsSync(sealLockFile(s.f.item.dir))).toBe(false);
  });
});
