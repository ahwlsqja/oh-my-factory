import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import { safeText } from "../core/safe-text.js";
import { validateDef } from "../core/schema.js";
import type { ConflictRequest } from "../implementer/request.js";
import type { Gate1Reason, Gate1Result } from "./gate1.js";
import type { DecisionScope } from "./types.js";
import { INTERFACE_DECISION_ID } from "./types.js";

/**
 * The J2 persist-and-exit record (spec §6.2, M3-D7). GATE-1 found something only a person can settle; OMF
 * writes this file, prints the reasons and exits 3 instead of waiting. `default: null` is the explicit
 * "no silent approval" marker: nothing proceeds on a timeout.
 */
export interface NeedsHuman {
  schema_version: 1;
  /** "nh-" + first 12 hex of the hash of resume_token. */
  id: string;
  j: "J2";
  work_id: string;
  goal_id: string;
  /** Fixed template with counts and ids only, never decision text. */
  question: string;
  /** One command line per distinct next step, in a fixed order. */
  options: string[];
  default: null;
  /** sha256Hex(canonicalize({work_id, reasons})), first 32 hex: the same block always gets the same token. */
  resume_token: string;
  reasons: Gate1Reason[];
  created_at: string;
}

type Blocked = Extract<Gate1Result, { status: "blocked_on_user" }>;

/** Fixed order of the reason codes in the question and in the options, whatever order the gate listed them in. */
const CODE_ORDER: Gate1Reason["code"][] = [
  "interface_missing",
  "interface_unresolved",
  "intent_question_missing",
  "required_open",
  "deferral_expired",
  "resolution_not_human",
  "deferral_unsigned",
  "record_invalid",
  "ledger_anomaly",
];

const CANCEL_OR_VETO = "cancel or veto the work item (a closed or forged record cannot be reopened in v0.1)";

/** <itemDir>/needs-human.json, next to item.md and intent.md. */
export function needsHumanFile(itemDir: string): string {
  return join(itemDir, "needs-human.json");
}

/**
 * record_invalid and ledger_anomaly can be raised because the id or text of a record leaks under a goal
 * re-lock (A17). Their decision_id is therefore not copied into a file a person may paste around; the
 * reason code and problem or anomaly code are enough to act on, and the action is cancel or veto anyway.
 */
function sanitize(reason: Gate1Reason): Gate1Reason {
  if (reason.code === "record_invalid" || reason.code === "ledger_anomaly") return { ...reason, decision_id: null };
  return reason;
}

function resolveLine(workId: string, decisionId: string): string {
  return `omf decide resolve ${workId} ${decisionId} --file <resolution.json>`;
}

/**
 * Command lines per distinct reason code, in CODE_ORDER and then reason order, duplicates dropped. Reasons that
 * no decision verb can clear get the cancel-or-veto line: record_invalid, ledger_anomaly (every anomaly is
 * permanent) and resolution_not_human (only a hand-built state has it, and a resolved record is final), because
 * v0.1 has no general reopen verb (A13). An expired or unsigned deferral is a deferred record, which a person can
 * resolve, defer anew or mark n/a (A21), so it keeps the resolve line.
 */
function optionsFor(workId: string, reasons: readonly Gate1Reason[]): string[] {
  const lines: string[] = [];
  const push = (line: string): void => {
    if (!lines.includes(line)) lines.push(line);
  };
  for (const code of CODE_ORDER) {
    for (const reason of reasons) {
      if (reason.code !== code) continue;
      switch (reason.code) {
        case "interface_missing":
          push(`omf decide add ${workId} --file <entry.json>  (id ${INTERFACE_DECISION_ID}, class interface)`);
          push(resolveLine(workId, INTERFACE_DECISION_ID));
          break;
        case "interface_unresolved":
          push(resolveLine(workId, INTERFACE_DECISION_ID));
          break;
        case "intent_question_missing":
          // Any decide write seeds the missing intent-question records (A15); show is the read-only way to see them.
          push(`omf decide show ${workId}`);
          push(resolveLine(workId, reason.decision_id));
          break;
        case "required_open":
        case "deferral_expired":
        case "deferral_unsigned":
          push(resolveLine(workId, reason.decision_id));
          break;
        case "resolution_not_human":
        case "record_invalid":
        case "ledger_anomaly":
          push(CANCEL_OR_VETO);
          break;
      }
    }
  }
  return lines;
}

function questionFor(workId: string, reasons: readonly Gate1Reason[]): string {
  const counts = CODE_ORDER.flatMap((code) => {
    const n = reasons.filter((reason) => reason.code === code).length;
    return n === 0 ? [] : [`${code} x${n}`];
  });
  const ids: string[] = [];
  for (const reason of reasons) {
    if ("decision_id" in reason && reason.decision_id !== null && !ids.includes(reason.decision_id))
      ids.push(reason.decision_id);
  }
  const decisions = ids.length === 0 ? "" : ` Decisions: ${ids.join(", ")}.`;
  return `Work item ${workId} cannot pass GATE-1: ${reasons.length} reason(s) need a person (J2). Reasons: ${counts.join(", ")}.${decisions}`;
}

