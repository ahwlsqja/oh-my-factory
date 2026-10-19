import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// A model suite gets only the keys it reads, each under its own name. G-author-canary reads the author key,
// G-skeleton-real reads both, the two older model suites read the implementer key. No vendor key name ever passes.
const SCRIPT = fileURLToPath(new URL("../../scripts/gated-docker.mjs", import.meta.url));

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  redact?: string[];
  inherit?: boolean;
}
interface Deps {
  run: (command: string, args: string[], options?: RunOptions) => { status: number; stdout: string; stderr: string };
  makeTempDir: (prefix: string) => string;
  log: (message: string) => void;
  now: () => Date;
  root: string;
  evidenceFile: string;
}
const script = (await import(SCRIPT)) as {
  EXIT: { ok: number; refused: number };
  keysFor: (only: string | null) => { keys: string[] } | { error: string };
  gatedEnv: (
    env: Record<string, string | undefined>,
    dockerConfig: string,
    omfHome: string,
    options?: { model?: boolean; keys?: string[]; report?: string },
  ) => Record<string, string>;
  childEnv: (env: Record<string, string | undefined>) => Record<string, string>;
  main: (argv: string[], env: Record<string, string | undefined>, deps: Deps) => number;
};

const AUTHOR = "OMF_AUTHOR_API_KEY";
const IMPL = "OMF_IMPLEMENTER_API_KEY";
const AUTHOR_VALUE = "author-key-value-1";
const IMPL_VALUE = "implementer-key-value-2";
const VENDOR_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;

describe("keysFor", () => {
  it("names the keys of the model suites a run selects, sorted, and refuses a selection that has none", () => {
    expect(script.keysFor(null)).toEqual({ keys: [AUTHOR, IMPL] });
    expect(script.keysFor("G-author-canary")).toEqual({ keys: [AUTHOR] });
    expect(script.keysFor("G-skeleton-real")).toEqual({ keys: [AUTHOR, IMPL] });
    expect(script.keysFor("G-implementer-real-run")).toEqual({ keys: [IMPL] });
    expect(script.keysFor("G-e6-l2-leak-redteam")).toEqual({ keys: [IMPL] });
    expect(script.keysFor("G-author-boundary-real")).toEqual({
      error: "--model with --only selects no suite that calls a model",
    });
    expect(script.keysFor("(")).toEqual({ error: "--only is not a valid pattern" });
  });
});

describe("keysFor selection", () => {
  it("treats --only as an unanchored pattern, so a fragment of a suite name selects it", () => {
    expect(script.keysFor("canary")).toEqual({ keys: [AUTHOR] });
    expect(script.keysFor("real-run")).toEqual({ keys: [IMPL] });
    expect(script.keysFor("G-author-canary|G-e6")).toEqual({ keys: [AUTHOR, IMPL] });
  });

  it("returns the keys sorted for every selection of suites, however they are chosen", () => {
    const suites = ["G-author-canary", "G-e6-l2-leak-redteam", "G-implementer-real-run", "G-skeleton-real"];
    for (let mask = 1; mask < 2 ** suites.length; mask += 1) {
      const pattern = suites.filter((_, at) => mask & (1 << at)).join("|");
      const result = script.keysFor(pattern);
      if (!("keys" in result)) throw new Error(`no keys for ${pattern}`);
      expect(result.keys, pattern).toEqual([...result.keys].sort());
      expect(new Set(result.keys).size, pattern).toBe(result.keys.length);
    }
  });
});

describe("gatedEnv and childEnv", () => {
  const BASE = {
    PATH: "/bin",
    [AUTHOR]: AUTHOR_VALUE,
    [IMPL]: IMPL_VALUE,
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    CODEX_API_KEY: "c",
    OMF_GATED_AUTHOR_IMAGE: "sha256:a",
    OMF_CAPTURE_FIXTURES: "1",
    OMF_GATED_IMPLEMENTER_IMAGE: "sha256:i",
    OMF_UNLISTED: "no",
  };

  it("passes exactly the named keys under their own names and never a vendor key name", () => {
    const author = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home", { model: true, keys: [AUTHOR] });
    const both = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home", { model: true, keys: [AUTHOR, IMPL] });
    expect(author[AUTHOR]).toBe(AUTHOR_VALUE);
    expect(author[IMPL]).toBeUndefined();
    expect(Object.keys(both).filter((name) => name.endsWith("_API_KEY"))).toEqual([AUTHOR, IMPL]);
    const smuggled = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home", { model: true, keys: ["ANTHROPIC_API_KEY"] });
    for (const env of [author, both, smuggled]) for (const name of VENDOR_NAMES) expect(env[name]).toBeUndefined();
    expect(both.OMF_GATED).toBe("docker+model");
  });

  it("drops every key without model mode, keeps the author image, and defaults to the implementer key", () => {
    const plain = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home");
    expect(Object.keys(plain).filter((name) => name.endsWith("_API_KEY"))).toEqual([]);
    expect(plain.OMF_GATED_AUTHOR_IMAGE).toBe("sha256:a");
    const defaulted = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home", { model: true });
    expect(defaulted[IMPL]).toBe(IMPL_VALUE);
    expect(defaulted[AUTHOR]).toBeUndefined();
  });

  it("passes the fixture switch and both image names, and no other OMF variable", () => {
    const env = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home");
    expect(env.OMF_CAPTURE_FIXTURES).toBe("1");
    expect(env.OMF_GATED_IMPLEMENTER_IMAGE).toBe("sha256:i");
    expect(env.OMF_UNLISTED).toBeUndefined();
  });

  it("childEnv removes every key a model suite may hold and the vendor key names", () => {
    expect(script.childEnv({ HOME: "/h", ...BASE })).toEqual({
      PATH: "/bin",
      HOME: "/h",
      OMF_GATED_AUTHOR_IMAGE: "sha256:a",
      OMF_CAPTURE_FIXTURES: "1",
      OMF_GATED_IMPLEMENTER_IMAGE: "sha256:i",
      OMF_UNLISTED: "no",
    });
  });
});

