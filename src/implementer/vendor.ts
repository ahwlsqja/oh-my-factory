import type { OmfConfig } from "../core/config.js";

/** The reason the implementer station stops with: a closed code, never text from the config or a container. */
export interface ImplementerVendorRefusal {
  reason: "gate_blocked";
  message: string;
}

/**
 * Whether the implementer station may start with this config. The config itself accepts `roles.implementer.vendor =
 * "codex"` so that every other command keeps working on a project that names it; only the station that would run
 * the implementer refuses, because only Claude is supported as the implementer in v0.1.
 */
export function implementerVendorRefusal(config: OmfConfig): ImplementerVendorRefusal | null {
  if (config.roles.implementer.vendor === "claude") return null;
  return {
    reason: "gate_blocked",
    message: `roles.implementer.vendor "${config.roles.implementer.vendor}" is not supported: only Claude is supported as the implementer in v0.1`,
  };
}
