import { sha256Hex } from "../core/canonical-json.js";

/**
 * Shared constants and types of the scenario layer. Everything later tasks and milestones import
 * lives here, so matcher.ts, runner.ts, vault/ and seal/ never import each other for a type.
 */

export const SCENARIO_KINDS = ["behavior", "nfr", "contradiction_canary"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];
/** nfr is refused at intake: a latency scenario would be fake coverage of a quantitative decision. */
export type StoredKind = Exclude<ScenarioKind, "nfr">;
export const SCENARIO_SPLITS = ["train", "test"] as const;
export type ScenarioSplit = (typeof SCENARIO_SPLITS)[number];
export const SCENARIO_STATUSES = ["active", "retired", "contaminated"] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

/** Releases of one split digest after which GATE-2 refuses the set. The feedback layer counts, the vault only compares. */
export const EXPOSURE_LIMIT = 20;
export const MAX_SCENARIOS_PER_SET = 100;
export const MAX_STEPS = 12;
export const MAX_SCENARIO_BYTES = 64 * 1024;
export const MAX_AUTHOR_OUTPUT_BYTES = 1024 * 1024;
export const SCENARIO_ID_PATTERN = /^s-[0-9a-f]{32}$/;
export const CANARY_PATTERN = /^omf-canary-[0-9a-f]{32}$/;
/** Unanchored on purpose: the poka-yoke and the audit scans look for a canary inside file text. */
export const CANARY_SEARCH = /omf-canary-[0-9a-f]{32}/;
export const SCENARIO_REF_PATTERN = /^[0-9a-f]{16}$/;

export interface CliInvoke {
  argv: string[];
  stdin: string;
}
export type JsonScalar = string | number | boolean | null;
/** Typed on purpose: the spec shows a bare string, which cannot say exact from pattern. */
export type StdoutMatch = { kind: "exact"; text: string } | { kind: "anchored"; pattern: string };
/** At least one of exit_code, stdout_matches and json_path is non-null (schema and lint `expect_empty`). `note` is assertion text; OMF prefixes the canary. */
export interface Expect {
  exit_code: number | null;
  stdout_matches: StdoutMatch | null;
  json_path: Record<string, JsonScalar> | null;
  note: string;
}
export interface ScenarioStep {
  invoke: CliInvoke;
  expect: Expect;
}
export type AuthorIsolation = "host_command" | "container";
/** isolation is OMF's statement about the session; downstream evidence reports the author stage as unmeasured when it is host_command. */
export interface AuthorStamp {
  vendor: string;
  model: string;
  at: string;
  isolation: AuthorIsolation;
}

export type RefusalCode =
  | "candidate_needs_container"
  | "unknown_fixture"
  | "fixture_hash_mismatch"
  | "fixture_missing"
  | "fixture_not_regular_file"
  | "fixture_outside_dir";

/**
 * What one step did, as the runner saw it. The adapter never sees the expectation, so the same
 * evaluateExpect judges a host fixture, a harness container and a laptop run.
 */
export type StepObservation =
  | { outcome: "exited"; exit_code: number; stdout: string }
  // Ended by a signal: the exit status is null, never mapped to an exit_code, never a pass.
  | { outcome: "signaled"; signal: string }
  // "error" includes stdout that is not valid UTF-8 (decoded with fatal: true).
  | { outcome: "timeout" | "output_limit" | "error" }
  | { outcome: "refused"; code: RefusalCode };

export type AuthorFailureCode =
  | "timeout"
  | "spawn_failed"
  | "nonzero_exit"
  | "no_output"
  | "output_limit"
  | "misconfigured"
  // A container author (spec §5.3, §7): the container measured below its golden, could not be made or fed, or the
  // answer held the key. None is an author-quality failure, so none is retried.
  | "not_golden"
  | "container_failed"
  | "credential_in_output";
/** Ids and plain counts only; no scenario id, ref or text can be expressed in this type. */
export interface SealFeedback {
  unlinked_decision_ids: readonly string[];
  weak: number;
  contradictions: number;
  invalid: number;
}

/**
 * What a stored scenario file holds. No status and no exposure count: the effective status is the
 * ledger's (default "active") and the limit is EXPOSURE_LIMIT, so editing a file can neither
 * loosen a check nor retire a scenario. The whole file is covered by set_sha256.
 */
export interface StoredScenario {
  schema_version: 1;
  scenario_id: string;
  work_id: string;
  author: AuthorStamp;
  decision_refs: string[];
  kind: StoredKind;
  split: ScenarioSplit;
  interface: "cli";
  steps: ScenarioStep[];
  canary: string;
}

/** First 16 hex of sha256(scenario_id): the only scenario handle that reaches the ledger. */
export function scenarioRef(scenarioId: string): string {
  return sha256Hex(scenarioId).slice(0, 16);
}

export function isCanaryKind(scenario: { kind: StoredKind }): boolean {
  return scenario.kind === "contradiction_canary";
}
