import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import { lintDecisionStrings } from "./leak-lint.js";
import type { LeakContext } from "./leak-lint.js";
import { recordProblems } from "./lint.js";
import { INTERFACE_DECISION_ID } from "./types.js";
import type { DecisionRecord, DecisionState, InterfaceContract, Qas, ResponseMeasure } from "./types.js";

const PROJECTION_COMMENT = "<!-- projection of the decision ledger; edits are overwritten -->";

/** <itemDir>/spec.md, next to intent.md. */
export function specFile(itemDir: string): string {
  return join(itemDir, "spec.md");
}

/**
 * Every value is printed on one line. A question or rationale holding a newline could otherwise start a
 * line with `## Resolved` and forge a section of this projection.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function measureText(measure: ResponseMeasure): string {
  const extras: string[] = [];
  if (measure.percentile !== null) extras.push(`p${measure.percentile}`);
  if (measure.window !== null) extras.push(`window ${oneLine(measure.window)}`);
  const base = `${oneLine(measure.metric)} ${measure.op} ${measure.threshold} ${oneLine(measure.unit)}`;
  return extras.length === 0 ? base : `${base} (${extras.join(", ")})`;
}

function qasText(qas: Qas): string {
  return [
    `source: ${qas.source}`,
    `stimulus: ${qas.stimulus}`,
    `environment: ${qas.environment}`,
    `artifact: ${qas.artifact}`,
    `response: ${qas.response}`,
  ].join("; ");
}

function interfaceRows(contract: InterfaceContract): Array<[string, string | null]> {
  const argv = (value: string[] | null): string => (value === null ? "none" : JSON.stringify(value));
  return [
    ["Kind", contract.kind],
    ["Build", argv(contract.build)],
    ["Run", argv(contract.run)],
    ["I/O contract", contract.io_contract],
    ["Gate fast", argv(contract.gates.fast)],
    ["Gate full", argv(contract.gates.full)],
    ["Gate deep", argv(contract.gates.deep)],
    ["Required gates", contract.gates.required.join(", ")],
    ["Test command", argv(contract.test_command)],
  ];
}

/** A heading and one `- Label: value` line per non-empty row. Ends with a blank line. */
function block(record: DecisionRecord, rows: Array<[string, string | null]>): string[] {
  const lines = [`### ${record.id} (${record.class})`, ""];
  for (const [label, value] of rows) {
    if (value !== null && value !== "") lines.push(`- ${label}: ${oneLine(value)}`);
  }
  lines.push("");
  return lines;
}

function contentRows(record: DecisionRecord): Array<[string, string | null]> {
  return [
    ["Question", record.question],
    ["Scenario", record.qas === null ? null : qasText(record.qas)],
    ["Choice", record.resolution?.choice ?? null],
    ["Rationale", record.resolution?.rationale ?? null],
    [
      "Rejected",
      record.resolution === null || record.resolution.rejected.length === 0
        ? null
        : record.resolution.rejected.join("; "),
    ],
    ["Measure", record.response_measure === null ? null : measureText(record.response_measure)],
  ];
}

function section(title: string, body: string[], empty: string): string[] {
  return [`## ${title}`, "", ...(body.length === 0 ? [empty] : body), ""];
}

/**
 * Renders the decisions of one work item as Markdown (spec §5.0, M3a A9, A16b, A17). Pure and byte-stable:
 * the same state, header and leak context give the same string. There is no clock (a deferral prints its
 * stored `expires_at`, never "expired"), no randomness and no file read.
 *
 * Only content fields are printed. The goal id, the work id, `by`, `at`, `signed_by`, `added_by` and a
 * deferral's `owner` are not, so no e-mail address and no goal id can reach the file, which M3g copies
 * into a worktree that a model can read. A record that fails `recordProblems` under `leak` (a leak after
 * a re-lock, a quantitative decision without a measure, a leaking id) is withheld: it appears under Open
 * as `record withheld (<problem code>) #<added_seq>`, with no id and no text.
 */
export function renderSpec(state: DecisionState, header: { title: string }, leak: LeakContext): string {
  const titleLeaks = lintDecisionStrings(header.title, leak).length > 0;
  const iface: string[] = [];
  const resolved: string[] = [];
  const deferred: string[] = [];
  const open: string[] = [];
  const notApplicable: string[] = [];

  for (const record of [...state.decisions].sort((a, b) => a.added_seq - b.added_seq)) {
    const [problem] = recordProblems(record, leak);
    if (problem !== undefined) {
      open.push(`- record withheld (${problem.code}) #${record.added_seq}`);
    } else if (record.status === "resolved" && record.id === INTERFACE_DECISION_ID && record.interface !== null) {
      iface.push(...block(record, [...contentRows(record), ...interfaceRows(record.interface)]));
    } else if (record.status === "resolved") {
      resolved.push(...block(record, contentRows(record)));
    } else if (record.status === "deferred") {
      const deferral = record.deferral;
      deferred.push(
        ...block(record, [
          ["Question", record.question],
          ["Reason", deferral?.reason ?? null],
          ["Revisit when", deferral?.revisit_trigger ?? null],
          ["Default", deferral?.default ?? null],
          ["Expires", deferral?.expires_at ?? null],
        ]),
      );
    } else if (record.status === "na") {
      notApplicable.push(
        ...block(record, [
          ["Question", record.question],
          ["Rationale", record.na?.rationale ?? null],
        ]),
      );
    } else {
      open.push(`- ${record.id} (${record.class}): ${oneLine(record.question)}`);
    }
  }

  const lines = [
    `# ${titleLeaks ? "(title withheld)" : oneLine(header.title)}`,
    "",
    PROJECTION_COMMENT,
    "",
    ...section("Interface", iface, "Not resolved yet. This blocks sealing."),
    ...section("Resolved", resolved, "None."),
    ...section("Deferred", deferred, "None."),
    ...section("Open (these block sealing)", open, "None."),
    ...section("Not applicable", notApplicable, "None."),
  ];
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** Atomic and private (0600): `omf decide lint` and a concurrent reader never see a half-written file. */
export function writeSpec(itemDir: string, text: string): void {
  writePrivateFileAtomic(specFile(itemDir), text);
}

/**
 * Compares the file on disk with a fresh render, to report a stale or hand-edited projection. It is the
 * only place spec.md is read, and the content is never parsed or used. Anything that is not a regular file
 * (a directory, a symlink) is drift. A symlink is replaced by the next write (the atomic rename replaces the
 * link itself). A directory at that path is not: the rename fails with EISDIR, so the verb exits 2 after its ledger
 * event is written; `lint` keeps reporting the drift until a person removes the directory.
 */
export function specStatus(itemDir: string, expected: string): "ok" | "missing" | "drift" {
  const file = specFile(itemDir);
  try {
    if (!lstatSync(file).isFile()) return "drift";
    return readFileSync(file, "utf8") === expected ? "ok" : "drift";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}
