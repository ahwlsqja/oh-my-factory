// covers: S5.3.same-vendor-refused
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type OmfConfig, parseConfig } from "../../src/core/config.js";
import { authorVendorRefusal, sameVendorRefusal } from "../../src/core/roles.js";
import { implementerVendorRefusal } from "../../src/implementer/vendor.js";

// Same-vendor authoring is refused in v0.1, not waived (spec §5.3; §14 item 2 leaves the mode open): no pairing of author and implementer on one
// vendor is runnable, and nothing that ships carries a switch, a label or a report line that says otherwise.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENDORS = ["claude", "codex"] as const;
const WAIVER = /acknowledg/i;

const pairing = (author: string, implementer: string): OmfConfig =>
  parseConfig(`[roles]\nauthor = { vendor = "${author}" }\nimplementer = { vendor = "${implementer}" }\n`);

const runnable = (config: OmfConfig): boolean =>
  sameVendorRefusal(config) === null &&
  authorVendorRefusal(config) === null &&
  implementerVendorRefusal(config) === null;

function filesUnder(root: string): { file: string; text: string }[] {
  const dir = join(ROOT, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => ({ file: `${root}/${name.split("\\").join("/")}`, text: readFileSync(join(dir, name), "utf8") }));
}

describe("W-same-vendor-refused", () => {
  it("exactly one pairing is runnable: a codex author with a claude implementer", () => {
    const pairings = VENDORS.flatMap((author) => VENDORS.map((implementer) => [author, implementer] as const));
    expect(pairings.filter(([author, implementer]) => runnable(pairing(author, implementer)))).toEqual([
      ["codex", "claude"],
    ]);
  });

  it("refuses the same-vendor key in config.toml whatever its value, so no file can switch it on", () => {
    for (const value of ["true", "false", '"yes"', "1"]) {
      expect(() => parseConfig(`[seal]\nsame_vendor = ${value}\n`)).toThrow("[seal] same_vendor is not available");
    }
  });

  it("the waiver detector catches a planted word (positive control)", () => {
    expect(WAIVER.test("const label = 'same-vendor acknowledgement';")).toBe(true);
    expect(WAIVER.test("roles.author.vendor and roles.implementer.vendor name the same vendor")).toBe(false);
  });

  it("no source file and no schema carries a same-vendor waiver", () => {
    const shipped = [...filesUnder("src"), ...filesUnder("schemas")];
    expect(shipped.length).toBeGreaterThan(50);
    expect(shipped.filter(({ text }) => WAIVER.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
