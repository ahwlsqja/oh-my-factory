import { CREDENTIAL_SOURCE_ENV } from "../implementer/credential.js";
import { CREDENTIAL_SHAPED_ENV_NAMES, SECRET_ENV_NAMES } from "../container/spec.js";

/**
 * One list for "a variable that carries a vendor key or points a vendor CLI somewhere else": the keys OMF itself reads
 * (`OMF_AUTHOR_API_KEY`, `OMF_IMPLEMENTER_API_KEY`), the closed credential-shaped set, the vendor prefixes (so an
 * `OPENAI_BASE_URL` cannot redirect a CLI either) and the vendor config directory. `HOME` is not here: the host reconciler
 * always overwrites it, and agent exec refuses it separately (`agentExecEnvRefused`).
 */
const VENDOR_PREFIX = /^(ANTHROPIC|CODEX|OPENAI)_/;
const NAMED = new Set<string>([
  ...Object.values(CREDENTIAL_SOURCE_ENV),
  ...SECRET_ENV_NAMES,
  ...CREDENTIAL_SHAPED_ENV_NAMES,
  "CLAUDE_CONFIG_DIR",
]);

export function vendorEnvName(name: string): boolean {
  return NAMED.has(name) || VENDOR_PREFIX.test(name);
}

/** Any name that looks like a credential, whatever its prefix. Broader than `vendorEnvName`, so used only where nothing legitimate needs it. */
const CREDENTIAL_LIKE = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH_CONFIG)/i;

/** A name an exec into an agent container (implementer, author) may never set: it could move the CLI's home or carry a credential. */
export function agentExecEnvRefused(name: string): boolean {
  return name === "HOME" || vendorEnvName(name) || CREDENTIAL_LIKE.test(name);
}
