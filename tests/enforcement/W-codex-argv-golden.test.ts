import { describe, expect, it } from "vitest";
import { codexArgv } from "../../src/author/codex-argv.js";

// covers: S5.3.author-one-shot-ephemeral
// W-codex-argv-golden: the argv of the sealing author is pinned byte for byte. A change to it is a reviewed change to
// what runs inside the author container, so it changes this test in the same commit.
const BASE = [
  "codex",
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--color",
  "never",
  "-s",
  "read-only",
  "--output-schema",
  "/agent/answer.schema.json",
  "-o",
  "/out/answer.json",
  "-C",
  "/in",
];

describe("W-codex-argv-golden", () => {
  it("is exactly the pinned one-shot ephemeral exec with the prompt on stdin", () => {
    expect(codexArgv({ model: null })).toEqual([...BASE, "-"]);
    expect(codexArgv({ model: "gpt-5-codex" })).toEqual([...BASE, "-m", "gpt-5-codex", "-"]);
  });

  it("holds no key name and no host path", () => {
    expect(JSON.stringify(codexArgv({ model: "gpt-5-codex" }))).not.toMatch(/API_KEY|TOKEN|SECRET/);
    const paths = codexArgv({ model: null }).filter((part) => part.startsWith("/"));
    expect(paths.sort()).toEqual(["/agent/answer.schema.json", "/in", "/out/answer.json"]);
  });
});
