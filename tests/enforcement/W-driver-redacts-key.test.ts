import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listFiles } from "../helpers/ops-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

// W-driver-redacts-key: the owner types the gated model command as `! <command>`, so its output enters the agent conversation.
// The driver therefore pipes the test process through a redactor, hands the key to that one process only, and refuses a run
// without a usable key. A fake runner stands in for colima, docker and git; the test process is a real child that prints the key.

const SCRIPT = fileURLToPath(new URL("../../scripts/gated-docker.mjs", import.meta.url));
interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  inherit?: boolean;
  redact?: string[];
}
interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
interface Deps {
  run: (command: string, args: string[], options?: RunOptions) => RunResult;
  makeTempDir: (prefix: string) => string;
  log: (message: string) => void;
  now: () => Date;
  root: string;
  evidenceFile: string;
}
const script = (await import(SCRIPT)) as {
  EXIT: { ok: number; failed: number; refused: number; colima: number };
  main: (argv: string[], env: Record<string, string | undefined>, deps: Deps) => number;
  runRedacted: (
    command: string,
    args: string[],
    options: RunOptions,
    sinks: { stdout: (text: string) => void; stderr: (text: string) => void },
  ) => RunResult;
  realDeps: () => { deps: Deps; cleanup: () => void };
};
const { EXIT } = script;

/** Printable ASCII with a quote and a backslash, so the JSON-escaped spelling is exercised too. */
const SENTINEL = 'sk-ant-W9d2"q\\z-48151623';
const ESCAPED = JSON.stringify(SENTINEL).slice(1, -1);
/** The key starts 7 characters before the end of the first 64 KiB slice, so it straddles a slice boundary on stdout. */
const CHILD = [
  "const key = process.env.OMF_IMPLEMENTER_API_KEY;",
  "process.stdout.write('x'.repeat(65536 - 7) + key + '\\n');",
  "process.stdout.write(JSON.stringify({ key }) + '\\n');",
  "process.stderr.write('AssertionError: expected ' + key + ' to equal other\\n');",
  "process.exit(1);",
].join("\n");
const REPORT = {
  testResults: [{ assertionResults: [{ ancestorTitles: ["G-implementer-real-run"], status: "passed" }] }],
};
const MODEL_REPORT = { vendor: "claude", name: "default", spend_micro_usd: 4200, log_bytes: 512 };
const ANSWERS: Record<string, string> = {
  "docker context show": "default\n",
  "docker context inspect": "unix:///home/dev/.colima/omf-m3f/docker.sock\n",
  "docker --context": "29.0.0 aarch64\n",
  "git rev-parse": `${"a".repeat(40)}\n`,
};

/** `mode` "child": the test process is a real child that prints the key and exits 1. "pass": it succeeds and writes the two reports. */
function rig(mode: "child" | "pass") {
  const calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
  const logs: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const dirs: string[] = [];
  const root = makeTempDir("omf-w-driver-");
  const evidenceFile = join(root, "gated-runs.json");
  writeFileSync(evidenceFile, `${JSON.stringify({ schema_version: 1, runs: [] })}\n`);
  const deps: Deps = {
    run(command, args, options = {}) {
      calls.push({ command, args, options });
      if (args.some((arg) => arg.endsWith("vitest.mjs"))) {
        if (mode === "child" && options.redact !== undefined) {
          const env = { ...options.env, PATH: process.env.PATH ?? "" };
          const sinks = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
          return script.runRedacted(process.execPath, ["-e", CHILD], { ...options, env }, sinks);
        }
        const report = args.find((arg) => arg.startsWith("--outputFile.json="));
        if (report !== undefined) writeFileSync(report.slice("--outputFile.json=".length), JSON.stringify(REPORT));
        const model = options.env?.OMF_GATED_MODEL_REPORT;
        if (model !== undefined) writeFileSync(model, JSON.stringify(MODEL_REPORT));
        return { status: 0, stdout: "", stderr: "" };
      }
      const label = `${command} ${args[0] === "context" ? `context ${args[1]}` : (args[0] ?? "")}`;
      return { status: 0, stdout: ANSWERS[label] ?? "", stderr: "" };
    },
    makeTempDir: (prefix) => {
      const dir = makeTempDir(prefix);
      dirs.push(dir);
      return dir;
    },
    log: (message) => logs.push(message),
    now: () => new Date(Date.UTC(2026, 9, 16)),
    root,
    evidenceFile,
  };
  const vitestCall = () => calls.find((call) => call.args.some((arg) => arg.endsWith("vitest.mjs")));
  return { deps, calls, logs, out, err, dirs, evidenceFile, vitestCall };
}

