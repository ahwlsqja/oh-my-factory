import { describe, expect, it } from "vitest";
import {
  type AuthorSessionFacts,
  authorSessionCompletedEvent,
  authorSessionStartedEvent,
} from "../../src/author/events.js";
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

describe("authorSessionCompletedEvent: the caps", () => {
  it("carries the limits and counts, and refuses a negative or fractional one", () => {
    const event = authorSessionCompletedEvent(AUTHOR_SCOPE, AUTHOR_FACTS);
    expect(event.payload).toMatchObject({ limit_calls: 10, calls_before: 0, output_bytes: 28 });
    for (const field of ["output_bytes", "limit_timeout_ms", "limit_output_bytes", "limit_calls", "calls_before"]) {
      expect(() => authorSessionCompletedEvent(AUTHOR_SCOPE, bad({ [field]: -1 }))).toThrow(/schema/);
      expect(() => authorSessionCompletedEvent(AUTHOR_SCOPE, bad({ [field]: 1.5 }))).toThrow(/schema/);
    }
  });
});

describe("authorSessionStartedEvent", () => {
  const started = { pass_id: AUTHOR_FACTS.pass_id, round: 1, calls_before: 0, limit_calls: 10 };

  it("builds an omf event with the scope and the pass id", () => {
    expect(authorSessionStartedEvent(AUTHOR_SCOPE, started)).toEqual({
      actor: "omf",
      type: "author.session_started",
      payload: { ...AUTHOR_SCOPE, ...started },
    });
  });

  it.each([{ pass_id: "not-a-pass" }, { round: 0 }, { calls_before: -1 }, { extra: "x" }])(
    "rejects a malformed payload %j",
    (change) => {
      expect(() => authorSessionStartedEvent(AUTHOR_SCOPE, { ...started, ...change })).toThrow(
        /author.session_started/,
      );
    },
  );
});
