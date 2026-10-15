import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type OmfConfig, parseConfig } from "../../src/core/config.js";
import { implementerVendorRefusal } from "../../src/implementer/vendor.js";

const withVendor = (vendor: "claude" | "codex"): OmfConfig =>
  parseConfig(`[roles]\nimplementer = { vendor = "${vendor}" }\n`);

describe("implementerVendorRefusal", () => {
  it("lets the claude implementer start", () => {
    expect(implementerVendorRefusal(withVendor("claude"))).toBeNull();
    expect(implementerVendorRefusal(parseConfig(""))).toBeNull();
    expect(CONFIG_DEFAULTS.roles.implementer.vendor).toBe("claude");
  });

  it("refuses a codex implementer with a closed gate_blocked reason that says only Claude is supported in v0.1", () => {
    const refusal = implementerVendorRefusal(withVendor("codex"));
    expect(refusal).toEqual({
      reason: "gate_blocked",
      message: 'roles.implementer.vendor "codex" is not supported: only Claude is supported as the implementer in v0.1',
    });
  });
});
