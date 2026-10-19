// covers: S5.3.same-vendor-refused
import { describe, expect, it } from "vitest";
import { type OmfConfig, parseConfig } from "../../src/core/config.js";
import { authorVendorRefusal, resolveRoles, sameVendorRefusal } from "../../src/core/roles.js";

const roles = (body: string): OmfConfig => parseConfig(`[roles]\n${body}\n`);

describe("sameVendorRefusal", () => {
  it("lets the default pairing through: a codex author with a claude implementer", () => {
    expect(sameVendorRefusal(parseConfig(""))).toBeNull();
  });

  it.each(["claude", "codex"] as const)("refuses two %s roles and names both", (vendor) => {
    const refusal = sameVendorRefusal(
      roles(`author = { vendor = "${vendor}" }\nimplementer = { vendor = "${vendor}" }`),
    );
    expect(refusal?.reason).toBe("same_vendor");
    expect(refusal?.message).toContain(`roles.author.vendor "${vendor}"`);
    expect(refusal?.message).toContain(`roles.implementer.vendor "${vendor}"`);
    expect(refusal?.message).toContain("no same-vendor pairing is runnable in v0.1");
  });
});

describe("authorVendorRefusal", () => {
  it("lets a codex author through", () => {
    expect(authorVendorRefusal(parseConfig(""))).toBeNull();
  });

  it("accepts a claude author in the config but refuses it as the sealing author", () => {
    const config = roles('author = { vendor = "claude" }');
    expect(config.roles.author.vendor).toBe("claude");
    expect(authorVendorRefusal(config)).toEqual({
      reason: "author_vendor_unsupported",
      message: 'roles.author.vendor "claude" is not supported: only Codex runs as the sealing author in v0.1',
    });
  });
});

describe("resolveRoles", () => {
  it("reports the default roles, with no model and a judge that is deterministic", () => {
    expect(resolveRoles(parseConfig(""))).toEqual({
      author: { vendor: "codex", model: null },
      implementer: { vendor: "claude", model: null },
      judge: { kind: "deterministic", configured_vendor: "codex", model_judge: "not_available" },
    });
  });

  it("carries the configured models and judge vendor, and stays deterministic", () => {
    const config = roles(
      'author = { vendor = "codex", model = "gpt-test" }\nimplementer = { vendor = "claude", model = "claude-test" }\njudge = { vendor = "claude" }',
    );
    expect(resolveRoles(config)).toEqual({
      author: { vendor: "codex", model: "gpt-test" },
      implementer: { vendor: "claude", model: "claude-test" },
      judge: { kind: "deterministic", configured_vendor: "claude", model_judge: "not_available" },
    });
  });

  it("does not refuse: a refused pairing still resolves, and the refusal belongs to the station", () => {
    const config = roles('author = { vendor = "claude" }');
    expect(resolveRoles(config).author.vendor).toBe("claude");
    expect(sameVendorRefusal(config)).not.toBeNull();
  });
});
