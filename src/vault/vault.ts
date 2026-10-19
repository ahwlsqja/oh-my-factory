import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { CanaryIndexEntry } from "../audit/attribute.js";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import type { ProjectLocation } from "../core/paths.js";
import {
  SymlinkRefusedError,
  UnsafePathError,
  assertNoSymlinksBelow,
  mkdirPrivate,
  readRegularNoFollow,
  realProjectDir,
  writeNewNoFollow,
} from "../core/safe-fs.js";
import { validateDef } from "../core/schema.js";
import { SEAL_ID_PATTERN } from "../scenario/events.js";
import type { SealRecord } from "../scenario/events.js";
import { CANARY_PATTERN, MAX_SCENARIO_BYTES, MAX_SCENARIOS_PER_SET, scenarioRef } from "../scenario/types.js";
import type { ScenarioSplit, ScenarioStatus, StoredScenario } from "../scenario/types.js";

/**
 * The Scenario Vault: sealed scenario sets under `<project>/vault/scenarios/<work_id>/<seal_id>/<scenario_id>.yaml`, outside
 * the repository, 0700 directories and 0600 files (spec §8). The files are the data and the ledger is the authority:
 * `seal.completed` pins a set by `set_sha256` and GATE-2 recomputes it from what is read here.
 *
 * Every read and write goes through `core/safe-fs.ts`, which refuses a symlink below the real state root. Limit, as there: an
 * lstat walk plus `O_NOFOLLOW` does not stop a process that can already write to the OMF home from racing a swap.
 */

const SCHEMA = "scenario.schema.json";
const WORK_ID_PATTERN = /^w-[0-9a-f]{12}$/;
const FILE_NAME = /^s-[0-9a-f]{32}\.yaml$/;
/** A rendered file is the authored document plus OMF's stamp and YAML quoting, so it may exceed the authored limit. */
const MAX_FILE_BYTES = MAX_SCENARIO_BYTES * 2;

export type VaultErrorCode = "set_exists" | "invalid_scenario" | "too_many";
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/** `root` is the real state root; `dir` is `<real project>/vault/scenarios`. */
export interface Vault {
  readonly root: string;
  readonly dir: string;
}

/** The set directory is named by `seal_id`, so concurrent or repeated seals never collide. */
export interface SetRef {
  work_id: string;
  seal_id: string;
}

/** Walks the path for symlinks, then creates `vault/scenarios` at 0700. Throws `SymlinkRefusedError` for a link. */
export function openVault(location: ProjectLocation, env: NodeJS.ProcessEnv = process.env): Vault {
  const { root, dir: projectDir } = realProjectDir(location, env);
  const dir = join(projectDir, "vault", "scenarios");
  assertNoSymlinksBelow(root, dir);
  mkdirPrivate(root, dir);
  return { root, dir };
}

/** `<dir>/<work_id>/<seal_id>`. An id that is not shaped like an id could name a path elsewhere, so it is refused. */
export function setDir(vault: Vault, ref: SetRef): string {
  if (!WORK_ID_PATTERN.test(ref.work_id) || !SEAL_ID_PATTERN.test(ref.seal_id)) {
    throw new UnsafePathError("outside_root", "a set reference must be a work id and a seal id");
  }
  return join(vault.dir, ref.work_id, ref.seal_id);
}

/** Canonical key order, so rendering the same scenario twice gives the same bytes. Plain YAML, readable by a person. */
export function renderScenarioFile(scenario: StoredScenario): string {
  return stringify(scenario, { sortMapEntries: true, lineWidth: 0 });
}

const byId = (a: StoredScenario, b: StoredScenario): number =>
  a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0;

/** sha256 over the canonical JSON of the stored scenarios sorted by id: the whole record, so any edited field changes it. */
export function setSha256(scenarios: readonly StoredScenario[]): string {
  return sha256Hex(canonicalize([...scenarios].sort(byId)));
}

/**
 * The per-split digest the feedback layer keys its release ladder on: the stored scenarios of one split whose effective status is
 * active. Retiring or contaminating a scenario (a ledger event) or editing one changes it; another split's change does not.
 */
export function splitDigest(
  scenarios: readonly StoredScenario[],
  statuses: ReadonlyMap<string, ScenarioStatus>,
  split: ScenarioSplit,
): string {
  const active = scenarios
    .filter(
      (scenario) =>
        scenario.split === split && (statuses.get(scenarioRef(scenario.scenario_id)) ?? "active") === "active",
    )
    .sort(byId);
  return sha256Hex(canonicalize(active));
}

/**
 * Files first, ledger second. Validates every scenario before touching the disk, creates the set directory with a plain
 * `mkdir` so an existing name (a set, or a link planted there) is `set_exists`, then writes each `<scenario_id>.yaml` exclusively.
 * A crash leaves an orphan directory that no event names; nothing is swept.
 */
export function writeScenarioSet(
  vault: Vault,
  ref: SetRef,
  scenarios: readonly StoredScenario[],
): { set_sha256: string } {
  if (scenarios.length > MAX_SCENARIOS_PER_SET)
    throw new VaultError("too_many", `a set holds at most ${MAX_SCENARIOS_PER_SET} scenarios`);
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (
      !validateDef(SCHEMA, "stored_scenario", scenario).ok ||
      scenario.work_id !== ref.work_id ||
      seen.has(scenario.scenario_id)
    ) {
      throw new VaultError(
        "invalid_scenario",
        "a scenario does not validate, names another work item or repeats an id",
      );
    }
    seen.add(scenario.scenario_id);
  }
  const dir = setDir(vault, ref);
  mkdirPrivate(vault.root, dirname(dir));
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new VaultError("set_exists", `set ${ref.seal_id} already exists`);
    throw err;
  }
  chmodSync(dir, 0o700);
  for (const scenario of [...scenarios].sort(byId)) {
    writeNewNoFollow(vault.root, join(dir, `${scenario.scenario_id}.yaml`), renderScenarioFile(scenario));
  }
  return { set_sha256: setSha256(scenarios) };
}

