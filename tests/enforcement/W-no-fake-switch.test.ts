import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { omf } from "../helpers/cli.js";
import { makeTempDir } from "../helpers/tmp.js";

// covers: S7.unmeasured-stage-no-claim
//
// The offline acceptance ends `unmeasured` because of the fixture it plants, never because of a switch. No environment name in
// `src`, no property of the config schema and no flag of the verbs that start containers may name a way to treat the probe as
// answered. A new name that trips this is a kernel-path change: tests/enforcement is read by the owner.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SWITCH = /fake|mock|stub|skip|assume|trust|insecure|simulate|bypass|probe/i;

function sourceText(): string {
  return readdirSync(join(ROOT, "src"), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".ts"))
    .map((path) => readFileSync(join(ROOT, "src", path), "utf8"))
    .join("\n");
}

/** Every key listed under a `properties` object, at any depth. */
function propertyNames(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(propertyNames);
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
    ...(key === "properties" && typeof value === "object" && value !== null ? Object.keys(value) : []),
    ...propertyNames(value),
  ]);
}

describe("W-no-fake-switch", () => {
  it("the detector bites: a switch-shaped name is caught", () => {
    expect(SWITCH.test("OMF_FAKE_PROBE")).toBe(true);
    expect(SWITCH.test("--assume-isolated")).toBe(true);
    expect(SWITCH.test("OMF_HOME")).toBe(false);
  });

  it("no environment name, config key or command flag can stand in for the probe", () => {
    const envNames = [...new Set(sourceText().match(/\bOMF_[A-Z0-9_]+/g) ?? [])];
    const schema: unknown = JSON.parse(readFileSync(join(ROOT, "schemas", "config.schema.json"), "utf8"));
    const configKeys = propertyNames(schema);
    const cwd = makeTempDir();
    const home = makeTempDir("omf-home-");
    const flags = [[], ["doctor"], ["seal"], ["run"], ["report"]].flatMap(
      (args) => omf([...args, "--help"], cwd, home).stdout.match(/--[a-z][a-z-]*/g) ?? [],
    );
    expect(envNames.length, "positive control: src names OMF variables").toBeGreaterThan(0);
    expect(configKeys.length, "positive control: the schema lists properties").toBeGreaterThan(0);
    expect(flags.length, "positive control: the verbs list flags").toBeGreaterThan(0);
    expect([...envNames, ...configKeys, ...flags].filter((name) => SWITCH.test(name))).toEqual([]);
  });
});