describe("W-driver-redacts-key", () => {
  it("a failing test process that prints the key leaves it nowhere the driver writes, and [redacted] stands in its place", () => {
    const r = rig("child");
    expect(
      script.main(["--model", "--record"], { PATH: process.env.PATH, OMF_IMPLEMENTER_API_KEY: SENTINEL }, r.deps),
    ).toBe(EXIT.failed);
    const seen = [
      r.out.join(""),
      r.err.join(""),
      r.logs.join("\n"),
      JSON.stringify(r.calls.map((c) => [c.command, c.args])),
    ];
    for (const text of seen) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(ESCAPED);
    }
    expect(r.out.join("")).toContain("[redacted]");
    expect(r.err.join("")).toContain("[redacted]");
    expect(r.out.join("")).toContain("x".repeat(100));
    expect(JSON.parse(readFileSync(r.evidenceFile, "utf8")).runs).toEqual([]);
    for (const dir of r.dirs) {
      for (const file of listFiles(dir)) expect(readFileSync(join(dir, file), "utf8")).not.toContain(SENTINEL);
    }
  });

  it("only the test process is handed the key; every other child gets none; without --model the key is dropped", () => {
    const withModel = rig("child");
    script.main(["--model"], { PATH: process.env.PATH, OMF_IMPLEMENTER_API_KEY: SENTINEL }, withModel.deps);
    const vitest = withModel.vitestCall();
    expect(vitest?.options.redact).toEqual([SENTINEL]);
    expect(vitest?.options.env?.OMF_IMPLEMENTER_API_KEY).toBe(SENTINEL);
    expect(vitest?.options.env?.OMF_GATED).toBe("docker+model");
    for (const call of withModel.calls.filter((c) => c !== vitest)) {
      expect(call.options.env?.OMF_IMPLEMENTER_API_KEY).toBeUndefined();
      expect(call.options.redact).toBeUndefined();
    }

    const plain = rig("pass");
    expect(script.main([], { PATH: "/bin", OMF_IMPLEMENTER_API_KEY: SENTINEL }, plain.deps)).toBe(EXIT.ok);
    expect(plain.vitestCall()?.options.env?.OMF_IMPLEMENTER_API_KEY).toBeUndefined();
    expect(plain.vitestCall()?.options.env?.OMF_GATED).toBe("docker");
    expect(plain.vitestCall()?.options).toMatchObject({ inherit: true });
    expect(plain.vitestCall()?.options.redact).toBeUndefined();
  });

  it("the children the driver really spawns without an explicit env inherit neither the implementer key nor the reconciler key", () => {
    const names = ["OMF_IMPLEMENTER_API_KEY", "ANTHROPIC_API_KEY"];
    const before = names.map((name) => process.env[name]);
    process.env.OMF_IMPLEMENTER_API_KEY = SENTINEL;
    process.env.ANTHROPIC_API_KEY = "sk-ant-planted-reconciler-key-0000";
    const PROBE =
      "process.stdout.write(JSON.stringify(['OMF_IMPLEMENTER_API_KEY','ANTHROPIC_API_KEY'].map((n) => n in process.env)))";
    const { deps, cleanup } = script.realDeps();
    try {
      const plain = deps.run(process.execPath, ["-e", PROBE]);
      expect(plain.stdout).toBe("[false,false]");
      const sunk: string[] = [];
      const redacted = script.runRedacted(
        process.execPath,
        ["-e", PROBE],
        { redact: [SENTINEL] },
        { stdout: (text) => sunk.push(text), stderr: () => undefined },
      );
      expect(redacted.status).toBe(0);
      expect(sunk.join("")).toBe("[false,false]");
      const viaDeps: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        viaDeps.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        deps.run(process.execPath, ["-e", PROBE], { redact: [SENTINEL] });
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(viaDeps.join("")).toBe("[false,false]");
    } finally {
      cleanup();
      names.forEach((name, index) => {
        const value = before[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });

  it.each([
    ["no key", { PATH: "/bin" }],
    ["an empty key", { PATH: "/bin", OMF_IMPLEMENTER_API_KEY: "" }],
    ["a key with a space", { PATH: "/bin", OMF_IMPLEMENTER_API_KEY: "has a space" }],
    ["a key over 512 characters", { PATH: "/bin", OMF_IMPLEMENTER_API_KEY: "k".repeat(513) }],
    [
      "a caller that already names docker+model",
      { PATH: "/bin", OMF_IMPLEMENTER_API_KEY: SENTINEL, OMF_GATED: "docker+model" },
    ],
  ])("--model with %s exits 2 before anything starts and prints no value", (_label, env) => {
    const r = rig("pass");
    expect(script.main(["--model"], env, r.deps)).toBe(EXIT.refused);
    expect(r.calls.some((call) => call.command === "colima" && call.args[0] !== "version")).toBe(false);
    expect(r.logs.join("\n")).not.toContain(SENTINEL);
    expect(r.logs.join("\n")).not.toContain("k".repeat(513));
  });

  it("--record stores the model report of the real run, and nothing that came from the key", () => {
    const r = rig("pass");
    expect(script.main(["--model", "--record"], { PATH: "/bin", OMF_IMPLEMENTER_API_KEY: SENTINEL }, r.deps)).toBe(
      EXIT.ok,
    );
    const runs = JSON.parse(readFileSync(r.evidenceFile, "utf8")).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ test: "G-implementer-real-run", model: MODEL_REPORT });
    expect(readFileSync(r.evidenceFile, "utf8")).not.toContain(SENTINEL);
  });
});