export type ScenarioSetRead =
  | { ok: true; scenarios: StoredScenario[]; set_sha256: string }
  | {
      ok: false;
      reason:
        | "set_missing"
        | "symlink_refused"
        | "unreadable"
        | "invalid_scenario"
        | "name_mismatch"
        | "extra_entry"
        | "work_mismatch";
    };

/**
 * Reads one set. Every entry is lstat-ed first and only regular files named `<scenario_id>.yaml` are allowed; each is read with
 * `readRegularNoFollow`, parsed with the YAML core schema (duplicate keys and aliases refused, as at intake), validated against
 * `stored_scenario`, and must carry the file's own id and the reference's work id. Hostile or damaged content returns a reason;
 * nothing here throws on what is in the vault.
 */
export function readScenarioSet(vault: Vault, ref: SetRef): ScenarioSetRead {
  let dir: string;
  try {
    dir = setDir(vault, ref);
  } catch {
    return { ok: false, reason: "set_missing" };
  }
  try {
    assertNoSymlinksBelow(vault.root, dir);
  } catch (err) {
    return { ok: false, reason: err instanceof SymlinkRefusedError ? "symlink_refused" : "unreadable" };
  }
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === "ENOENT" ? "set_missing" : "unreadable" };
  }
  if (names.length > MAX_SCENARIOS_PER_SET) return { ok: false, reason: "extra_entry" };
  for (const name of names) {
    let stat;
    try {
      stat = lstatSync(join(dir, name));
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: "symlink_refused" };
    if (!stat.isFile() || !FILE_NAME.test(name)) return { ok: false, reason: "extra_entry" };
  }
  const scenarios: StoredScenario[] = [];
  for (const name of names) {
    let bytes: Buffer;
    try {
      bytes = readRegularNoFollow(vault.root, join(dir, name), MAX_FILE_BYTES);
    } catch (err) {
      return { ok: false, reason: err instanceof SymlinkRefusedError ? "symlink_refused" : "unreadable" };
    }
    let data: unknown;
    try {
      data = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
        schema: "core",
        uniqueKeys: true,
        maxAliasCount: 0,
      });
    } catch {
      return { ok: false, reason: "invalid_scenario" };
    }
    if (!validateDef(SCHEMA, "stored_scenario", data).ok) return { ok: false, reason: "invalid_scenario" };
    const scenario = data as StoredScenario;
    if (`${scenario.scenario_id}.yaml` !== name) return { ok: false, reason: "name_mismatch" };
    if (scenario.work_id !== ref.work_id) return { ok: false, reason: "work_mismatch" };
    scenarios.push(scenario);
  }
  return { ok: true, scenarios, set_sha256: setSha256(scenarios) };
}

/**
 * Canaries for the poka-yoke and the audit scans: every scenario of every set that reads cleanly and whose digest equals the one
 * its `seal.completed` recorded, retired and contaminated ones included (a retired scenario's canary must still be found). A set
 * that fails either check contributes nothing and its seal id is listed in `unverified`, so a hand-edited file cannot steer a scan.
 */
export function listVaultCanaries(
  vault: Vault,
  workId: string,
  seals: readonly SealRecord[],
): { canaries: string[]; unverified: string[] } {
  const canaries = new Set<string>();
  const unverified: string[] = [];
  for (const seal of seals) {
    const read = readScenarioSet(vault, { work_id: workId, seal_id: seal.seal_id });
    if (!read.ok || read.set_sha256 !== seal.set_sha256) {
      unverified.push(seal.seal_id);
      continue;
    }
    for (const scenario of read.scenarios) canaries.add(scenario.canary);
  }
  return { canaries: [...canaries].sort(), unverified };
}

/**
 * The canary-to-scenario index the audit needs to mark a contaminated scenario. Same trust rule as `listVaultCanaries`: only a
 * set that reads cleanly and whose digest equals its `seal.completed` contributes index entries. A set that reads but does not
 * verify is listed in `unverified`, and its canary-shaped strings come back in `unverified_canaries` so the scan can still look
 * for them; they never name a scenario, because a hand-edited file must not decide which scenario gets marked.
 */
export function listVaultCanaryIndex(
  vault: Vault,
  workId: string,
  seals: readonly SealRecord[],
): { index: CanaryIndexEntry[]; unverified: string[]; unverified_canaries: string[] } {
  const index: CanaryIndexEntry[] = [];
  const unverified: string[] = [];
  const loose = new Set<string>();
  for (const seal of seals) {
    const read = readScenarioSet(vault, { work_id: workId, seal_id: seal.seal_id });
    if (!read.ok || read.set_sha256 !== seal.set_sha256) {
      unverified.push(seal.seal_id);
      if (read.ok)
        for (const scenario of read.scenarios) if (CANARY_PATTERN.test(scenario.canary)) loose.add(scenario.canary);
      continue;
    }
    for (const scenario of read.scenarios) {
      index.push({
        canary: scenario.canary,
        scenario_ref: scenarioRef(scenario.scenario_id),
        seal_id: seal.seal_id,
        scenario_id: scenario.scenario_id,
      });
    }
  }
  index.sort((a, b) => (a.canary < b.canary ? -1 : a.canary > b.canary ? 1 : 0));
  return { index, unverified, unverified_canaries: [...loose].sort() };
}
