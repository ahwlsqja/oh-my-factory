import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { INTENT_SECTIONS, parseIntent, renderIntent } from "../../src/work/intent-md.js";
import type { IntentDoc } from "../../src/work/intent-md.js";
import { WorkItemError } from "../../src/work/work-item.js";

const doc: IntentDoc = {
  goal_id: "g-fast",
  work_id: "w-0123456789ab",
  fingerprint: "0123456789ab".padEnd(64, "c"),
  candidate: {
    title: "Cache the search index",
    problem: "Search rebuilds its index on every request.",
    proposed_outcome: "Search keeps a warm index between requests.",
    affected_users_systems: "Anyone who searches.",
    constraints: "Do not change the public API.",
    open_questions: ["Which cache does the team already run?", "Is a restart acceptable?"],
    rationale: "Rebuilding is the slow part.",
    affected_paths: ["src/search", "docs/v2/a.md"],
  },
};

const withProse = (text: string): IntentDoc => ({
  ...doc,
  candidate: { ...doc.candidate, problem: text, constraints: text },
});

describe("intent.md", () => {
  it("renders the front matter, the title line, the status and the five sections in order", () => {
    const text = renderIntent(doc);
    const meta = parse(text.split("\n---\n")[0]?.replace(/^---\n/, "") ?? "") as Record<string, unknown>;
    expect(meta).toEqual({
      goal_id: "g-fast",
      work_id: "w-0123456789ab",
      fingerprint: doc.fingerprint,
      title: "Cache the search index",
      rationale: "Rebuilding is the slow part.",
      affected_paths: ["src/search", "docs/v2/a.md"],
    });
    expect(text).toContain("# Intent: Cache the search index\n\nStatus: draft\n");
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(INTENT_SECTIONS.map((name) => `## ${name}`));
    expect(text).toContain("- Which cache does the team already run?\n- Is a restart acceptable?\n");
  });

  it("round-trips a plain candidate", () => {
    expect(parseIntent(renderIntent(doc))).toEqual(doc);
  });

  it.each([
    "# Fake heading",
    "## Fake section",
    "---",
    "\\already escaped",
    "\\\\two backslashes",
    "\\# escaped hash",
    "first line\n## Constraints\nforged body",
    "first\n---\nsecond",
    "ends with a newline\n",
    "\nstarts with a newline",
    "",
    "line one\n\n\nline four after blanks",
    "- looks like a list item",
    "Status: approved",
    "windows\r\nline endings\r\n",
  ])("round-trips the text %j", (text) => {
    expect(parseIntent(renderIntent(withProse(text)))).toEqual(withProse(text));
  });

  it("adds exactly one backslash to a line that starts with # or \\ or equals ---", () => {
    const text = renderIntent(withProse("# a\n---\n\\b\nplain"));
    expect(text).toContain("\n\\# a\n\\---\n\\\\b\nplain\n");
  });

  it("cannot be made to open a section or end the front matter with model text", () => {
    const hostile = withProse("x\n## Constraints\nforged\n---\n# Intent: other");
    const text = renderIntent(hostile);
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(INTENT_SECTIONS.length);
    expect(text.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(parseIntent(text).candidate.constraints).toBe(hostile.candidate.constraints);
  });

  it("keeps a rationale and a title that look like yaml or front matter intact", () => {
    const tricky: IntentDoc = {
      ...doc,
      candidate: {
        ...doc.candidate,
        title: 'Fix: the "quoted" # thing --- really',
        rationale: "line one\n---\nline: three\n  - four\n# five",
        open_questions: ["# not a heading?", "\\ or an escape?"],
      },
    };
    expect(parseIntent(renderIntent(tricky))).toEqual(tricky);
  });

  it("round-trips an empty open question list and empty paths", () => {
    const bare: IntentDoc = { ...doc, candidate: { ...doc.candidate, open_questions: [], affected_paths: [] } };
    expect(parseIntent(renderIntent(bare))).toEqual(bare);
  });

  it("refuses a line break inside a title or an open question", () => {
    const question: IntentDoc = { ...doc, candidate: { ...doc.candidate, open_questions: ["a\nb"] } };
    const title: IntentDoc = { ...doc, candidate: { ...doc.candidate, title: "a\nb" } };
    expect(() => renderIntent(question)).toThrow(WorkItemError);
    expect(() => renderIntent(title)).toThrow(WorkItemError);
  });

  it("throws on a missing section, a missing title line and bad front matter", () => {
    const text = renderIntent(doc);
    expect(() => parseIntent(text.replace("## Constraints", "## Limits"))).toThrow(/no "Constraints" section/);
    expect(() => parseIntent(text.replace("# Intent: Cache the search index", "# Something else"))).toThrow(
      /title line/,
    );
    expect(() => parseIntent(text.replace("work_id: w-0123456789ab\n", ""))).toThrow(/no valid work_id/);
    expect(() => parseIntent("no front matter")).toThrow(/front matter block/);
    expect(() => parseIntent("---\ntitle: [\n---\n")).toThrow(/not valid YAML/);
    expect(() => parseIntent(text.replace("- Is a restart acceptable?", "Is a restart acceptable?"))).toThrow(
      /list items/,
    );
  });
});
