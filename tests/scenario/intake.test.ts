import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDef } from "../../src/core/schema.js";
import { INTAKE_REJECTION_CODES, intakeAuthored, randomIds } from "../../src/scenario/intake.js";
import type { IntakeRejectionCode, IntakeResult } from "../../src/scenario/intake.js";
import { CANARY_PATTERN, SCENARIO_ID_PATTERN } from "../../src/scenario/types.js";
import { AUTHOR, WORK_ID, authoredScenario, authoredYaml, fakeIds, intakeContext } from "../helpers/scenario-fixture.js";

const oneStep = (expectation: Record<string, unknown>) => [{ invoke: { argv: ["a"] }, expect: expectation }];
/** The codes with a non-zero count, so a test says both "this one" and "no other". */
const codesOf = (result: IntakeResult): IntakeRejectionCode[] => INTAKE_REJECTION_CODES.filter((code) => result.rejected[code] > 0);

describe("intakeAuthored: stamping", () => {
  it("turns a multi-document stream into stamped scenarios", () => {
    const canaryDoc = authoredScenario({
      kind: "contradiction_canary",
      split: "test",
      decision_refs: [],
      steps: [{ invoke: { argv: ["add", "milk"] }, expect: { stdout_matches: { kind: "exact", text: "" }, json_path: { "$.items": 1 } } }],
    });
    const result = intakeAuthored(authoredYaml(authoredScenario(), canaryDoc), intakeContext());
    expect(result.authored).toBe(2);
    expect(codesOf(result)).toEqual([]);
    expect(result.ignored_fields).toBe(0);
    const first = result.stored[0];
    const second = result.stored[1];
    if (!first || !second) throw new Error("expected two stored scenarios");

    expect(first).toMatchObject({ schema_version: 1, work_id: WORK_ID, interface: "cli", kind: "behavior", split: "train", decision_refs: ["d-add"] });
    expect(first.author).toEqual(AUTHOR);
    expect(first.author.isolation).toBe("host_command");
    expect(first.steps).toEqual([
      {
        invoke: { argv: ["add", "milk"], stdin: "" },
        expect: { exit_code: 0, stdout_matches: { kind: "exact", text: "added milk\n" }, json_path: null, note: `${first.canary} adding prints the item` },
      },
    ]);
    expect(second).toMatchObject({ kind: "contradiction_canary", split: "test", decision_refs: [] });
    // No note from the author: the canary alone is the note.
    expect(second.steps[0]?.expect).toEqual({ exit_code: null, stdout_matches: { kind: "exact", text: "" }, json_path: { "$.items": 1 }, note: second.canary });

    for (const scenario of result.stored) {
      expect(validateDef("scenario.schema.json", "stored_scenario", scenario)).toEqual({ ok: true });
      expect(Object.keys(scenario)).not.toContain("status");
      expect(Object.keys(scenario)).not.toContain("exposure");
      // M3c-D3: the canary is in the header and the note, never in what the implementation is run with.
      expect(JSON.stringify(scenario.steps.map((step) => step.invoke))).not.toContain(scenario.canary);
    }
    expect(first.scenario_id).not.toBe(second.scenario_id);
    expect(first.canary).not.toBe(second.canary);
  });

  it("draws ids only for scenarios that survive", () => {
    const stream = authoredYaml(authoredScenario({ kind: "weird" }), authoredScenario());
    const result = intakeAuthored(stream, intakeContext());
    expect(result.stored).toHaveLength(1);
    const expected = fakeIds();
    expect(result.stored[0]?.scenario_id).toBe(expected.scenarioId());
    expect(result.stored[0]?.canary).toBe(expected.canary());
  });

  it("generates random ids that match their patterns and never repeat", () => {
    const ids = randomIds();
    const scenarioIds = Array.from({ length: 200 }, () => ids.scenarioId());
    const canaries = Array.from({ length: 200 }, () => ids.canary());
    expect(scenarioIds.every((id) => SCENARIO_ID_PATTERN.test(id))).toBe(true);
    expect(canaries.every((canary) => CANARY_PATTERN.test(canary))).toBe(true);
    expect(new Set(scenarioIds).size).toBe(200);
    expect(new Set(canaries).size).toBe(200);
    expect(ids.sealId()).toMatch(/^seal-[0-9a-f]{16}$/);
  });

  it("drops the keys OMF owns, counts them, and stamps its own values", () => {
    const owned = authoredScenario({
      author: { vendor: "evil", model: "x", at: "2020-01-01T00:00:00Z", isolation: "container" },
      scenario_id: "s-evil",
      canary: "omf-canary-evil",
      exposure: 99,
      status: "retired",
      work_id: "w-evil",
      schema_version: 9,
    });
    const result = intakeAuthored(authoredYaml(owned), intakeContext());
    expect(codesOf(result)).toEqual([]);
    expect(result.ignored_fields).toBe(7);
    const stored = result.stored[0];
    expect(stored?.author).toEqual(AUTHOR);
    expect(stored?.work_id).toBe(WORK_ID);
    expect(stored?.schema_version).toBe(1);
    expect(stored?.scenario_id).toMatch(SCENARIO_ID_PATTERN);
    expect(stored?.canary).toMatch(CANARY_PATTERN);
    expect(Object.keys(stored ?? {})).not.toContain("status");
    expect(Object.keys(stored ?? {})).not.toContain("exposure");
  });

  it("throws, instead of storing, when OMF's own ids do not make a valid stored scenario", () => {
    const broken = intakeContext({ ids: { ...fakeIds(), canary: () => "bad-canary" } });
    expect(() => intakeAuthored(authoredYaml(authoredScenario()), broken)).toThrow(/stamped scenario is not a stored_scenario/);
  });
});