describe("main with --model", () => {
  function harness() {
    const logs: string[] = [];
    const calls: string[] = [];
    const seen: { vitest: RunOptions | null; others: RunOptions[] } = { vitest: null, others: [] };
    const root = makeTempDir("omf-gated-root-");
    const deps: Deps = {
      run: (command, args, options = {}) => {
        calls.push([command, ...args].join(" "));
        if (args.some((arg) => arg.endsWith("vitest.mjs"))) seen.vitest = options;
        else seen.others.push(options);
        const host = command === "docker" && args[0] === "context" && args[1] === "inspect";
        return { status: 0, stdout: host ? "unix:///home/dev/.colima/omf-m3f/docker.sock\n" : "", stderr: "" };
      },
      makeTempDir,
      log: (message) => logs.push(message),
      now: () => new Date(Date.UTC(2026, 9, 19)),
      root,
      evidenceFile: join(root, "gated-runs.json"),
    };
    return { deps, logs, calls, seen };
  }

  it.each([
    [
      "the author suite without the author key",
      ["--model", "--only", "G-author-canary"],
      { [IMPL]: IMPL_VALUE },
      AUTHOR,
    ],
    [
      "the whole line with only the author key",
      ["--model", "--only", "G-skeleton-real"],
      { [AUTHOR]: AUTHOR_VALUE },
      IMPL,
    ],
    ["an author key with a space", ["--model", "--only", "G-author-canary"], { [AUTHOR]: "has space" }, AUTHOR],
    [
      "an author key of 513 characters",
      ["--model", "--only", "G-author-canary"],
      { [AUTHOR]: `key-value-${"k".repeat(503)}` },
      AUTHOR,
    ],
  ])("refuses %s, names only the key and starts nothing", (_label, argv, env, missing) => {
    const { deps, logs, calls } = harness();
    expect(script.main(argv, { PATH: "/bin", ...env }, deps)).toBe(script.EXIT.refused);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain(missing);
    expect(logs.join("\n")).not.toMatch(/key-value|has space/);
  });

  it("gives the test process both keys, redacts both, and gives no other child a key", () => {
    const { deps, seen } = harness();
    const env = { PATH: "/bin", [AUTHOR]: AUTHOR_VALUE, [IMPL]: IMPL_VALUE, ANTHROPIC_API_KEY: "reconciler-key" };
    expect(script.main(["--model", "--only", "G-skeleton-real"], env, deps)).toBe(script.EXIT.ok);
    expect(seen.vitest?.redact).toEqual([AUTHOR_VALUE, IMPL_VALUE]);
    expect(seen.vitest?.env?.[AUTHOR]).toBe(AUTHOR_VALUE);
    expect(seen.vitest?.env?.[IMPL]).toBe(IMPL_VALUE);
    expect(seen.vitest?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.vitest?.env?.OMF_GATED).toBe("docker+model");
    for (const options of seen.others) {
      expect(options.env?.[AUTHOR]).toBeUndefined();
      expect(options.env?.[IMPL]).toBeUndefined();
    }
  });

  it("accepts an author key of exactly 512 characters", () => {
    const { deps, seen } = harness();
    const key = `key-value-${"k".repeat(502)}`;
    expect(key).toHaveLength(512);
    expect(script.main(["--model", "--only", "G-author-canary"], { PATH: "/bin", [AUTHOR]: key }, deps)).toBe(
      script.EXIT.ok,
    );
    expect(seen.vitest?.env?.[AUTHOR]).toBe(key);
  });
});
