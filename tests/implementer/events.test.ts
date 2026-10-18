import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LedgerEvent, NewEvent } from "../../src/core/ledger.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import {
  baseFixedEvent,
  baseFixedOf,
  candidateCheckedEvent,
  publishedHeads,
  publishIntendedEvent,
  sessionCompletedEvent,
} from "../../src/implementer/events.js";
import type { ImportFailure } from "../../src/implementer/import.js";
import type { PlanWhy } from "../../src/implementer/plan.js";
import type { ImplementerFailureCode } from "../../src/implementer/session.js";
import { CANDIDATE_FACTS, SCOPE, SESSION_FACTS, SHA_A, SHA_B, SHA_C, SHA_D } from "../helpers/implementer-events.js";

const ITEM = { goal_id: SCOPE.goal_id, work_id: SCOPE.work_id };
const OTHER_ITEM = { ...SCOPE, work_id: "w-ba9876543210" };
const stored = (seq: number, actor: string, event: NewEvent): LedgerEvent => ({
  schema_version: 1,
  seq,
  prev_hash: "0".repeat(64),
  ts: "2026-10-16T09:00:00.000Z",
  actor,
  type: event.type,
  payload: event.payload,
  hash: "0".repeat(64),
});

describe("implementer events", () => {
  it("builds all four as actor omf, each valid against the closed schema", () => {
    const events = [
      baseFixedEvent(SCOPE, { base_sha: SHA_A, base_tree_sha: SHA_B }),
      sessionCompletedEvent(SCOPE, SESSION_FACTS),
      publishIntendedEvent(SCOPE, { round: 1, head_sha: SHA_C }),
      candidateCheckedEvent(SCOPE, CANDIDATE_FACTS),
    ];
    expect(events.map((event) => event.type)).toEqual([
      "implementer.base_fixed",
      "implementer.session_completed",
      "implementer.publish_intended",
      "implementer.candidate_checked",
    ]);
    for (const event of events) {
      expect(event.actor).toBe("omf");
      expect(validate("implementer-event.schema.json", { type: event.type, payload: event.payload })).toEqual({
        ok: true,
      });
    }
  });

  const checked = (over: object) => () => candidateCheckedEvent(SCOPE, { ...CANDIDATE_FACTS, ...over });
  const session = (over: object) => () => sessionCompletedEvent(SCOPE, { ...SESSION_FACTS, ...over } as never);
  const REJECTED: [string, () => unknown, RegExp][] = [
    ["free text in an unknown field", session({ note: "free text" }), /must NOT have additional properties/],
    ["a model outside its pattern", session({ model: "bad model!" }), /pattern/],
    ["a negative cost", session({ cost_micro_usd: -1 }), />= 0/],
    ["a secret name outside the closed set", session({ injected_secret_names: ["HOME"] }), /allowed values/],
    ["a short sha", () => baseFixedEvent(SCOPE, { base_sha: "abc123", base_tree_sha: SHA_B }), /pattern/],
    ["a plan reason while the plan is ok", checked({ plan_why: "plan_empty" }), /plan_why/],
    ["a published candidate without a head", checked({ head_sha: null }), /published candidate/],
    ["a published candidate whose scan found a canary", checked({ scan: "canary" }), /published candidate/],
  ];
  it.each(REJECTED)("refuses %s", (_name, build, message) => {
    expect(build).toThrow(/invalid implementer\.[a-z_]+ event/);
    expect(build).toThrow(message);
  });

  it("pins the closed lists in the schema to the code that owns them", () => {
    const { $defs } = JSON.parse(readFileSync(schemaUrl("implementer-event.schema.json"), "utf8")) as {
      $defs: Record<string, { enum?: string[] }>;
    };
    const why = ["no_commits", "first_commit_not_plan_only", "plan_empty", "plan_not_text"] satisfies PlanWhy[];
    const failures = [
      "bundle_invalid",
      "fsck_failed",
      "head_missing",
      "too_many_commits",
      "history_not_linear",
      "root_tree_mismatch",
      "context_mismatch",
    ] satisfies ImportFailure[];
    const outcomes = [
      "timeout",
      "spawn_failed",
      "nonzero_exit",
      "output_limit",
      "misconfigured",
    ] satisfies ImplementerFailureCode[];
    expect($defs.plan_why?.enum).toEqual(why);
    expect($defs.import_failure?.enum).toEqual(failures);
    expect($defs.session_outcome?.enum).toEqual(["completed", ...outcomes]);
    expect($defs.secret_name?.enum).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

describe("baseFixedOf", () => {
  const base = (sha: string, scope = SCOPE) => baseFixedEvent(scope, { base_sha: sha, base_tree_sha: SHA_B });

  it("returns the first schema-valid omf event of the item, and null when there is none", () => {
    expect(baseFixedOf([], ITEM)).toBeNull();
    expect(baseFixedOf([stored(1, "omf", base(SHA_A)), stored(2, "omf", base(SHA_C))], ITEM)).toEqual({
      base_sha: SHA_A,
      base_tree_sha: SHA_B,
    });
  });

  it("skips a forged actor, another item, another goal and an invalid payload", () => {
    const invalid: NewEvent = {
      actor: "omf",
      type: "implementer.base_fixed",
      payload: { ...base(SHA_D).payload, base_sha: "short" },
    };
    const events = [
      stored(1, "agent:x", base(SHA_D)),
      stored(2, "human:dev", base(SHA_D)),
      stored(3, "omf", base(SHA_D, OTHER_ITEM)),
      stored(4, "omf", base(SHA_D, { ...SCOPE, goal_id: "g-other" })),
      stored(5, "omf", invalid),
      stored(6, "omf", base(SHA_A)),
    ];
    expect(baseFixedOf(events, ITEM)).toEqual({ base_sha: SHA_A, base_tree_sha: SHA_B });
  });
});

describe("publishedHeads", () => {
  it("lists published and intended heads once each, in order, and nothing else", () => {
    const published = (head: string, yes: boolean): NewEvent =>
      candidateCheckedEvent(SCOPE, {
        ...CANDIDATE_FACTS,
        head_sha: head,
        published: yes,
        scan: yes ? "clean" : "credential",
      });
    const events = [
      stored(1, "omf", publishIntendedEvent(SCOPE, { round: 1, head_sha: SHA_A })),
      stored(2, "omf", published(SHA_A, true)),
      stored(3, "omf", publishIntendedEvent(SCOPE, { round: 2, head_sha: SHA_B })),
      stored(4, "omf", published(SHA_C, false)),
      stored(5, "omf", published(SHA_D, true)),
      stored(6, "agent:x", publishIntendedEvent(SCOPE, { round: 3, head_sha: SHA_C })),
      stored(7, "omf", publishIntendedEvent(OTHER_ITEM, { round: 1, head_sha: SHA_C })),
    ];
    expect(publishedHeads(events, ITEM)).toEqual([SHA_A, SHA_B, SHA_D]);
    expect(publishedHeads([], ITEM)).toEqual([]);
  });
});
