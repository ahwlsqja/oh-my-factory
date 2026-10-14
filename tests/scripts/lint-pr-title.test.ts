import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/lint-pr-title.mjs", import.meta.url));
const { lintPrTitle, ALLOWED_TYPES } = (await import(SCRIPT)) as {
  lintPrTitle: (title: unknown) => { ok: boolean; reason?: string };
  ALLOWED_TYPES: string[];
};

describe("lintPrTitle", () => {
  it.each([
    "feat: add status command",
    "fix(cli): handle empty ledger",
    "feat(adapters)!: drop the legacy flag",
    "chore(deps): bump yaml from 2.9.0 to 2.9.1",
    "ci: pin release-please to a commit",
    "docs(maintainers): describe the release flow",
    "revert: undo the schema change",
  ])("accepts %j", (title) => {
    expect(lintPrTitle(title)).toEqual({ ok: true });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["add status command", "form"],
    ["Feat: add status command", "form"],
    ["feat:add status command", "form"],
    ["feat(): add it", "form"],
    ["feat(Scope): add it", "form"],
    ["feature: add it", "Unknown type"],
    ["wip: add it", "Unknown type"],
    ["feat: add it.", "period"],
    [" feat: add it", "whitespace"],
    ["feat: add it\nBREAKING CHANGE: x", "single line"],
    [`feat: ${"x".repeat(100)}`, "longer"],
  ])("rejects %j", (title, reasonPart) => {
    const result = lintPrTitle(title);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(reasonPart);
  });

  it("rejects non-string input", () => {
    expect(lintPrTitle(undefined).ok).toBe(false);
  });

  it("allows every type that release-please groups", () => {
    for (const type of ["feat", "fix", "perf", "docs", "refactor", "test", "ci", "chore"]) {
      expect(ALLOWED_TYPES).toContain(type);
    }
  });
});

describe("scripts/lint-pr-title.mjs CLI", () => {
  const run = (title: string | undefined) =>
    spawnSync(process.execPath, [SCRIPT], {
      env: title === undefined ? { PATH: process.env.PATH ?? "" } : { PATH: process.env.PATH ?? "", PR_TITLE: title },
      encoding: "utf8",
    });

  it("exits 0 for a valid title read from PR_TITLE", () => {
    expect(run("fix(core): repair the hash chain").status).toBe(0);
  });

  it("exits 1 with a message for an invalid title", () => {
    const result = run("random words");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid PR title");
  });

  it("exits 1 when PR_TITLE is unset", () => {
    expect(run(undefined).status).toBe(1);
  });

  it("does not execute shell metacharacters in the title", () => {
    const result = run('fix: $(false) `id`');
    expect(result.status).toBe(0);
  });
});
