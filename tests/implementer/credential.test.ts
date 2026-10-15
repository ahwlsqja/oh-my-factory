import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { SecretHandle } from "../../src/container/runtime.js";
import { CREDENTIAL_SHAPED_ENV_NAMES, SECRET_ENV_NAMES } from "../../src/container/spec.js";
import {
  CREDENTIAL_ENV,
  CREDENTIAL_SOURCE_ENV,
  Credential,
  containsCredential,
  readCredential,
  redact,
} from "../../src/implementer/credential.js";

const KEY = "sk-ant-test-0123456789abcdef";

function mint(value = KEY): Credential {
  const credential = readCredential("claude", { OMF_IMPLEMENTER_API_KEY: value });
  if (credential === null) throw new Error("the fixture key was refused");
  return credential;
}

describe("closed env-name tables", () => {
  it("names exactly one secret, ANTHROPIC_API_KEY, which is also credential-shaped", () => {
    expect([...SECRET_ENV_NAMES]).toEqual(["ANTHROPIC_API_KEY"]);
    expect(CREDENTIAL_ENV).toEqual({ claude: "ANTHROPIC_API_KEY" });
    expect(CREDENTIAL_SOURCE_ENV).toEqual({ claude: "OMF_IMPLEMENTER_API_KEY" });
    for (const name of SECRET_ENV_NAMES) expect(CREDENTIAL_SHAPED_ENV_NAMES).toContain(name);
  });

  it("lists each credential-shaped name once, as an upper case variable name", () => {
    expect(new Set(CREDENTIAL_SHAPED_ENV_NAMES).size).toBe(CREDENTIAL_SHAPED_ENV_NAMES.length);
    for (const name of CREDENTIAL_SHAPED_ENV_NAMES) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    for (const name of ["OPENAI_API_KEY", "CODEX_HOME", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(CREDENTIAL_SHAPED_ENV_NAMES).toContain(name);
    }
  });
});

describe("readCredential", () => {
  it("returns a credential named ANTHROPIC_API_KEY that reveals the value, and nothing else does", () => {
    const credential = mint();
    expect(credential.name).toBe("ANTHROPIC_API_KEY");
    expect(credential.reveal()).toBe(KEY);
    expect(Object.getOwnPropertyNames(credential)).toEqual(["name"]);
    expect(Object.getOwnPropertySymbols(credential)).toEqual([]);
  });

  it("is usable where the container layer asks for a SecretHandle", () => {
    const handle: SecretHandle = mint();
    expect(handle.name).toBe("ANTHROPIC_API_KEY");
    expect(handle.reveal()).toBe(KEY);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["longer than 512", "a".repeat(513)],
    ["padded with a leading space", ` ${KEY}`],
    ["padded with a trailing newline", `${KEY}\n`],
    ["holding a space", "sk ant"],
    ["holding a control character", "sk-\u0000-x"],
    ["not ASCII", "sk-é-x"],
  ])("returns null for a value that is %s", (_name, value) => {
    expect(readCredential("claude", value === undefined ? {} : { OMF_IMPLEMENTER_API_KEY: value })).toBeNull();
  });

  it("accepts a value of exactly 512 characters", () => {
    expect(readCredential("claude", { OMF_IMPLEMENTER_API_KEY: "a".repeat(512) })?.reveal()).toBe("a".repeat(512));
  });

  it("reads one variable and no other, and ignores other vendors' keys", () => {
    const reads: string[] = [];
    const probed = new Proxy<NodeJS.ProcessEnv>(
      {
        OMF_IMPLEMENTER_API_KEY: KEY,
        ANTHROPIC_API_KEY: "reconciler",
        OPENAI_API_KEY: "other",
        CLAUDE_CODE_OAUTH_TOKEN: "other",
      },
      {
        get(target, prop, receiver) {
          reads.push(String(prop));
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    expect(readCredential("claude", probed)?.reveal()).toBe(KEY);
    expect(reads).toEqual(["OMF_IMPLEMENTER_API_KEY"]);
    expect(
      readCredential("claude", {
        ANTHROPIC_API_KEY: "the reconciler key",
        OPENAI_API_KEY: "x",
        ANTHROPIC_AUTH_TOKEN: "x",
        CLAUDE_CODE_OAUTH_TOKEN: "x",
      }),
    ).toBeNull();
  });
});

describe("Credential never prints its value", () => {
  it("masks it in JSON, template strings, String(), inspect and util.format", () => {
    const credential = mint();
    const outputs = [
      JSON.stringify(credential),
      JSON.stringify({ credential, list: [credential] }),
      `${credential}`,
      String(credential),
      `${[credential]}`,
      inspect(credential),
      inspect({ nested: { credential } }, { depth: 6, showHidden: true }),
      format("%s %j %o %O %d", credential, credential, credential, credential, credential),
      JSON.stringify({ ...credential }),
    ];
    for (const output of outputs) expect(output).not.toContain(KEY);
    expect(JSON.stringify(credential)).toBe('"[credential]"');
    expect(`${credential}`).toBe("[credential]");
    expect(inspect(credential)).toBe("[credential]");
  });

  it("reveals what it was given, and refuses to reveal for an object that was never constructed", () => {
    expect(new Credential("ANTHROPIC_API_KEY", "abc").reveal()).toBe("abc");
    expect(() => Credential.prototype.reveal.call({})).toThrow("the credential has no value");
  });
});

describe("redact and containsCredential", () => {
  it("removes every occurrence, treating the value as text and not as a pattern", () => {
    const tricky = "sk-ant.*$&x(1)";
    const credential = mint(tricky);
    const text = `a ${tricky} b ${tricky}${tricky} c sk-ant-other`;
    expect(redact(text, credential)).toBe("a [redacted] b [redacted][redacted] c sk-ant-other");
    expect(redact(text, credential)).not.toContain(tricky);
  });

  it("returns the text unchanged for a null credential or an absent value", () => {
    expect(redact("nothing here", null)).toBe("nothing here");
    expect(redact("nothing here", mint())).toBe("nothing here");
  });

  it("finds the value in text and in bytes, wherever it sits, and not a prefix of it", () => {
    const credential = mint();
    expect(containsCredential(`before ${KEY} after`, credential)).toBe(true);
    expect(
      containsCredential(Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(KEY), Buffer.from([2, 0])]), credential),
    ).toBe(true);
    expect(containsCredential(KEY.slice(0, -1), credential)).toBe(false);
    expect(containsCredential(Buffer.from("sk-ant-test-0123456789abcde"), credential)).toBe(false);
    expect(containsCredential("", credential)).toBe(false);
  });
});
