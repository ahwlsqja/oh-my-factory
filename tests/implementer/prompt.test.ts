import { describe, expect, it } from "vitest";
import { contextPaths, omfDir } from "../../src/implementer/context-files.js";
import { buildImplementerPrompt } from "../../src/implementer/prompt.js";

const ID = "w-0123456789ab";

describe("buildImplementerPrompt", () => {
  it("states the plan-first rule, the test rule and the request shape with the per-item paths", () => {
    const prompt = buildImplementerPrompt({ workId: ID, round: 1, feedback: [] });
    const { spec, intent } = contextPaths(ID);
    expect(prompt).toContain(intent);
    expect(prompt).toContain(spec);
    expect(prompt).toContain(`${omfDir(ID)}/plan.md`);
    expect(prompt).toMatch(/first commit[^\n]*only[^\n]*\.omf\/w-0123456789ab\/plan\.md/);
    expect(prompt).toMatch(/do not (edit|change)[^\n]*test/i);
    expect(prompt).toContain(`${omfDir(ID)}/request.json`);
    expect(prompt).toContain('"kind": "test_conflict" | "spec_conflict"');
    // Round 1: no feedback section and no claim about earlier rounds.
    expect(prompt).not.toMatch(/feedback/i);
    expect(prompt).not.toMatch(/round 2/i);
  });

  it("names no root-level context file and nothing the implementer must not know", () => {
    const prompt = buildImplementerPrompt({ workId: ID, round: 1, feedback: [] });
    // Every legitimate mention follows the `/` of `.omf/<id>/`; a bare root-level name would not.
    expect(prompt).not.toMatch(/(^|[\s`"'(])(spec|intent|plan)\.md/);
    for (const word of ["scenario", "vault", "canary", "dangerously", "ANTHROPIC", "API key"]) {
      expect(prompt.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("for round 2 and later adds exactly the released texts, verbatim and in order, in a text-independent frame", () => {
    const base = buildImplementerPrompt({ workId: ID, round: 2, feedback: [] });
    expect(base).toMatch(/round 2/i);
    const withTexts = (a: string, b: string) => buildImplementerPrompt({ workId: ID, round: 2, feedback: [a, b] });

    const first = withTexts("ALPHA text\nwith lines", "BETA");
    expect(first.startsWith(base)).toBe(true);
    const tail = first.slice(base.length);
    expect(tail.indexOf("ALPHA text\nwith lines")).toBeGreaterThan(-1);
    expect(tail.indexOf("BETA")).toBeGreaterThan(tail.indexOf("ALPHA text\nwith lines"));

    // Swap the texts: whatever is not the texts is identical, so nothing else is interpolated.
    const frame = (text: string, a: string, b: string) => text.replace(a, "@").replace(b, "@");
    expect(frame(first, "ALPHA text\nwith lines", "BETA")).toBe(frame(withTexts("GAMMA", "DELTA"), "GAMMA", "DELTA"));
  });

  it("ignores feedback in round 1, where the slot is empty by construction", () => {
    expect(buildImplementerPrompt({ workId: ID, round: 1, feedback: ["LEFTOVER"] })).toBe(
      buildImplementerPrompt({ workId: ID, round: 1, feedback: [] }),
    );
  });

  it("refuses an invalid work id, an invalid round and any extra input field", () => {
    expect(() => buildImplementerPrompt({ workId: "a/b", round: 1, feedback: [] })).toThrow();
    for (const round of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildImplementerPrompt({ workId: ID, round, feedback: [] })).toThrow("invalid_round");
    }
    const widened = { workId: ID, round: 1, feedback: [], scenarios: ["s1"] };
    expect(() => buildImplementerPrompt(widened)).toThrow("forbidden_prompt_input");
  });
});
