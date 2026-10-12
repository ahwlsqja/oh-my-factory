import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
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

export type VerifyResult =
  | { ok: true; count: number; head: string; tornTail?: true }
  | { ok: false; seq: number; reason: string };

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

interface Snapshot {
  text: string;
  events: LedgerEvent[];
  /** An unterminated, unparseable final segment: residue of a write interrupted by a crash. */
  tornTail: string | null;
  /** The final event is intact but lacks its trailing newline. */
  missingNewline: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string, seq: number): LedgerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new LedgerCorruptError(seq, "unparseable line");
  }
  if (!isPlainObject(parsed)) throw new LedgerCorruptError(seq, "not an object");
  return parsed as unknown as LedgerEvent;
}

function verifyEvents(events: LedgerEvent[]): VerifyResult {
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

/**
 * Append-only, hash-chained event log (spec §8). Every command verifies it before acting.
 *
 * Verification catches an edited, reordered, inserted or deleted event anywhere except at the end.
 * It does not catch removing events from the end, or rewriting the whole file consistently.
 * The chain guards against accidents and casual edits, not against someone who can write to
 * ~/.omf; agents never get that access at L2 and above (spec §7).
 *
 * A crash during a write can leave an unterminated, unparseable final line. That residue is not an
 * event: verification ignores it, and the next append discards it and records that it did.
 */
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

  private snapshot(): Snapshot {
    if (!existsSync(this.file)) return { text: "", events: [], tornTail: null, missingNewline: false };
    const text = readFileSync(this.file, "utf8");
    const segments = text.split("\n");
    const last = segments.pop() ?? "";
    const events = segments.filter((line) => line.length > 0).map((line, index) => parseLine(line, index + 1));
    if (last.length === 0) return { text, events, tornTail: null, missingNewline: false };
    try {
      const parsed: unknown = JSON.parse(last);
      if (isPlainObject(parsed)) {
        return { text, events: [...events, parsed as unknown as LedgerEvent], tornTail: null, missingNewline: true };
      }
    } catch {
      // unparseable: a torn write
    }
    return { text, events, tornTail: last, missingNewline: false };
  }

  /** Raw read without verification. Prefer readVerified. */
  readAll(): LedgerEvent[] {
    return this.snapshot().events;
  }

  verify(): VerifyResult {
    let snap: Snapshot;
    try {
      snap = this.snapshot();
    } catch (err) {
      if (err instanceof LedgerCorruptError) return { ok: false, seq: err.seq, reason: err.reason };
      throw err;
    }
    const result = verifyEvents(snap.events);
    return result.ok && snap.tornTail !== null ? { ...result, tornTail: true } : result;
  }

  /** Every command reads through here, so a broken chain stops the command. Reads the file once. */
  readVerified(): LedgerEvent[] {
    const snap = this.snapshot();
    const result = verifyEvents(snap.events);
    if (!result.ok) throw new LedgerCorruptError(result.seq, result.reason);
    return snap.events;
  }

  append(input: NewEvent): LedgerEvent {
    return withLockSync(this.lockFile, () => {
      const snap = this.snapshot();
      const verified = verifyEvents(snap.events);
      if (!verified.ok) throw new LedgerCorruptError(verified.seq, verified.reason);
      let head = { count: verified.count, head: verified.head };
      if (snap.missingNewline) appendFileSync(this.file, "\n");
      if (snap.tornTail !== null) {
        const tailBytes = Buffer.byteLength(snap.tornTail, "utf8");
        truncateSync(this.file, Buffer.byteLength(snap.text, "utf8") - tailBytes);
        const discarded = this.write(head, {
          actor: "omf",
          type: "ledger.tail_discarded",
          payload: { bytes: tailBytes, sha256: sha256Hex(snap.tornTail) },
        });
        head = { count: discarded.seq, head: discarded.hash };
      }
      return this.write(head, input);
    });
  }

  private write(at: { count: number; head: string }, input: NewEvent): LedgerEvent {
    const body: Omit<LedgerEvent, "hash"> = {
      schema_version: 1,
      seq: at.count + 1,
      prev_hash: at.head,
      ts: this.now().toISOString(),
      actor: input.actor,
      type: input.type,
      payload: input.payload,
    };
    let hash: string;
    try {
      hash = hashEvent(body);
    } catch (err) {
      throw new Error(`invalid event: ${(err as Error).message}`);
    }
    const event: LedgerEvent = { ...body, hash };
    const shape = validate("ledger-event.schema.json", event);
    if (!shape.ok) throw new Error(`invalid event: ${shape.errors}`);
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }
}