describe("intakeAuthored: refusals", () => {
  const manyDocuments = authoredYaml(
    ...Array.from({ length: 101 }, (_, i) => authoredScenario({ steps: [{ invoke: { argv: [`n${i}`] }, expect: { exit_code: 0 } }] })),
  );

  it.each<{ name: string; output: string; code: IntakeRejectionCode; stored?: number }>([
    { name: "malformed YAML", output: "a: [\n", code: "yaml_invalid" },
    { name: "an alias", output: "a: &x 1\nb: *x\n", code: "yaml_invalid" },
    { name: "a duplicate key", output: "kind: behavior\nkind: nfr\n", code: "yaml_invalid" },
    { name: "an unknown key", output: authoredYaml(authoredScenario({ bogus: 1 })), code: "schema_invalid" },
    { name: "a kind outside the enum", output: authoredYaml(authoredScenario({ kind: "weird" })), code: "schema_invalid" },
    { name: "interface http", output: authoredYaml(authoredScenario({ interface: "http" })), code: "http_not_supported" },
    {
      name: "an http invoke in a cli scenario",
      output: authoredYaml(authoredScenario({ steps: [{ invoke: { method: "GET", path: "/" }, expect: { exit_code: 0 } }] })),
      code: "http_not_supported",
    },
    { name: "kind nfr", output: authoredYaml(authoredScenario({ kind: "nfr" })), code: "nfr_not_supported" },
    { name: "an nfr_probe", output: authoredYaml(authoredScenario({ nfr_probe: { p99_ms: 5 } })), code: "nfr_not_supported" },
    {
      name: "an anchored pattern outside the grammar",
      output: authoredYaml(authoredScenario({ steps: oneStep({ stdout_matches: { kind: "anchored", pattern: "^(a+)+$" } }) })),
      code: "pattern_unsupported",
    },
    { name: "a json_path outside the grammar", output: authoredYaml(authoredScenario({ steps: oneStep({ json_path: { "$..x": 1 } }) })), code: "json_path_unsupported" },
    { name: "an expectation that is only a note", output: authoredYaml(authoredScenario({ steps: oneStep({ note: "only a note" }) })), code: "expect_empty" },
    { name: "an expectation of explicit nulls", output: authoredYaml(authoredScenario({ steps: oneStep({ exit_code: null, stdout_matches: null, json_path: null }) })), code: "expect_empty" },
    { name: "a repeated document", output: authoredYaml(authoredScenario(), authoredScenario()), code: "duplicate_document", stored: 1 },
    { name: "a document above the size limit", output: authoredYaml(authoredScenario({ pad: "x".repeat(70_000) })), code: "too_large" },
    { name: "a stream above the output limit", output: "x".repeat(1024 * 1024 + 1), code: "too_large" },
    { name: "more scenarios than a set may hold", output: manyDocuments, code: "too_many", stored: 100 },
  ])("refuses $name with exactly one count", ({ output, code, stored }) => {
    const result = intakeAuthored(output, intakeContext());
    expect(codesOf(result)).toEqual([code]);
    expect(result.rejected[code]).toBe(1);
    expect(result.stored).toHaveLength(stored ?? 0);
  });

  it("returns an empty result for an empty stream", () => {
    const result = intakeAuthored("", intakeContext());
    expect(result).toMatchObject({ stored: [], authored: 0, ignored_fields: 0 });
    expect(codesOf(result)).toEqual([]);
  });

  it("never echoes the text of a rejected document", () => {
    const secret = "ZQ-SECRET-TEXT-9";
    const outputs = [
      authoredYaml(authoredScenario({ kind: secret })),
      authoredYaml(authoredScenario({ steps: oneStep({ note: secret }) })),
      authoredYaml(authoredScenario({ steps: [{ invoke: { argv: [secret] }, expect: { stdout_matches: { kind: "anchored", pattern: `^(${secret})+$` } } }] })),
      `${secret}: [\n`,
    ];
    for (const output of outputs) {
      const result = intakeAuthored(output, intakeContext());
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.stored).toEqual([]);
    }
  });
});

describe("intake source", () => {
  it("builds no RegExp from scenario data (M3-D5)", () => {
    const source = readFileSync(new URL("../../src/scenario/intake.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bRegExp\b/);
  });
});
