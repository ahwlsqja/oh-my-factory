import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GoalFileError,
  SEMANTIC_FIELDS,
  createGoal,
  goalTemplate,
  parseGoal,
  readGoal,
  referencedMetrics,
  semanticHash,
} from "../../src/goal/goal-file.js";
import { makeTempDir } from "../helpers/tmp.js";

describe("goal.md", () => {
  it("parses the template", () => {
    const doc = parseGoal(goalTemplate("g-fast-search"));
    expect(doc.front.goal_id).toBe("g-fast-search");
    expect(doc.front.target).toEqual({ metric_id: "m-replace-me", operator: "<=", value: 0, unit: "ms" });
    expect(doc.body).toContain("## Approach");
  });

  it("rejects a file without front matter, invalid YAML, or a schema violation", () => {
    expect(() => parseGoal("# no front matter\n")).toThrow(/front matter block/);
    expect(() => parseGoal("---\ntarget: [\n---\n")).toThrow(/not valid YAML/);
    expect(() => parseGoal(goalTemplate("g-a").replace('operator: "<="', 'operator: "<"'))).toThrow(/is invalid/);
  });

  it("hashes only the fields J1 locks", () => {
    const front = parseGoal(goalTemplate("g-a")).front;
    const base = semanticHash(front);
    const reworded = { ...front, title: "another title", objective: "reworded" };
    expect(semanticHash(reworded)).toBe(base);
    expect(semanticHash({ ...front, target: { ...front.target, value: 5 } })).not.toBe(base);
    expect(semanticHash({ ...front, guardrails: ["m-errors"] })).not.toBe(base);
  });

  it("changes the hash when any locked field changes", () => {
    const front = parseGoal(goalTemplate("g-a")).front;
    const base = semanticHash(front);
    const changed = {
      target: { ...front.target, operator: ">=" as const },
      leading: ["m-cache-hits"],
      lagging: ["m-other"],
      link_hypothesis: "a different hypothesis",
      guardrails: ["m-errors"],
      prereg: { ...front.prereg, metrics_judged: 2 },
      mode: "watch" as const,
      budget: { ...front.budget, rounds: 11 },
    };
    expect(Object.keys(changed).sort()).toEqual([...SEMANTIC_FIELDS].sort());
    for (const field of SEMANTIC_FIELDS) {
      expect(semanticHash({ ...front, [field]: changed[field] }), field).not.toBe(base);
    }
  });

  it("lists every referenced metric once, target first", () => {
    const front = {
      ...parseGoal(goalTemplate("g-a")).front,
      leading: ["m-cache-hits"],
      guardrails: ["m-errors", "m-replace-me"],
    };
    expect(referencedMetrics(front)).toEqual(["m-replace-me", "m-cache-hits", "m-errors"]);
  });

  it("parses a goal.md saved with CRLF line endings", () => {
    const crlf = goalTemplate("g-a").replace(/\n/g, "\r\n");
    expect(parseGoal(crlf).front.goal_id).toBe("g-a");
  });

  it("creates a goal once, private to the owner", () => {
    const dir = makeTempDir();
    const file = createGoal(dir, "g-a");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(dirname(file)).mode & 0o777).toString(8)).toBe("700");
    expect(readGoal(dir, "g-a").front.goal_id).toBe("g-a");
    expect(() => createGoal(dir, "g-a")).toThrow(/already exists/);
  });

  it("rejects bad ids, a missing goal, and a goal_id that does not match its directory", () => {
    const dir = makeTempDir();
    expect(() => createGoal(dir, "Goal A")).toThrow(GoalFileError);
    expect(() => readGoal(dir, "g-missing")).toThrow(/not found/);
    const file = createGoal(dir, "g-a");
    writeFileSync(file, readFileSync(file, "utf8").replace("goal_id: g-a", "goal_id: g-b"));
    expect(() => readGoal(dir, "g-a")).toThrow(/declares goal_id g-b/);
  });
});
