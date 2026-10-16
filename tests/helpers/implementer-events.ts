import type { CandidateFacts, ImplementerScope, SessionFacts } from "../../src/implementer/events.js";

export const SCOPE: ImplementerScope = {
  goal_id: "g-fast",
  work_id: "w-0123456789ab",
  run_id: "r-20261014T090000Z-ab12",
};
export const [SHA_A, SHA_B, SHA_C, SHA_D] = ["a", "b", "c", "d"].map((c) => c.repeat(40)) as [
  string,
  string,
  string,
  string,
];

export const SESSION_FACTS: SessionFacts = {
  round: 1,
  vendor: "stub",
  model: null,
  outcome: "completed",
  duration_ms: 1200,
  image_id: `sha256:${"1".repeat(64)}`,
  prompt_sha256: "2".repeat(64),
  settings_sha256: "3".repeat(64),
  log_sha256: "4".repeat(64),
  log_bytes: 2048,
  cost_micro_usd: null,
  workspace: "captured",
  log_credential_hits: 0,
  injected_secret_names: ["ANTHROPIC_API_KEY"],
};

export const CANDIDATE_FACTS: CandidateFacts = {
  round: 1,
  head_sha: SHA_B,
  context_sha: SHA_A,
  commits: 2,
  plan: "ok",
  plan_why: null,
  request: "none",
  scan: "clean",
  import_failure: null,
  published: true,
};
