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

// The answer is decoded twice before anything is stored: JSON (answer.json) and YAML (scenarios_yaml). A key that is
// plain only after one of those decodings must be found as well.
const jsonUnicode = (text: string): string =>
  [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const yamlHex = (text: string): string =>
  [...text].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const yamlUnicode = (text: string): string => jsonUnicode(text);

async function runRaw(answerText: string) {
  const double = authorDouble({ answer: answerText });
  const session = createContainerAuthor(authorDeps(double, { credential: authorCredential(KEY) }));
  const outcome = await session.run(authorRequest());
  return { outcome, facts: session.takeFacts() };
}

describe("the key is searched after the answer is decoded", () => {
  it("finds a key written as JSON \\u escapes in answer.json", async () => {
    const answer = `{"scenarios_yaml":"note ${jsonUnicode(KEY)}"}\n`;
    expect(answer).not.toContain(KEY);
    const { outcome, facts } = await runRaw(answer);
    expect(outcome).toMatchObject({ ok: false, code: "credential_in_output" });
    expect(facts?.outcome).toBe("credential_in_output");
    expect(facts?.credential_hits).toBeGreaterThan(0);
  });

  it.each([
    ["\\x escapes", yamlHex],
    ["\\u escapes", yamlUnicode],
  ])("finds a key spelled with YAML double-quoted %s in scenarios_yaml", async (_label, spell) => {
    const yaml = `kind: behavior\nnote: "${spell(KEY)}"\n`;
    const answer = `${JSON.stringify({ scenarios_yaml: yaml })}\n`;
    expect(answer).not.toContain(KEY);
    expect(yaml).not.toContain(KEY);
    expect((await runRaw(answer)).outcome).toMatchObject({ ok: false, code: "credential_in_output" });
  });

  it("finds a key joined by a YAML double-quoted line continuation", async () => {
    const yaml = `note: "${KEY.slice(0, 12)}\\\n  ${KEY.slice(12)}"\n`;
    expect(yaml).not.toContain(KEY);
    const answer = `${JSON.stringify({ scenarios_yaml: yaml })}\n`;
    expect((await runRaw(answer)).outcome).toMatchObject({ ok: false, code: "credential_in_output" });
  });

  it("does not find a key split across a YAML folded scalar, which joins its lines with a space", async () => {
    const folded = `note: >-\n  ${KEY.slice(0, 12)}\n  ${KEY.slice(12)}\n`;
    const answer = `${JSON.stringify({ scenarios_yaml: folded })}\n`;
    expect((await runRaw(answer)).outcome).toMatchObject({ ok: true });
  });

  it("still accepts an answer that has no key in any decoded form", async () => {
    const answer = `${JSON.stringify({ scenarios_yaml: 'note: "\\x68\\x69"\n' })}\n`;
    expect((await runRaw(answer)).outcome).toMatchObject({ ok: true });
  });
});
