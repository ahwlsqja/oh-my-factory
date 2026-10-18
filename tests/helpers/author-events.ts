import type { AuthorSessionFacts } from "../../src/author/events.js";

export const AUTHOR_SCOPE = { goal_id: "g-fast", work_id: "w-0123456789ab" };

export const AUTHOR_FACTS: AuthorSessionFacts = {
  pass_id: "r-20261019T090000Z-ab12",
  round: 1,
  vendor: "codex",
  model: "gpt-5-codex",
  outcome: "completed",
  duration_ms: 4200,
  image_id: `sha256:${"1".repeat(64)}`,
  input_sha256: "2".repeat(64),
  violation_codes: [],
  answer_sha256: "3".repeat(64),
  answer_bytes: 2048,
  credential_hits: 0,
  injected_secret_names: ["CODEX_API_KEY"],
};
