import { describe, expect, it } from "vitest";
import { createContainerAuthor } from "../../src/author/codex-session.js";
import { AUTHOR_KEY, authorCredential, authorDeps, authorDouble, authorRequest } from "../helpers/author-container.js";

// The answer is scanned for the key and for the spellings a model could write without noticing it copies a key: base64,
// base64url, hex and URL-encoded. A key that is split, reversed or otherwise transformed by arithmetic is not found, and
// docs/author.md says so; the defence for that is a dedicated, capped, short-lived key.
const KEY = AUTHOR_KEY;
/** Bytes that make the base64 form carry "+", "/" and "=" and the URL form carry percent escapes. */
const AWKWARD_KEY = "omf-author-test-key-?>?>~ok";

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

async function run(key: string, claim: string) {
  const double = authorDouble({ answer: `${JSON.stringify({ scenarios_yaml: `note ${claim}` })}\n` });
  const session = createContainerAuthor(authorDeps(double, { credential: authorCredential(key) }));
  return session.run(authorRequest());
}

describe("the key is searched in more than its plain spelling", () => {
  it.each([
    ["base64", (k: string) => base64(k)],
    ["base64 without padding", (k: string) => base64(k).replace(/=+$/, "")],
    ["base64url", (k: string) => Buffer.from(k, "utf8").toString("base64url")],
    ["hex", (k: string) => Buffer.from(k, "utf8").toString("hex")],
    ["upper-case hex", (k: string) => Buffer.from(k, "utf8").toString("hex").toUpperCase()],
    ["URL-encoded", (k: string) => encodeURIComponent(k)],
  ])("finds the key written as %s", async (_label, spell) => {
    for (const key of [KEY, AWKWARD_KEY]) {
      expect(await run(key, spell(key))).toMatchObject({ ok: false, code: "credential_in_output" });
    }
  });

  it("does not find a key that was split, reversed or shifted before it was written", async () => {
    const reversed = [...KEY].reverse().join("");
    const split = `${KEY.slice(0, 10)} ${KEY.slice(10)}`;
    const shifted = [...KEY].map((c) => String.fromCharCode(c.charCodeAt(0) + 1)).join("");
    for (const claim of [reversed, split, shifted]) {
      expect(await run(KEY, claim)).toMatchObject({ ok: true });
    }
  });

  it("does not report an answer that merely resembles the key", async () => {
    expect(await run(KEY, "omf-author-test-key")).toMatchObject({ ok: true });
  });
});
