import { describe, expect, it } from "vitest";
import { validateDef } from "../../src/core/schema.js";
import type { StoredScenario } from "../../src/scenario/types.js";
import { authoredScenario, storedScenario } from "../helpers/scenario-fixture.js";

const authored = (doc: unknown) => validateDef("scenario.schema.json", "authored_scenario", doc);
const stored = (doc: unknown) => validateDef("scenario.schema.json", "stored_scenario", doc);
const step = (expectation: Record<string, unknown>) => ({ invoke: { argv: ["a"] }, expect: expectation });

describe("authored_scenario", () => {
  it("accepts what an author writes", () => {
    expect(authored(authoredScenario())).toEqual({ ok: true });
  });

  it("accepts OMF-owned keys with any value, nulls, an http invoke and kind nfr (intake counts and refuses them, the schema does not)", () => {
    const owned = {
      schema_version: 9,
      scenario_id: "s-x",
      work_id: "w-x",
      author: { a: 1 },
      canary: "c",
      exposure: 99,
      status: "retired",
    };
    expect(authored(authoredScenario(owned))).toEqual({ ok: true });
    const nulls = authoredScenario({ steps: [step({ exit_code: null, stdout_matches: null, json_path: null })] });
    expect(authored(nulls)).toEqual({ ok: true });
    const http = authoredScenario({
      interface: "http",
      steps: [{ invoke: { method: "GET", path: "/items" }, expect: { exit_code: 0 } }],
    });
    expect(authored(http)).toEqual({ ok: true });
    expect(authored(authoredScenario({ kind: "nfr", nfr_probe: { p99_ms: 5 } }))).toEqual({ ok: true });
  });

  it.each([
    { name: "an unknown key", doc: authoredScenario({ bogus: 1 }) },
    { name: "no steps", doc: authoredScenario({ steps: [] }) },
    {
      name: "thirteen steps",
      doc: authoredScenario({ steps: Array.from({ length: 13 }, () => step({ exit_code: 0 })) }),
    },
    {
      name: "a bare string stdout_matches (the spec's untyped form)",
      doc: authoredScenario({ steps: [step({ stdout_matches: "plain" })] }),
    },
    {
      name: "an argv element with a control character",
      doc: authoredScenario({ steps: [{ invoke: { argv: ["a\u0007b"] }, expect: { exit_code: 0 } }] }),
    },
    {
      name: "an argv element with a bidi override",
      doc: authoredScenario({ steps: [{ invoke: { argv: ["a‮b"] }, expect: { exit_code: 0 } }] }),
    },
    { name: "an empty argv", doc: authoredScenario({ steps: [{ invoke: { argv: [] }, expect: { exit_code: 0 } }] }) },
    { name: "an exit code above 255", doc: authoredScenario({ steps: [step({ exit_code: 256 })] }) },
    {
      name: "nine json_path entries",
      doc: authoredScenario({
        steps: [step({ json_path: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`$.k${i}`, i])) })],
      }),
    },
    { name: "a decision ref that is not a decision id", doc: authoredScenario({ decision_refs: ["D-Add"] }) },
    { name: "a repeated decision ref", doc: authoredScenario({ decision_refs: ["d-add", "d-add"] }) },
    { name: "a split other than train or test", doc: authoredScenario({ split: "validation" }) },
    {
      name: "a numeric stdin",
      doc: authoredScenario({ steps: [{ invoke: { argv: ["a"], stdin: 5 }, expect: { exit_code: 0 } }] }),
    },
  ])("refuses $name", ({ doc }) => {
    expect(authored(doc).ok).toBe(false);
  });
});

describe("stored_scenario", () => {
  it("accepts a complete stored scenario, with and without a note beyond the canary", () => {
    expect(stored(storedScenario())).toEqual({ ok: true });
    const base = storedScenario();
    const bare = storedScenario({
      steps: [{ invoke: base.steps[0]!.invoke, expect: { ...base.steps[0]!.expect, note: base.canary } }],
    });
    expect(stored(bare)).toEqual({ ok: true });
  });

  const base: StoredScenario = storedScenario();
  const goodStep = base.steps[0]!;
  it.each([
    { name: "a status field (status lives in the ledger, M3c-D9)", doc: { ...base, status: "active" } },
    { name: "an exposure field (the limit is a code constant, M3c-D9)", doc: { ...base, exposure: 0 } },
    { name: "an unknown top-level key", doc: { ...base, extra: true } },
    { name: "kind nfr (refused at intake, M3-D17)", doc: { ...base, kind: "nfr" } },
    { name: "interface http", doc: { ...base, interface: "http" } },
    { name: "a step without stdin", doc: { ...base, steps: [{ invoke: { argv: ["a"] }, expect: goodStep.expect }] } },
    {
      name: "a note that does not start with the canary",
      doc: { ...base, steps: [{ invoke: goodStep.invoke, expect: { ...goodStep.expect, note: "plain" } }] },
    },
    {
      name: "an expectation with nothing to check",
      doc: {
        ...base,
        steps: [
          {
            invoke: goodStep.invoke,
            expect: { ...goodStep.expect, exit_code: null, stdout_matches: null, json_path: null },
          },
        ],
      },
    },
    { name: "a malformed canary", doc: { ...base, canary: "omf-canary-short" } },
    { name: "a malformed scenario id", doc: { ...base, scenario_id: "s-1" } },
    {
      name: "an author stamp without isolation",
      doc: { ...base, author: { vendor: "command", model: "stub", at: base.author.at } },
    },
  ])("refuses $name", ({ doc }) => {
    expect(stored(doc).ok).toBe(false);
  });
});
