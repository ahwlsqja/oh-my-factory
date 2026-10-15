import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scenarioRef } from "../../src/scenario/types.js";
import type { ScenarioStatus, StoredScenario } from "../../src/scenario/types.js";
import { MAX_SCENARIO_BYTES, MAX_SCENARIOS_PER_SET } from "../../src/scenario/types.js";
import {
  VaultError,
  listVaultCanaries,
  readScenarioSet,
  setDir,
  setSha256,
  splitDigest,
  writeScenarioSet,
} from "../../src/vault/vault.js";
import type { SetRef } from "../../src/vault/vault.js";
import { OTHER_WORK_ID, WORK_ID, digest, hex, sealId, sealRecord, storedScenario } from "../helpers/stored-scenario.js";
import { setupVault } from "../helpers/vault-project.js";

const refOf = (n: number, work_id = WORK_ID): SetRef => ({ work_id, seal_id: sealId(n) });

function vaultCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof VaultError ? err.code : "not a VaultError";
  }
  return undefined;
}

describe("writeScenarioSet", () => {
  it("writes a set named by seal_id at 0700 and 0600 and never overwrites it", () => {
    const v = setupVault();
    const set = [storedScenario(1), storedScenario(2, { split: "test" })];
    const { set_sha256 } = writeScenarioSet(v.vault, refOf(1), set);

    const dir = setDir(v.vault, refOf(1));
    expect(dir).toBe(join(v.vault.dir, WORK_ID, sealId(1)));
    expect(readdirSync(dir).sort()).toEqual(set.map((s) => `${s.scenario_id}.yaml`));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${set[0]!.scenario_id}.yaml`)).mode & 0o777).toBe(0o600);
    expect(readScenarioSet(v.vault, refOf(1))).toEqual({ ok: true, scenarios: set, set_sha256 });
    expect(set_sha256).toBe(setSha256(set));

    const before = readFileSync(join(dir, `${set[0]!.scenario_id}.yaml`), "utf8");
    expect(vaultCode(() => writeScenarioSet(v.vault, refOf(1), [storedScenario(3)]))).toBe("set_exists");
    expect(readdirSync(dir)).toHaveLength(2);
    expect(readFileSync(join(dir, `${set[0]!.scenario_id}.yaml`), "utf8")).toBe(before);

    writeScenarioSet(v.vault, refOf(2), [storedScenario(3)]);
    expect(readdirSync(join(v.vault.dir, WORK_ID)).sort(), "a second seal is a second directory").toEqual([sealId(1), sealId(2)]);
  });

  it("keeps a tricky stdin byte for byte through the file", () => {
    const v = setupVault();
    const base = storedScenario(1);
    const stdin = "a: b\n# not a comment\n  trailing  \ntrue\n";
    const scenario = { ...base, steps: [{ ...base.steps[0]!, invoke: { argv: ["x"], stdin } }] };
    writeScenarioSet(v.vault, refOf(1), [scenario]);
    const read = readScenarioSet(v.vault, refOf(1));
    expect(read.ok && read.scenarios[0]!.steps[0]!.invoke.stdin).toBe(stdin);
  });

  it.each([
    ["a scenario of another work item", [storedScenario(1, { work_id: OTHER_WORK_ID })], "invalid_scenario"],
    ["a repeated scenario id", [storedScenario(1), storedScenario(1)], "invalid_scenario"],
    ["a kind the schema refuses", [storedScenario(1, { kind: "nfr" as unknown as StoredScenario["kind"] })], "invalid_scenario"],
    [
      "more scenarios than a set may hold",
      Array.from({ length: MAX_SCENARIOS_PER_SET + 1 }, (_, i) => storedScenario(i + 1)),
      "too_many",
    ],
  ])("refuses %s and writes nothing", (_name, set, code) => {
    const v = setupVault();
    expect(vaultCode(() => writeScenarioSet(v.vault, refOf(1), set))).toBe(code);
    expect(readdirSync(v.vault.dir), "not even the work directory").toEqual([]);
  });
});

describe("set digests", () => {
  it("setSha256 is stable across file and key order and changes with any field", () => {
    const a = storedScenario(1);
    const b = storedScenario(2);
    const reversedKeys = Object.fromEntries(Object.entries(a).reverse()) as unknown as StoredScenario;
    expect(setSha256([b, a])).toBe(setSha256([a, b]));
    expect(setSha256([reversedKeys, b])).toBe(setSha256([a, b]));
    const edits: StoredScenario[] = [
      { ...a, split: "test" },
      { ...a, decision_refs: ["d-other"] },
      { ...a, author: { ...a.author, model: "other" } },
      { ...a, steps: [{ ...a.steps[0]!, expect: { ...a.steps[0]!.expect, exit_code: 1 } }] },
    ];
    for (const edited of edits) expect(setSha256([edited, b])).not.toBe(setSha256([a, b]));
  });

  it("splitDigest changes on retire, contaminate and edit, and is stable otherwise", () => {
    const train = storedScenario(1);
    const test = storedScenario(2, { split: "test" });
    const canary = storedScenario(3, { kind: "contradiction_canary", decision_refs: [] });
    const all = [train, test, canary];
    const none = new Map<string, ScenarioStatus>();
    const base = splitDigest(all, none, "train");

    expect(splitDigest([canary, test, train], none, "train")).toBe(base);
    expect(base).not.toBe(splitDigest(all, none, "test"));
    expect(splitDigest([train, { ...test, canary: `omf-canary-${hex(9, 32)}` }, canary], none, "train"), "the other split is not part of it").toBe(base);

    const retired = new Map<string, ScenarioStatus>([[scenarioRef(train.scenario_id), "retired"]]);
    const contaminated = new Map<string, ScenarioStatus>([[scenarioRef(canary.scenario_id), "contaminated"]]);
    expect(splitDigest(all, retired, "train")).not.toBe(base);
    expect(splitDigest(all, contaminated, "train")).not.toBe(base);
    expect(splitDigest(all, retired, "test"), "a train retirement leaves the test digest alone").toBe(splitDigest(all, none, "test"));

    const edited = { ...train, steps: [{ ...train.steps[0]!, invoke: { argv: ["add", "other"], stdin: "" } }] };
    expect(splitDigest([edited, test, canary], none, "train")).not.toBe(base);
  });
});

describe("readScenarioSet", () => {
  /** A written set of two scenarios and the path of its first file. */
  function sealed() {
    const v = setupVault();
    const set = [storedScenario(1), storedScenario(2, { split: "test" })];
    writeScenarioSet(v.vault, refOf(1), set);
    const dir = setDir(v.vault, refOf(1));
    return { v, set, dir, file: join(dir, `${set[0]!.scenario_id}.yaml`) };
  }

  it("says set_missing for a seal that was never written", () => {
    const { v } = sealed();
    expect(readScenarioSet(v.vault, refOf(9))).toEqual({ ok: false, reason: "set_missing" });
    expect(readScenarioSet(v.vault, { work_id: "../x", seal_id: sealId(1) }), "an id that is not an id names no set").toEqual({
      ok: false,
      reason: "set_missing",
    });
  });

  it.each([
    ["a stray file", ({ dir }: ReturnType<typeof sealed>) => writeFileSync(join(dir, "notes.txt"), "x"), "extra_entry"],
    [
      "a directory named like a scenario file",
      ({ dir }: ReturnType<typeof sealed>) => mkdirSync(join(dir, `s-${hex(9, 32)}.yaml`)),
      "extra_entry",
    ],
    [
      "a file renamed to another scenario id",
      ({ dir, file }: ReturnType<typeof sealed>) => renameSync(file, join(dir, `s-${hex(9, 32)}.yaml`)),
      "name_mismatch",
    ],
    ["yaml that does not parse", ({ file }: ReturnType<typeof sealed>) => writeFileSync(file, "not: [valid"), "invalid_scenario"],
    [
      "a kind the schema refuses",
      ({ file }: ReturnType<typeof sealed>) => writeFileSync(file, readFileSync(file, "utf8").replace("kind: behavior", "kind: nfr")),
      "invalid_scenario",
    ],
    [
      "a status written into the file",
      ({ file }: ReturnType<typeof sealed>) => writeFileSync(file, `${readFileSync(file, "utf8")}status: retired\n`),
      "invalid_scenario",
    ],
    ["bytes that are not utf-8", ({ file }: ReturnType<typeof sealed>) => writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00])), "invalid_scenario"],
    [
      "a file over the size limit",
      ({ file }: ReturnType<typeof sealed>) => writeFileSync(file, "x".repeat(MAX_SCENARIO_BYTES * 2 + 1)),
      "unreadable",
    ],
  ])("returns a reason, never throws, for %s", (_name, damage, reason) => {
    const s = sealed();
    damage(s);
    expect(readScenarioSet(s.v.vault, refOf(1))).toEqual({ ok: false, reason });
  });

  it("says work_mismatch when the files name another work item than the reference", () => {
    const { v } = sealed();
    renameSync(join(v.vault.dir, WORK_ID), join(v.vault.dir, OTHER_WORK_ID));
    expect(readScenarioSet(v.vault, refOf(1, OTHER_WORK_ID))).toEqual({ ok: false, reason: "work_mismatch" });
  });
});

describe("listVaultCanaries", () => {
  it("lists canaries of verified sets and reports a set that differs from its seal.completed", () => {
    const v = setupVault();
    const first = [storedScenario(1), storedScenario(2, { split: "test" })];
    const second = [storedScenario(3)];
    const a = writeScenarioSet(v.vault, refOf(1), first);
    const b = writeScenarioSet(v.vault, refOf(2), second);
    const seals = [sealRecord(1, a.set_sha256), sealRecord(2, b.set_sha256)];

    expect(listVaultCanaries(v.vault, WORK_ID, seals)).toEqual({
      canaries: [first[0]!.canary, first[1]!.canary, second[0]!.canary],
      unverified: [],
    });

    // A hand edit changes the digest, so that set steers nothing; a recorded seal with no files is reported too.
    const file = join(setDir(v.vault, refOf(1)), `${first[0]!.scenario_id}.yaml`);
    writeFileSync(file, readFileSync(file, "utf8").replace("adding item 1", "adding item one"));
    const result = listVaultCanaries(v.vault, WORK_ID, [...seals, sealRecord(3, digest("c"))]);
    expect(result).toEqual({ canaries: [second[0]!.canary], unverified: [sealId(1), sealId(3)] });
  });
});
