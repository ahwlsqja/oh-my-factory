import { describe, expect, it } from "vitest";
import { type AuthorSessionFacts, authorSessionCompletedEvent } from "../../src/author/events.js";
import { AUTHOR_FACTS, AUTHOR_SCOPE } from "../helpers/author-events.js";

const bad = (change: object): AuthorSessionFacts => ({ ...AUTHOR_FACTS, ...change }) as unknown as AuthorSessionFacts;

describe("authorSessionCompletedEvent", () => {
  it("builds an omf event with the scope, the facts and the name of the secret, never a value", () => {
    const event = authorSessionCompletedEvent(AUTHOR_SCOPE, AUTHOR_FACTS);
    expect(event).toEqual({
      actor: "omf",
      type: "author.session_completed",
      payload: { ...AUTHOR_SCOPE, ...AUTHOR_FACTS },
    });
  });

  it.each([
    "timeout",
    "spawn_failed",
    "nonzero_exit",
    "no_output",
    "output_limit",
    "misconfigured",
    "container_failed",
    "credential_in_output",
  ] as const)("accepts the outcome %s", (outcome) => {
    expect(() => authorSessionCompletedEvent(AUTHOR_SCOPE, { ...AUTHOR_FACTS, outcome })).not.toThrow();
  });

  it("takes violation codes exactly when the outcome is not_golden", () => {
    const refused = { ...AUTHOR_FACTS, outcome: "not_golden" as const, answer_sha256: null, answer_bytes: 0 };
    expect(() =>
      authorSessionCompletedEvent(AUTHOR_SCOPE, { ...refused, violation_codes: ["unexpected_env_name"] }),
    ).not.toThrow();
    expect(() => authorSessionCompletedEvent(AUTHOR_SCOPE, refused)).toThrow(/violation_codes/);
    expect(() =>
      authorSessionCompletedEvent(AUTHOR_SCOPE, { ...AUTHOR_FACTS, violation_codes: ["privileged"] }),
    ).toThrow(/violation_codes/);
  });

  it.each([
    ["an extra field that could carry text", bad({ log: "text" })],
    ["another secret name", bad({ injected_secret_names: ["ANTHROPIC_API_KEY"] })],
    ["a pass id that is not run shaped", bad({ pass_id: "r-1" })],
  ])("refuses %s", (_label, facts) => {
    expect(() => authorSessionCompletedEvent(AUTHOR_SCOPE, facts)).toThrow(/invalid author\.session_completed event/);
  });
});
