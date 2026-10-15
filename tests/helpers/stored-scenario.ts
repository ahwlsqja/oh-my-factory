import type { SealCounts, SealRecord } from "../../src/scenario/events.js";
import type { AuthorStamp, StoredScenario } from "../../src/scenario/types.js";
import { SCOPE } from "./decision.js";

/** The work item every M3c fixture belongs to (`SCOPE` is the repository's standard decision scope). */
export const WORK_ID = SCOPE.work_id;
export const OTHER_WORK_ID = "w-ffffffffffff";
export const AT = "2026-10-14T00:00:00.000Z";

export const AUTHOR: AuthorStamp = { vendor: "command", model: "stub", at: AT, isolation: "host_command" };
export const COUNTS: SealCounts = {
  authored: 3,
  stored: 2,
  behavior: 2,
  contradiction_canary: 0,
  train: 1,
  test: 1,
  rejected: 1,
  ignored_fields: 0,
};

export const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
export const digest = (char: string): string => char.repeat(64);
export const sealId = (n: number): string => `seal-${hex(n, 16)}`;

/** A completed-seal record as `foldSeals` returns it. */
export function sealRecord(n: number, setSha256: string): SealRecord {
  return {
    seq: n,
    round: n,
    seal_id: sealId(n),
    author: AUTHOR,
    decisions_digest: digest("a"),
    set_sha256: setSha256,
    counts: COUNTS,
  };
}

/** A schema-valid stored scenario. The canary is built here at run time, never written as a literal. */
export function storedScenario(n: number, overrides: Partial<StoredScenario> = {}): StoredScenario {
  const canary = `omf-canary-${hex(n, 32)}`;
  return {
    schema_version: 1,
    scenario_id: `s-${hex(n, 32)}`,
    work_id: WORK_ID,
    author: AUTHOR,
    decision_refs: ["d-interface"],
    kind: "behavior",
    split: "train",
    interface: "cli",
    steps: [
      {
        invoke: { argv: ["add", `item-${n}`], stdin: "" },
        expect: {
          exit_code: 0,
          stdout_matches: { kind: "exact", text: `added item-${n}\n` },
          json_path: null,
          note: `${canary} adding item ${n} prints it back`,
        },
      },
    ],
    canary,
    ...overrides,
  };
}
