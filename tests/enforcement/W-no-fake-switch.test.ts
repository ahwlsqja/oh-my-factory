import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { omf } from "../helpers/cli.js";
import { makeTempDir } from "../helpers/tmp.js";

// covers: S7.unmeasured-stage-no-claim
//
// This is a NAMING LINT, not a proof of the claim above. It does not run the probe guards and does not show that a stage no
// container measured stays unmeasured: that is W-cli-fake-docker-unmeasured and the record/gate tests. What it pins is that
// the names a person or a script can set (an environment variable `src` reads, a config key or value, a flag of any verb) do
// not read like a way to treat the probe as answered, and that the test-only stand-ins are not wired into production code.
// A new name that trips this is a kernel-path change: tests/enforcement is read by the owner.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SWITCH = /fake|mock|stub|skip|assume|trust|insecure|simulate|bypass|probe|override|force|waive/i;
const SWITCH_WORDS = ["fake", "mock", "stub", "skip", "assume", "trust", "insecure", "simulate", "bypass", "probe"];

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(extension))
    .map((path) => join(dir, path));
}

const sourceFiles = (): string[] => filesUnder("src", ".ts");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** Names read from an environment object: `env.NAME`, `process.env.NAME`, `env["NAME"]`, any `*Env.NAME`. */
function staticEnvReads(text: string): string[] {
  const dotted = [...text.matchAll(/\b\w*[Ee]nv\??\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1] as string);
  const bracketed = [...text.matchAll(/\b\w*[Ee]nv\??\[\s*["'`]([A-Za-z0-9_]+)["'`]\s*\]/g)].map((m) => m[1] as string);
  return [...dotted, ...bracketed];
}

/** True where an environment object is indexed by something that is not a string literal. */
function hasComputedEnvRead(text: string): boolean {
  return /\b\w*[Ee]nv\??\[\s*(?!["'`])[^\]\s]/.test(text);
}

/** Every key listed under `properties`, every `patternProperties` pattern, and every string `enum` or `const` value. */
function schemaNames(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(schemaNames);
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
    const own: string[] = [];
    if ((key === "properties" || key === "patternProperties") && typeof value === "object" && value !== null) {
      own.push(...Object.keys(value));
    }
    if (key === "enum" && Array.isArray(value))
      own.push(...value.filter((item): item is string => typeof item === "string"));
    if (key === "const" && typeof value === "string") own.push(value);
    return [...own, ...schemaNames(value)];
  });
}

/** Subcommand names listed under a `Commands:` heading of a help text; `help` is Commander's own. */
function listedCommands(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}([a-z][a-z0-9-]*)\b/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "help") names.push(match[1]);
  }
  return names;
}

function flagsOf(help: string): string[] {
  return help.match(/--[a-z][a-z0-9-]*/g) ?? [];
}

/** Every flag of every command, found by walking the `Commands:` lists from the root verb. */
function allFlags(cwd: string, home: string): string[] {
  const flags: string[] = [];
  const walk = (path: string[]): void => {
    const help = omf([...path, "--help"], cwd, home).stdout;
    flags.push(...flagsOf(help));
    for (const name of listedCommands(help)) walk([...path, name]);
  };
  walk([]);
  return flags;
}

// The environment variables `src` is known to read by a literal name. A new entry is a decision, not an edit.
const ENV_READ_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "DOCKER_CONFIG",
  "GIT_INDEX_FILE",
  "HOME",
  "LC_ALL",
  "OMF_HOME",
  "PATH",
  "TMPDIR",
];
// Every OMF_ name that appears anywhere in `src` (reads, writes, and names the code only reports).
const OMF_NAME_ALLOWLIST = [
  "OMF_AUTHOR_API_KEY",
  "OMF_GATES",
  "OMF_GATE_RULES",
  "OMF_HOME",
  "OMF_IMAGE_RE",
  "OMF_IMPLEMENTER_API_KEY",
  "OMF_OWNED_KEYS",
  "OMF_SET_KEYS",
  "OMF_TMP",
];
// Files that index an environment object by a computed key, each over a fixed list of names it owns.
const COMPUTED_ENV_FILES = [
  "src/adapters/reconciler.ts",
  "src/core/paths.ts",
  "src/implementer/credential.ts",
  "src/seal/session.ts",
];

// The stand-ins a test uses in place of a real session. Production code must never reach them.
const STAND_INS = [/\bcreateStubSession\b/, /\bcreateCommandAuthor\b/, /\bstub-session(\.js)?\b/];
const STAND_IN_HOMES = ["src/implementer/stub-session.ts", "src/seal/session.ts"];

describe("W-no-fake-switch (naming lint)", () => {
  it.each(SWITCH_WORDS)("the detector bites on %s in lower and upper case", (word) => {
    expect(SWITCH.test(`OMF_${word.toUpperCase()}_PROBE_X`)).toBe(true);
    expect(SWITCH.test(`--${word}-isolation`)).toBe(true);
    expect(SWITCH.test(`${word[0]?.toUpperCase()}${word.slice(1)}Mode`)).toBe(true);
  });

  it("the detector leaves ordinary names alone", () => {
    for (const name of ["OMF_HOME", "--json", "--strict", "image", "vendor", "timeout_ms"]) {
      expect(SWITCH.test(name), name).toBe(false);
    }
  });

  it("the env, schema and command scanners bite on planted samples", () => {
    expect(
      staticEnvReads('const a = process.env.OMF_FAKE_X; const b = env["OMF_SKIP"]; callerEnv.DOCKER_HOST'),
    ).toEqual(["OMF_FAKE_X", "DOCKER_HOST", "OMF_SKIP"]);
    expect(hasComputedEnvRead("const v = env[name];")).toBe(true);
    expect(hasComputedEnvRead('const v = env["HOME"];')).toBe(false);
    expect(
      schemaNames({ properties: { a: {} }, patternProperties: { "^(fake|skip)_": {} }, items: { enum: ["stub", 3] } }),
    ).toEqual(["a", "^(fake|skip)_", "stub"]);
    expect(schemaNames({ properties: { vendor: { const: "assume" } } })).toEqual(["vendor", "assume"]);
    const help =
      "Usage: x\n\nCommands:\n  init            do it\n  goal            more\n                  wrapped\n  help [cmd]      help\n\nafter";
    expect(listedCommands(help)).toEqual(["init", "goal"]);
  });

  it("no environment variable src reads, and no OMF_ name in src, reads like a switch or is unlisted", () => {
    const reads = new Set<string>();
    const omfNames = new Set<string>();
    const computed: string[] = [];
    for (const file of sourceFiles()) {
      const text = read(file);
      for (const name of staticEnvReads(text)) reads.add(name);
      for (const name of text.match(/\bOMF_[A-Z0-9_]+/g) ?? []) omfNames.add(name);
      if (hasComputedEnvRead(text)) computed.push(file);
    }
    expect(reads.size, "positive control: src reads environment names").toBeGreaterThan(0);
    expect([...reads].sort()).toEqual([...ENV_READ_ALLOWLIST].sort());
    expect([...omfNames].sort()).toEqual([...OMF_NAME_ALLOWLIST].sort());
    expect(computed.sort()).toEqual([...COMPUTED_ENV_FILES].sort());
    expect([...reads, ...omfNames].filter((name) => SWITCH.test(name))).toEqual([]);
  });

  it("no config key, pattern or enumerated value reads like a switch", () => {
    const schema: unknown = JSON.parse(read("schemas/config.schema.json"));
    const names = schemaNames(schema);
    expect(names.length, "positive control: the schema lists names").toBeGreaterThan(0);
    expect(names.filter((name) => SWITCH.test(name))).toEqual([]);
  });

  it("no flag of any command, at any depth, reads like a switch", () => {
    const cwd = makeTempDir();
    const home = makeTempDir("omf-home-");
    const flags = allFlags(cwd, home);
    expect(flags.length, "positive control: the verbs list flags").toBeGreaterThan(0);
    // the walk reaches nested verbs such as `goal` and `work`, not only the first level
    expect(omf(["goal", "--help"], cwd, home).stdout).toContain("Commands:");
    expect(listedCommands(omf(["--help"], cwd, home).stdout)).toEqual(
      expect.arrayContaining(["goal", "seal", "run", "report"]),
    );
    expect(flags.filter((flag) => SWITCH.test(flag))).toEqual([]);
  });

  it("the test-only stand-ins are referenced by no production file", () => {
    const offenders = [...sourceFiles(), ...filesUnder("scripts", ".mjs"), ...filesUnder("outer", ".mjs")]
      .filter((file) => !STAND_IN_HOMES.includes(file))
      .filter((file) => STAND_INS.some((pattern) => pattern.test(read(file))));
    expect(offenders).toEqual([]);
    for (const home of STAND_IN_HOMES) expect(read(home).length, `${home} exists`).toBeGreaterThan(0);
  });
});
