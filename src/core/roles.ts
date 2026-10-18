import type { OmfConfig, Vendor } from "./config.js";

/** Why a station must not start a role pairing: a closed reason and a message that names the roles, never config text. */
export interface RoleRefusal {
  reason: "same_vendor" | "author_vendor_unsupported";
  message: string;
}

/**
 * Whether the sealing author and the implementer sit on one vendor. That is always refused in this version: a leak
 * the author knows about could then pass unnoticed through code the same vendor writes, and the design leaves a
 * same-vendor mode open (spec §14 item 2) with no recorded way to allow it before M4. With today's vendor rules the other two
 * refusals already make every same-vendor pairing unrunnable, so this is defence in depth, and the one that names
 * both roles. The config parses a same-vendor pairing (every other command keeps working); only the station refuses.
 */
export function sameVendorRefusal(config: OmfConfig): RoleRefusal | null {
  const author = config.roles.author.vendor;
  const implementer = config.roles.implementer.vendor;
  if (author !== implementer) return null;
  return {
    reason: "same_vendor",
    message: `roles.author.vendor "${author}" and roles.implementer.vendor "${implementer}" name the same vendor: no same-vendor pairing is runnable in v0.1`,
  };
}

/** Only Codex runs as the container author in v0.1, as only Claude runs as the implementer (`implementerVendorRefusal`). */
export function authorVendorRefusal(config: OmfConfig): RoleRefusal | null {
  const vendor = config.roles.author.vendor;
  if (vendor === "codex") return null;
  return {
    reason: "author_vendor_unsupported",
    message: `roles.author.vendor "${vendor}" is not supported: only Codex runs as the sealing author in v0.1`,
  };
}

export interface ResolvedRoles {
  author: { vendor: Vendor; model: string | null };
  implementer: { vendor: Vendor; model: string | null };
  /** Read and validated, never started: there is no model judge before v0.3, so the judge is the deterministic checks. */
  judge: { kind: "deterministic"; configured_vendor: Vendor; model_judge: "not_available" };
}

/** The roles a seal or run pass reports. It never refuses; the stations consult the refusal functions above. */
export function resolveRoles(config: OmfConfig): ResolvedRoles {
  return {
    author: { vendor: config.roles.author.vendor, model: config.roles.author.model ?? null },
    implementer: { vendor: config.roles.implementer.vendor, model: config.roles.implementer.model ?? null },
    judge: { kind: "deterministic", configured_vendor: config.roles.judge.vendor, model_judge: "not_available" },
  };
}
