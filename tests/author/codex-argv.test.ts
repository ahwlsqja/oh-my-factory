import { describe, expect, it } from "vitest";
import {
  ANSWER_SCHEMA,
  ANSWER_SCHEMA_TEXT,
  CodexArgvError,
  OUTPUT_SUFFIX,
  codexArgv,
} from "../../src/author/codex-argv.js";
import { buildSealPrompt } from "../../src/seal/prompt.js";
import { SESSION_INPUTS } from "../helpers/seal-fixture.js";

describe("answer envelope", () => {
  it("forces one string field and nothing else", () => {
    expect(ANSWER_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["scenarios_yaml"],
      properties: { scenarios_yaml: { type: "string" } },
    });
    expect(JSON.parse(ANSWER_SCHEMA_TEXT)).toEqual(ANSWER_SCHEMA);
  });

  it("names the field and replaces a sentence the prompt really contains", () => {
    expect(OUTPUT_SUFFIX.startsWith("\n")).toBe(true);
    expect(OUTPUT_SUFFIX).toContain("scenarios_yaml");
    expect(OUTPUT_SUFFIX).toContain("replaced");
    expect(buildSealPrompt(SESSION_INPUTS)).toContain("Print nothing else");
  });
});

describe("codexArgv model", () => {
  it("passes a model as one value after -m, and none by default", () => {
    expect(codexArgv({ model: "gpt-5-codex" }).slice(-3)).toEqual(["-m", "gpt-5-codex", "-"]);
    expect(codexArgv({ model: null })).not.toContain("-m");
  });

  it.each(["--yolo", "-x", "a b", "", "x".repeat(81), "m;rm", "m\n"])("refuses the model %j", (model) => {
    expect(() => codexArgv({ model })).toThrow(CodexArgvError);
  });
});
