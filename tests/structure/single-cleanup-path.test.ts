import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// One container cleanup path: the tracked runtime registers the signal cleanup, so a module that creates containers
// goes through it and keeps no live set or registration of its own.
describe("judge round cleanup", () => {
  const source = readFileSync(new URL("../../src/judge/round.ts", import.meta.url), "utf8");

  it("creates its containers through the shared tracked runtime", () => {
    expect(source).toContain("trackRuntime(");
  });

  it("does not register a cleanup of its own", () => {
    expect(source).not.toContain("registerCleanup");
  });
});