/** Pure: the record for one GATE-1 block. `now` only fills created_at; the token does not depend on it. */
export function needsHumanFor(scope: DecisionScope, gate: Blocked, now: Date): NeedsHuman {
  const reasons = gate.reasons.map(sanitize);
  const resumeToken = sha256Hex(canonicalize({ work_id: scope.work_id, reasons })).slice(0, 32);
  return {
    schema_version: 1,
    id: `nh-${sha256Hex(resumeToken).slice(0, 12)}`,
    j: "J2",
    work_id: scope.work_id,
    goal_id: scope.goal_id,
    question: questionFor(scope.work_id, reasons),
    options: optionsFor(scope.work_id, reasons),
    default: null,
    resume_token: resumeToken,
    reasons,
    created_at: now.toISOString(),
  };
}

/** The persisted record, or null when the file is missing, unparsable or fails the schema. */
export function readNeedsHuman(itemDir: string): NeedsHuman | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(needsHumanFile(itemDir), "utf8"));
  } catch {
    return null;
  }
  return validateDef("decision.schema.json", "needs_human", parsed).ok ? (parsed as NeedsHuman) : null;
}

/**
 * Atomic write at 0600. A file that already holds the same resume_token is left untouched, so created_at stays
 * the time the block first appeared and repeated `omf decide lint` runs do not churn the file.
 */
export function persistNeedsHuman(itemDir: string, record: NeedsHuman): void {
  if (readNeedsHuman(itemDir)?.resume_token === record.resume_token) return;
  writePrivateFileAtomic(needsHumanFile(itemDir), `${JSON.stringify(record, null, 2)}\n`);
}

/** Removes the file; a missing file is fine. Called when GATE-1 passes. */
export function clearNeedsHuman(itemDir: string): void {
  rmSync(needsHumanFile(itemDir), { force: true });
}

/**
 * Re-evaluated state to file: a block is persisted, a pass clears. `omf decide lint` always calls it, and every
 * successful write verb calls it when the file exists, so no stale block outlives the resolve that cleared it.
 */
export function syncNeedsHuman(itemDir: string, scope: DecisionScope, gate: Gate1Result, now: Date): void {
  if (gate.status === "pass") clearNeedsHuman(itemDir);
  else persistNeedsHuman(itemDir, needsHumanFor(scope, gate, now));
}

/**
 * The implementer stopped to ask a person (J2). Kept apart from `needs-human.json`: that file belongs to GATE-1, which
 * rewrites and clears it on every lint, and a request must survive that. Only the kind and the validated paths are stored;
 * the implementer's note is free text from a container and is dropped.
 */
export interface ImplementerRequestRecord {
  work_id: string;
  kind: "test_conflict" | "spec_conflict";
  paths: string[];
  /** Fixed template with the kind, the path count and the paths (escaped, cut to fit). */
  question: string;
  /** The same commands the J2 handoff of this stop offers; a rerun clears this record and starts a new implementer run. */
  options: string[];
  /** sha256Hex(canonicalize({work_id, kind, paths})), first 32 hex: the same request always gets the same token. */
  resume_token: string;
  created_at: string;
}

export const IMPLEMENTER_REQUEST_FILE = "needs-human-implementer.json";

/** <itemDir>/needs-human-implementer.json, next to needs-human.json. */
export function implementerRequestFile(itemDir: string): string {
  return join(itemDir, IMPLEMENTER_REQUEST_FILE);
}

/** The question must stay within the schema's 1000 characters, so the paths shown are cut to this many. */
const SHOWN_PATHS_MAX_CHARS = 700;

/** The paths of a request as one escaped line, as many as fit, then how many were left out. */
function pathsLine(paths: readonly string[]): string {
  const shown: string[] = [];
  let length = 0;
  for (const path of paths) {
    const text = safeText(path);
    const next = length + text.length + (shown.length === 0 ? 0 : 2);
    if (next > SHOWN_PATHS_MAX_CHARS) break;
    shown.push(text);
    length = next;
  }
  const left = paths.length - shown.length;
  return `${shown.join(", ")}${left > 0 ? ` (+${left} more)` : ""}`;
}

/** Atomic write at 0600. A new request replaces an older one: the line clears the old record when a new implementer run starts. */
export function writeImplementerRequest(
  itemDir: string,
  scope: DecisionScope,
  request: ConflictRequest,
  now: Date,
): ImplementerRequestRecord {
  const id = scope.work_id;
  const record: ImplementerRequestRecord = {
    work_id: id,
    kind: request.kind,
    paths: [...request.paths],
    question: `Work item ${id}: the implementer stopped and raised a ${request.kind} conflict that names ${request.paths.length} path(s)${request.paths.length === 0 ? "" : `: ${pathsLine(request.paths)}`} (J2).`,
    options: [`omf decide show ${id}`, `omf veto ${id}`, `omf run ${id}`],
    resume_token: sha256Hex(canonicalize({ work_id: id, kind: request.kind, paths: request.paths })).slice(0, 32),
    created_at: now.toISOString(),
  };
  const check = validateDef("decision.schema.json", "implementer_request", record);
  if (!check.ok) throw new Error(`invalid implementer request record: ${check.errors}`);
  writePrivateFileAtomic(implementerRequestFile(itemDir), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** The persisted record, or null when the file is missing, unparsable or fails the schema. */
export function readImplementerRequest(itemDir: string): ImplementerRequestRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(implementerRequestFile(itemDir), "utf8"));
  } catch {
    return null;
  }
  return validateDef("decision.schema.json", "implementer_request", parsed).ok
    ? (parsed as ImplementerRequestRecord)
    : null;
}

/** Removes the file; a missing file is fine. Called at the start of every implementer run. */
export function clearImplementerRequest(itemDir: string): void {
  rmSync(implementerRequestFile(itemDir), { force: true });
}
