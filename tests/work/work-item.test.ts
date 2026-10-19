// covers: F1.goal-is-top-unit
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";
import type { WorkItemFront } from "../../src/work/types.js";
import {
  FORBIDDEN_KEYS,
  WorkItemError,
  findForbiddenKey,
  parseWorkItem,
  renderWorkItem,
  validateWorkItem,
} from "../../src/work/work-item.js";

const front: WorkItemFront = {
  schema_version: 1,
  work_id: "w-0123456789ab",
  goal_id: "g-fast",
  title: "Cache the search index",
  state: "awaiting_approval",
  fingerprint: "0123456789ab".padEnd(64, "c"),
  risk: { class: "high", rules: ["test", "watched-path"], paths: ["tests/search.test.ts"] },
  affected_paths: ["src/search", "tests/search.test.ts"],
  has_open_questions: true,
  origin: { kind: "reconcile", tick_id: "t-20261012T093000Z-a1b2", trigger: "both" },
  created_at: "2026-10-12T09:30:00.000Z",
  updated_at: "2026-10-12T09:30:00.000Z",
  approval: null,
  veto: null,
};

describe("work item schema", () => {
  it("accepts a well-formed front matter, with and without an approval and a veto", () => {
    expect(validate("work-item.schema.json", front)).toEqual({ ok: true });
    const approved = {
      ...front,
      state: "ready",
      approval: { approved_by: "human:dev", approved_at: front.created_at },
    };
    expect(validate("work-item.schema.json", approved).ok).toBe(true);
    const vetoed = {
      ...front,
      state: "vetoed",
      veto: { vetoed_by: "human:dev", vetoed_at: front.created_at, reason: "no" },
    };
    expect(validate("work-item.schema.json", vetoed).ok).toBe(true);
  });

  it.each(["value", "threshold", "query"])("rejects a top-level %s with the dedicated rule text", (key) => {
    const result = validate("work-item.schema.json", { ...front, [key]: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors).toMatch(/must NOT be valid/);
  });

  it("rejects malformed ids, states, hashes and actors", () => {
    const bad = (patch: object): boolean => validate("work-item.schema.json", { ...front, ...patch }).ok;
    expect(bad({ work_id: "w-xyz" })).toBe(false);
    expect(bad({ fingerprint: "ABC" })).toBe(false);
    expect(bad({ state: "running" })).toBe(false);
    expect(bad({ origin: { ...front.origin, tick_id: "t-1" } })).toBe(false);
    expect(bad({ approval: { approved_by: "omf", approved_at: front.created_at } })).toBe(false);
    expect(bad({ veto: { vetoed_by: "human:dev", vetoed_at: front.created_at, reason: "x".repeat(501) } })).toBe(false);
    expect(bad({ risk: { class: "high", rules: ["test", "test"], paths: [] } })).toBe(false);
    expect(bad({ risk: { class: "high", rules: ["metric-m-p95"], paths: [] } })).toBe(false);
    expect(bad({ title: "two\nlines" })).toBe(false);
  });
});

describe("findForbiddenKey", () => {
  it("lists the keys that can carry a value, a target or a query", () => {
    expect([...FORBIDDEN_KEYS].sort()).toEqual(
      ["baseline", "measured", "metric", "query", "sigma", "target", "threshold", "value"].sort(),
    );
  });

  it("finds a forbidden key at any depth, in any case, and returns its path", () => {
    expect(findForbiddenKey({ a: { b: [{ Target: 1 }] } })).toBe("a.b[0].Target");
    expect(findForbiddenKey({ origin: { kind: "reconcile", SIGMA: 3 } })).toBe("origin.SIGMA");
    expect(findForbiddenKey(front)).toBeNull();
  });

  it("looks at keys only, not at values", () => {
    expect(findForbiddenKey({ title: "the value of the target" })).toBeNull();
    expect(findForbiddenKey(["value", { note: "query" }])).toBeNull();
  });
});

describe("validateWorkItem", () => {
  it("returns a valid front matter", () => {
    expect(validateWorkItem(front)).toEqual(front);
  });

  it("rejects a schema violation with the schema text", () => {
    expect(() => validateWorkItem({ ...front, state: "running" })).toThrow(WorkItemError);
    expect(() => validateWorkItem({ ...front, state: "running" })).toThrow(/front matter is invalid/);
  });

  it("rejects a nested forbidden key (the schema already refuses it too)", () => {
    expect(() => validateWorkItem({ ...front, origin: { ...front.origin, target: 1 } })).toThrow(WorkItemError);
  });
});

describe("item.md", () => {
  it("round-trips front matter and progress", () => {
    const text = renderWorkItem(front, "step 1 done\nstep 2 running\n");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("<!-- omf:progress -->\nstep 1 done\nstep 2 running\n<!-- /omf:progress -->\n");
    expect(parseWorkItem(text)).toEqual({ front, progress: "step 1 done\nstep 2 running\n" });
  });

  it("round-trips an empty progress region", () => {
    expect(parseWorkItem(renderWorkItem(front, "")).progress).toBe("");
  });

  it("adds the trailing newline a progress text lacks", () => {
    expect(parseWorkItem(renderWorkItem(front, "one line")).progress).toBe("one line\n");
  });

  it("refuses progress text that holds a marker", () => {
    expect(() => renderWorkItem(front, "x <!-- /omf:progress --> y")).toThrow(/markers/);
  });

  it("parses nothing but a validated front matter", () => {
    const text = renderWorkItem(front, "");
    expect(() => parseWorkItem("no front matter")).toThrow(/front matter block/);
    expect(() => parseWorkItem(text.replace("state: awaiting_approval", "state: running"))).toThrow(/is invalid/);
    expect(() => parseWorkItem(text.replace("<!-- /omf:progress -->\n", ""))).toThrow(/no progress region/);
    expect(() => parseWorkItem("---\nstate: [\n---\n")).toThrow(/not valid YAML/);
  });
});
