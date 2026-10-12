import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "./canonical-json.js";
import { withLockSync } from "./lock.js";
import { validate } from "./schema.js";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEvent {
  schema_version: 1;
  seq: number;
  prev_hash: string;
  ts: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  hash: string;
}

export interface NewEvent {
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}

export type VerifyResult = { ok: true; count: number; head: string } | { ok: false; seq: number; reason: string };

export class LedgerCorruptError extends Error {
  constructor(
    readonly seq: number,
    readonly reason: string,
  ) {
    super(`ledger corrupt at seq ${seq}: ${reason}`);
    this.name = "LedgerCorruptError";
  }
}

export function hashEvent(body: Omit<LedgerEvent, "hash">): string {
  return sha256Hex(canonicalize(body));
}

export class Ledger {
  readonly file: string;
  readonly lockFile: string;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(dir, "ledger.jsonl");
    this.lockFile = join(dir, "ledger.lock");
  }

  /** Raw read without verification. Prefer readVerified. */
  readAll(): LedgerEvent[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter((line) => line.length > 0);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch {
        throw new LedgerCorruptError(index + 1, "unparseable line");
      }
    });
  }

  verify(): VerifyResult {
    let events: LedgerEvent[];
    try {
      events = this.readAll();
    } catch (err) {
      if (err instanceof LedgerCorruptError) return { ok: false, seq: err.seq, reason: err.reason };
      throw err;
    }
    let prev = GENESIS_HASH;
    for (const [index, event] of events.entries()) {
      const seq = index + 1;
      if (event.seq !== seq) return { ok: false, seq, reason: `seq is ${event.seq}` };
      if (event.prev_hash !== prev) return { ok: false, seq, reason: "prev_hash mismatch" };
      const { hash, ...body } = event;
      if (hashEvent(body) !== hash) return { ok: false, seq, reason: "hash mismatch" };
      const shape = validate("ledger-event.schema.json", event);
      if (!shape.ok) return { ok: false, seq, reason: `schema: ${shape.errors}` };
      prev = hash;
    }
    return { ok: true, count: events.length, head: prev };
  }

  /** Every command reads through here, so a broken chain stops the command. */
  readVerified(): LedgerEvent[] {
    const result = this.verify();
    if (!result.ok) throw new LedgerCorruptError(result.seq, result.reason);
    return this.readAll();
  }

  append(input: NewEvent): LedgerEvent {
    return withLockSync(this.lockFile, () => {
      const state = this.verify();
      if (!state.ok) throw new LedgerCorruptError(state.seq, state.reason);
      const body: Omit<LedgerEvent, "hash"> = {
        schema_version: 1,
        seq: state.count + 1,
        prev_hash: state.head,
        ts: this.now().toISOString(),
        actor: input.actor,
        type: input.type,
        payload: input.payload,
      };
      const event: LedgerEvent = { ...body, hash: hashEvent(body) };
      const shape = validate("ledger-event.schema.json", event);
      if (!shape.ok) throw new Error(`invalid event: ${shape.errors}`);
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      return event;
    });
  }
}
