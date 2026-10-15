import { inspect } from "node:util";
import type { SecretHandle } from "../container/runtime.js";
import type { SecretEnvName } from "../container/spec.js";

/**
 * The variable each vendor's implementer reads its one key from. Only the claude implementer runs in a container
 * in this version, so there is one entry; adding a vendor adds a name here and to `SECRET_ENV_NAMES`.
 */
export const CREDENTIAL_ENV: Readonly<Record<"claude", SecretEnvName>> = { claude: "ANTHROPIC_API_KEY" };

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
 * Reads the vendor key from the OMF process environment and from no other variable. `null` when it is unset, empty,
 * longer than 512 characters, or not printable ASCII without whitespace: a padded or odd value is refused instead of
 * being trimmed, because a key that was altered on the way in would only fail later at the provider with a message
 * that does not say why.
 */
export function readCredential(vendor: "claude", env: NodeJS.ProcessEnv): Credential | null {
  const name = CREDENTIAL_ENV[vendor];
  const value = env[name];
  if (value === undefined || value.length === 0 || value.length > MAX_LENGTH || !PRINTABLE.test(value)) return null;
  return new Credential(name, value);
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
