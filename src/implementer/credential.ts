import { inspect } from "node:util";
import type { SecretHandle } from "../container/runtime.js";
import type { SecretEnvName } from "../container/spec.js";

/**
 * The variable each vendor's container role receives its one key under inside the container: the name the vendor CLI
 * expects. The claude entry is the implementer's key and the codex entry is the sealing author's key; adding a vendor
 * adds a name here and to `SECRET_ENV_NAMES`. The codex name is unverified against the Codex CLI until the first gated run.
 */
export type CredentialVendor = "claude" | "codex";

export const CREDENTIAL_ENV: Readonly<Record<CredentialVendor, SecretEnvName>> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "CODEX_API_KEY",
};

/**
 * The variable on the OMF host that holds the implementer's key. It is deliberately not the vendor's own name:
 * `ANTHROPIC_API_KEY` is the reconciler's key on the host, and code in the implementer container can read the key it
 * is given, so the implementer gets a separate key, created for it with a provider-side spend limit.
 */
export const CREDENTIAL_SOURCE_ENV: Readonly<Record<CredentialVendor, string>> = {
  claude: "OMF_IMPLEMENTER_API_KEY",
  codex: "OMF_AUTHOR_API_KEY",
};

const MASK = "[credential]";
/** A vendor key is far shorter; a longer value is not a key and is refused rather than passed on. */
const MAX_LENGTH = 512;
/** Printable ASCII without space: "!" (0x21) to "~" (0x7e). A space, a newline or any other padding is refused. */
const PRINTABLE = /^[!-~]+$/;

/**
 * The values live here, not on the instance: an instance has no field that `Object.values`, a spread, a structured
 * clone or a debugger's property list could show, so the only way to read the key is `reveal()`.
 */
const values = new WeakMap<Credential, string>();

/**
 * One vendor key, held so that it cannot be printed by accident. It implements `SecretHandle`, so the container
 * layer receives this object and never a string. By design (spec §7, L2) code running in the container can read and
 * use the key; the bound is the provider-side spend limit on a dedicated key, and this type only stops OMF itself
 * from leaking it into a log, a ledger event, a file or a message.
 */
export class Credential implements SecretHandle {
  constructor(
    readonly name: SecretEnvName,
    value: string,
  ) {
    values.set(this, value);
  }

  /** The only way to read the value. The docker adapter calls it once per exec that needs it. */
  reveal(): string {
    const value = values.get(this);
    if (value === undefined) throw new Error("the credential has no value");
    return value;
  }

  toJSON(): string {
    return MASK;
  }

  toString(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}

/**
 * Reads a role's key from its own OMF process environment variable (`OMF_IMPLEMENTER_API_KEY` for claude, `OMF_AUTHOR_API_KEY` for codex) and from no other
 * variable (never `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `CODEX_API_KEY`); the credential is named for the variable the vendor CLI reads in the container. `null` when it is unset, empty,
 * longer than 512 characters, or not printable ASCII without whitespace: a padded or odd value is refused instead of
 * being trimmed, because a key that was altered on the way in would only fail later at the provider with a message
 * that does not say why.
 */
export function readCredential(vendor: CredentialVendor, env: NodeJS.ProcessEnv): Credential | null {
  const value = env[CREDENTIAL_SOURCE_ENV[vendor]];
  if (value === undefined || value.length === 0 || value.length > MAX_LENGTH || !PRINTABLE.test(value)) return null;
  return new Credential(CREDENTIAL_ENV[vendor], value);
}

/** Replaces every occurrence of the value with `[redacted]`. The value is matched as text, never as a pattern. */
export function redact(text: string, credential: Credential | null): string {
  if (credential === null) return text;
  return text.replaceAll(credential.reveal(), "[redacted]");
}

/**
 * Whether the value appears in `bytes`, as text or inside binary data. Plain byte equality of the key as it was
 * given: an encoded form (base64, hex, split across writes) is not found, so this catches an accident and not an
 * adversary.
 */
export function containsCredential(bytes: Buffer | string, credential: Credential): boolean {
  const value = credential.reveal();
  return typeof bytes === "string" ? bytes.includes(value) : bytes.includes(value);
}
