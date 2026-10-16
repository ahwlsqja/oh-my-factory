import { describe, expect, it } from "vitest";
import type { AuditSurface } from "../../src/audit/canary-scan.js";
import { readCredential } from "../../src/implementer/credential.js";
import { scanWorkspace } from "../../src/implementer/station.js";

// The scan reads nothing without a canary, so one that appears nowhere in the planted chunks keeps the pass real.
const CANARY = "omf-canary-never-in-the-chunks-0000";
const KEY = "omf-planted-fake-key-4c1d9e7a";

function credential() {
  const found = readCredential("claude", { OMF_IMPLEMENTER_API_KEY: KEY });
  if (found === null) throw new Error("the fixture key was refused");
  return found;
}

function chunked(...chunks: string[]): AuditSurface {
  return {
    kind: "worktree",
    async *read() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
    incomplete: () => false,
  };
}

describe("scanWorkspace credential overlap", () => {
  it("finds a key that straddles two read chunks at every split point", async () => {
    for (let cut = 1; cut < KEY.length; cut += 1) {
      const surface = chunked(`prefix ${KEY.slice(0, cut)}`, `${KEY.slice(cut)} suffix`);
      expect(await scanWorkspace(surface, [CANARY], credential())).toBe("credential");
    }
  });

  it("reports a clean workspace when the chunks only share a prefix of the key", async () => {
    expect(await scanWorkspace(chunked(`x ${KEY.slice(0, 10)}`, `${KEY.slice(0, 10)} y`), [CANARY], credential())).toBe(
      "clean",
    );
  });
});
