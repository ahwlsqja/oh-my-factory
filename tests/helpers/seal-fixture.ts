import { readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDecideResolve } from "../../src/cli/decide.js";
import type { Ids } from "../../src/scenario/intake.js";
import type { SealInputs } from "../../src/seal/prompt.js";
import { type SealDeps, type SealStageResult, runSealStage } from "../../src/seal/seal.js";
import {
  type AgentSession,
  type AuthorOutcome,
  type AuthorRequest,
  createCommandAuthor,
} from "../../src/seal/session.js";
import { type Vault, openVault } from "../../src/vault/vault.js";
import {
  CONTRACT,
  type DecisionFixture,
  HUMAN,
  NOW,
  addInterface,
  closeInterface,
  setupDecisionItem,
} from "./decision-fixture.js";

export const AUTHOR_STUB = fileURLToPath(new URL("./author-stub.mjs", import.meta.url));

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

/** The canary `fixedIds` hands out as its n-th (built at run time: a full literal would trip OMF run on OMF). */
export const canaryFor = (n: number): string => `omf-canary-${hex(n, 32)}`;

/** Counters instead of randomness, so a test can name the id a stored scenario got. Each counter starts at 1. */
export function fixedIds(): Ids {
  let scenario = 0;
  let canary = 0;
  let seal = 0;
  return {
    scenarioId: () => `s-${hex(++scenario, 32)}`,
    canary: () => canaryFor(++canary),
    sealId: () => `seal-${hex(++seal, 16)}`,
  };
}

export interface SealFixture {
  f: DecisionFixture;
  vault: Vault;
  ids: Ids;
  now: Date;
}

/** A `ready` item whose GATE-1 passes (`cli`), or whose interface is resolved as http (`http`), or with no interface decision at all (`open`). */
export function sealFixture(contract: "cli" | "http" | "open" = "cli"): SealFixture {
  const f = setupDecisionItem();
  if (contract === "cli") closeInterface(f);
  if (contract === "http") {
    addInterface(f);
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-interface",
      {
        choice: "A web service",
        rationale: "Callers use HTTP.",
        rejected: [],
        interface: { ...CONTRACT, kind: "http" },
      },
      HUMAN,
    );
  }
  return { f, vault: openVault(f.fx.location, f.fx.env), ids: fixedIds(), now: NOW };
}

export function depsFor(s: SealFixture, session: AgentSession, extra: Partial<SealDeps> = {}): SealDeps {
  return {
    location: s.f.fx.location,
    item: s.f.item,
    session,
    ledger: s.f.fx.ledger,
    vault: s.vault,
    now: () => s.now,
    ids: s.ids,
    env: s.f.fx.env,
    ...extra,
  };
}

/** The command author over `author-stub.mjs <mode> <record> <args...>`. */
export function commandAuthor(mode: string, record: string, ...args: string[]): AgentSession {
  return createCommandAuthor({ command: [process.execPath, AUTHOR_STUB, mode, record, ...args] });
}

/** A session that records its calls and answers every one with `outcome`. */
export function countingSession(
  outcome: AuthorOutcome = { ok: false, code: "spawn_failed", durationMs: 0 },
): AgentSession & { calls: AuthorRequest[] } {
  const calls: AuthorRequest[] = [];
  return {
    id: "counting",
    vendor: "command",
    model: "stub",
    isolation: "host_command",
    calls,
    async run(request: AuthorRequest): Promise<AuthorOutcome> {
      calls.push(request);
      return outcome;
    },
  };
}

export function stored(result: SealStageResult): Extract<SealStageResult, { status: "stored" }> {
  if (result.status !== "stored") throw new Error(`expected stored, got ${JSON.stringify(result)}`);
  return result;
}

/** An `omf` work.started for the item, as M3b1's run would append it. Any actor counts for the order check. */
export function startWork(s: SealFixture): void {
  s.f.fx.ledger.append({
    actor: "omf",
    type: "work.started",
    payload: { goal_id: s.f.scope.goal_id, work_id: s.f.workId, run_id: "r-20261014T000000Z-0001", from: "ready" },
  });
}

/** One authored scenario document in the YAML the author writes. `extra` lines are appended at the top level. */
export function authoredDoc(options: {
  split: "train" | "test";
  refs?: string[];
  argv?: string[];
  extra?: string[];
}): string {
  return [
    "decision_refs:",
    ...(options.refs ?? ["d-interface"]).map((ref) => `  - ${ref}`),
    "kind: behavior",
    `split: ${options.split}`,
    "interface: cli",
    "steps:",
    "  - invoke:",
    `      argv: ${JSON.stringify(options.argv ?? ["status"])}`,
    '      stdin: ""',
    "    expect:",
    "      exit_code: 0",
    "      stdout_matches:",
    "        kind: exact",
    '        text: "ok\\n"',
    "      note: the status command reports ok",
    ...(options.extra ?? []),
  ].join("\n");
}

export interface RefusalProbe {
  error: unknown;
  calls: number;
  eventsBefore: number;
  eventsAfter: number;
  vaultEntries: string[];
}

/**
 * Plants sealed material where it must not be (a canary-shaped string in the repository, or a symlink in the project
 * state) and runs the stage with the default preflight. The caller asserts that it threw before the author, the ledger
 * and the vault were touched.
 */
export async function probeSealRefusal(kind: "canary_in_repo" | "symlink_in_state"): Promise<RefusalProbe> {
  const s = sealFixture();
  const session = countingSession();
  if (kind === "canary_in_repo") {
    writeFileSync(join(s.f.fx.repo, "notes.txt"), `left over: ${"omf-canary-"}${"a".repeat(32)}\n`);
  } else {
    symlinkSync(s.f.fx.repo, join(s.f.fx.location.dir, "evil-link"));
  }
  const eventsBefore = s.f.fx.ledger.readVerified().length;
  let error: unknown = null;
  try {
    await runSealStage(depsFor(s, session));
  } catch (err) {
    error = err;
  }
  return {
    error,
    calls: session.calls.length,
    eventsBefore,
    eventsAfter: s.f.fx.ledger.readVerified().length,
    vaultEntries: readdirSync(s.vault.dir),
  };
}

/** A valid, closed `SealInputs` for tests that call a session directly (the command author ignores it). */
export const SESSION_INPUTS: SealInputs = {
  intent: "# Intent\n\nA cache that survives a restart.\n",
  spec: "# Specification\n\nThe interface decision is resolved.\n",
  contract: CONTRACT,
  linkable_decision_ids: ["d-interface"],
  quantitative_decision_ids: [],
};
