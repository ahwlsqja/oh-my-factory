import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "./canonical-json.js";
import { withLockSync } from "./lock.js";
import { validate } from "./schema.js";

export const GENESIS_HASH = "0".repeat(64);

/** What a torn final line means to the user; shared by `ledger verify` and `doctor`. */
export const TORN_TAIL_WARNING =
  "a torn final line (an interrupted write) is ignored; the next write discards it and records that it did";

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
  /** Byte length of the head: everything up to and including the last newline. */
  headBytes: number;
  events: LedgerEvent[];
  /** Raw bytes of an unterminated, unparseable final segment: residue of a write interrupted by a crash. */
  tornTail: Buffer | null;
  /** The final event is intact but lacks its trailing newline. */
  missingNewline: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string, seq: number): LedgerEvent {
  if (line.length === 0) throw new LedgerCorruptError(seq, "empty line");
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
    // A missing field must read as a sentence, never as "seq is undefined".
    if (typeof event.seq !== "number") return { ok: false, seq, reason: `line ${seq} has no seq` };
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
    if (!existsSync(this.file)) return { headBytes: 0, events: [], tornTail: null, missingNewline: false };
    const bytes = readFileSync(this.file);
    const headBytes = bytes.lastIndexOf(0x0a) + 1;
    const head = bytes.subarray(0, headBytes).toString("utf8");
    const lines = head.length === 0 ? [] : head.slice(0, -1).split("\n");
    const events = lines.map((line, index) => parseLine(line, index + 1));
    const tail = bytes.subarray(headBytes);
    if (tail.length === 0) return { headBytes, events, tornTail: null, missingNewline: false };
    try {
      // ignoreBOM keeps a leading U+FEFF, so a BOM-prefixed tail fails to parse and counts as torn.
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const parsed: unknown = JSON.parse(decoder.decode(tail));
      if (isPlainObject(parsed)) {
        return {
          headBytes,
          events: [...events, parsed as unknown as LedgerEvent],
          tornTail: null,
          missingNewline: true,
        };
      }
    } catch {
      // not valid UTF-8 or not JSON: a torn write
    }
    return { headBytes, events, tornTail: tail, missingNewline: false };
  }

  /** Verification result plus the events it covered (empty when the chain is broken). Reads the file once. */
  inspect(): { result: VerifyResult; events: LedgerEvent[] } {
    let snap: Snapshot;
    try {
      snap = this.snapshot();
    } catch (err) {
      if (err instanceof LedgerCorruptError) {
        return { result: { ok: false, seq: err.seq, reason: err.reason }, events: [] };
      }
      throw err;
    }
    const result = verifyEvents(snap.events);
    if (!result.ok) return { result, events: [] };
    return {
      result: snap.tornTail !== null ? { ...result, tornTail: true } : result,
      events: snap.events,
    };
  }

  verify(): VerifyResult {
    return this.inspect().result;
  }

  /** Every command reads through here, so a broken chain stops the command. Reads the file once. */
  readVerified(): LedgerEvent[] {
    const snap = this.snapshot();
    const result = verifyEvents(snap.events);
    if (!result.ok) throw new LedgerCorruptError(result.seq, result.reason);
    return snap.events;
  }

  /**
   * Appends the event that `build` returns. `build` sees the verified events while the ledger lock is
   * held, so a decision that depends on the ledger (budgets, claims) cannot race another writer.
   * If `build` throws, nothing is written.
   * `build` must not call `append` or `appendWith` on this ledger: the lock is not reentrant, so the inner call would wait for the outer one and time out.
   */
  appendWith(build: (events: LedgerEvent[]) => NewEvent): LedgerEvent {
    const written = this.appendWithMany((events) => [build(events)]);
    const last = written.at(-1);
    if (last === undefined) throw new Error("appendWith wrote no event");
    return last;
  }

  /**
   * Like `appendWith`, for a decision that must write several events as one unit (a decision plus the
   * records it depends on). `build` sees the verified events under the ledger lock and returns at least one
   * event; they are appended in order, in one write. If `build` throws, or any returned event is invalid,
   * nothing is written. Returns the appended events only, not a `ledger.tail_discarded` record.
   * The same reentrancy rule applies: `build` must not call this ledger's append methods.
   */
  appendWithMany(build: (events: LedgerEvent[]) => NewEvent[]): LedgerEvent[] {
    return withLockSync(this.lockFile, () => {
      const snap = this.snapshot();
      const verified = verifyEvents(snap.events);
      if (!verified.ok) throw new LedgerCorruptError(verified.seq, verified.reason);
      const inputs = build(snap.events);
      if (inputs.length === 0) throw new Error("appendWithMany needs at least one event");
      // Prepare every line before touching the file, so a rejected event leaves the ledger unchanged.
      let at = { count: verified.count, head: verified.head };
      const lines: string[] = [];
      if (snap.tornTail !== null) {
        const discarded = this.prepare(at, {
          actor: "omf",
          type: "ledger.tail_discarded",
          payload: { bytes: snap.tornTail.length, sha256: sha256Hex(snap.tornTail) },
        });
        lines.push(discarded.line);
        at = { count: discarded.event.seq, head: discarded.event.hash };
      }
      const written: LedgerEvent[] = [];
      for (const input of inputs) {
        const next = this.prepare(at, input);
        lines.push(next.line);
        written.push(next.event);
        at = { count: next.event.seq, head: next.event.hash };
      }
      // Truncate and append are two writes. A crash between them loses the torn tail without a
      // tail_discarded record; the chain stays valid because the torn bytes were never an event.
      if (snap.tornTail !== null) truncateSync(this.file, snap.headBytes);
      appendFileSync(this.file, `${snap.missingNewline ? "\n" : ""}${lines.join("")}`, { mode: 0o600 });
      return written;
    });
  }

  append(input: NewEvent): LedgerEvent {
    return this.appendWith(() => input);
  }

  /** Builds, hashes and validates the event after `at`. Writes nothing. */
  private prepare(at: { count: number; head: string }, input: NewEvent): { event: LedgerEvent; line: string } {
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
    return { event, line: `${JSON.stringify(event)}\n` };
  }
}
