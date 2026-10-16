import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";
import { makeTempDir } from "../helpers/tmp.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/gated-docker.mjs", import.meta.url));
const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/gated-runs.json", import.meta.url));
const CI = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
interface Deps {
  run: (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }) => RunResult;
  makeTempDir: (prefix: string) => string;
  log: (message: string) => void;
  now: () => Date;
  root: string;
  evidenceFile: string;
}
const script = (await import(SCRIPT)) as {
  PROFILE: string;
  CONTEXT: string;
  EXIT: { ok: number; failed: number; refused: number; colima: number };
  colimaPlan: () => {
    start: string[];
    stop: string[];
    contextHost: string[];
    currentContext: string[];
    restoreContext: (name: string) => string[];
  };
  parseArgs: (argv: string[]) => { only: string | null; record: boolean; model: boolean } | { error: string };
  dockerConfigFor: (dir: string, host: string) => string;
  gatedEnv: (
    env: Record<string, string | undefined>,
    dockerConfig: string,
    omfHome: string,
    options?: { model?: boolean; report?: string },
  ) => Record<string, string>;
  createRedactor: (secrets: string[]) => { write: (chunk: string | Buffer) => string; flush: () => string };
  childEnv: (env: Record<string, string | undefined>) => Record<string, string>;
  recordsFromVitest: (report: unknown, meta: Record<string, unknown>) => Array<Record<string, unknown>>;
  appendGatedRuns: (file: string, records: unknown[]) => void;
  main: (argv: string[], env: Record<string, string | undefined>, deps: Deps) => number;
};
const { EXIT, CONTEXT, PROFILE } = script;

const COMMIT = "a".repeat(40);
const RECORD = {
  test: "G-inspect-parser-real",
  result: "pass",
  at: "2026-10-15T00:00:00.000Z",
  omf_commit: COMMIT,
  docker: { server_version: "29.0.0", context: "colima-omf-m3f", arch: "aarch64" },
};

describe("colima plan", () => {
  it("names only the omf-m3f profile and the colima-omf-m3f context, and never deletes anything", () => {
    const plan = script.colimaPlan();
    expect(plan.start).toEqual(["colima", "start", "omf-m3f", "--cpu", "2", "--memory", "4", "--activate=false"]);
    expect(plan.stop).toEqual(["colima", "stop", "omf-m3f"]);
    expect(plan.contextHost).toEqual([
      "docker",
      "context",
      "inspect",
      "colima-omf-m3f",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]);
    const names = JSON.stringify(plan).match(/[A-Za-z0-9-]*omf[A-Za-z0-9-]*/g) ?? [];
    expect(new Set(names)).toEqual(new Set(["omf-m3f", "colima-omf-m3f"]));
    expect(JSON.stringify(plan)).not.toMatch(/delete|a1-bench/);
  });

  it("the script source has no delete verb and names no other profile", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/\bdelete\b/i);
    expect(source).not.toContain("a1-bench");
  });
});

describe("dockerConfigFor", () => {
  const HOST = "unix:///home/dev/.colima/omf-m3f/docker.sock";

  it("writes a config that holds exactly the omf-m3f context", () => {
    const dir = script.dockerConfigFor(makeTempDir("omf-gated-cfg-"), HOST);
    const id = createHash("sha256").update(CONTEXT).digest("hex");
    expect(readdirSync(join(dir, "contexts", "meta"))).toEqual([id]);
    const meta = JSON.parse(readFileSync(join(dir, "contexts", "meta", id, "meta.json"), "utf8"));
    expect(meta.Name).toBe(CONTEXT);
    expect(meta.Endpoints.docker.Host).toBe(HOST);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({ currentContext: CONTEXT });
  });

  it.each([
    "tcp://10.0.0.5:2375",
    "ssh://dev@host",
    "unix:///home/dev/.colima/default/docker.sock",
    "unix:///var/run/docker.sock",
  ])("refuses the endpoint %s", (host) => {
    expect(() => script.dockerConfigFor(makeTempDir("omf-gated-cfg-"), host)).toThrow(/omf-m3f socket/);
  });
});

describe("arguments and environment", () => {
  it("accepts --only and --record and refuses anything else", () => {
    expect(script.parseArgs([])).toEqual({ only: null, record: false, model: false });
    expect(script.parseArgs(["--only", "G-x", "--record"])).toEqual({ only: "G-x", record: true, model: false });
    expect(script.parseArgs(["--model"])).toEqual({ only: null, record: false, model: true });
    expect(script.parseArgs(["--only"])).toEqual({ error: "--only needs a test name" });
    expect(script.parseArgs(["--profile", "default"])).toEqual({ error: "unknown argument: --profile" });
  });

  it("passes the two image digests through and nothing else from the OMF namespace", () => {
    const env = script.gatedEnv(
      {
        PATH: "/bin",
        OMF_GATED_BASE_IMAGE: "r/a@sha256:1",
        OMF_GATED_HARNESS_IMAGE: "r/n@sha256:2",
        OMF_API_TOKEN: "x",
      },
      "/tmp/cfg",
      "/tmp/omf-home",
    );
    expect(env.OMF_GATED_BASE_IMAGE).toBe("r/a@sha256:1");
    expect(env.OMF_GATED_HARNESS_IMAGE).toBe("r/n@sha256:2");
    expect(env.OMF_API_TOKEN).toBeUndefined();
  });

  it("gives the test process only a short list of variables, never HOME or a key", () => {
    const env = script.gatedEnv(
      { PATH: "/bin", HOME: "/home/dev", ANTHROPIC_API_KEY: "k", OMF_HOME: "/home/dev/.omf", TMPDIR: "/tmp/x" },
      "/tmp/cfg",
      "/tmp/omf-home",
    );
    expect(env).toEqual({
      PATH: "/bin",
      DOCKER_CONFIG: "/tmp/cfg",
      OMF_GATED: "docker",
      OMF_GATED_CONTEXT: "colima-omf-m3f",
      OMF_HOME: "/tmp/omf-home",
      TMPDIR: "/tmp/x",
    });
  });
});

describe("the run record", () => {
  it("the committed file validates against the schema", () => {
    expect(validate("gated-runs.schema.json", JSON.parse(readFileSync(EVIDENCE, "utf8")))).toEqual({ ok: true });
  });

  it("appends a valid record and rejects an invalid one without touching the file", () => {
    const file = join(makeTempDir("omf-gated-ev-"), "gated-runs.json");
    writeFileSync(file, `${JSON.stringify({ schema_version: 1, runs: [] })}\n`);
    script.appendGatedRuns(file, [RECORD]);
    expect(JSON.parse(readFileSync(file, "utf8")).runs).toEqual([RECORD]);

    const before = readFileSync(file, "utf8");
    for (const bad of [
      { ...RECORD, omf_commit: "abc" },
      { ...RECORD, result: "fail" },
      { ...RECORD, docker: { ...RECORD.docker, context: "default" } },
      { ...RECORD, extra: 1 },
    ]) {
      expect(() => script.appendGatedRuns(file, [bad])).toThrow(/gated run record rejected/);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("ci.yml names both Docker switches in its comment", () => {
    const ci = readFileSync(CI, "utf8");
    expect(ci).toContain("OMF_TEST_DOCKER and OMF_GATED are deliberately unset");
  });
});

const OK: RunResult = { status: 0, stdout: "", stderr: "" };
const BASE: Record<string, RunResult> = {
  "colima version": OK,
  "docker --version": OK,
  "colima start": OK,
  "docker context inspect": { ...OK, stdout: "unix:///home/dev/.colima/omf-m3f/docker.sock\n" },
  "docker context show": { ...OK, stdout: "default\n" },
  "colima stop": OK,
  "git status": OK,
  "git rev-parse": { ...OK, stdout: `${COMMIT}\n` },
  "docker --context": { ...OK, stdout: "29.0.0 aarch64\n" },
  vitest: OK,
};
const REPORT = {
  testResults: [
    {
      assertionResults: [
        { ancestorTitles: ["G-inspect-parser-real"], status: "passed" },
        { ancestorTitles: ["G-two-container-roundtrip"], status: "passed" },
        { ancestorTitles: ["G-two-container-roundtrip"], status: "skipped" },
        { ancestorTitles: ["gated helpers"], status: "passed" },
      ],
    },
  ],
};

/** A fake runner: records every command line, answers from BASE, and writes the vitest report when asked. */
function harness(overrides: Record<string, Partial<RunResult>> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const root = makeTempDir("omf-gated-root-");
  const evidenceFile = join(root, "gated-runs.json");
  writeFileSync(evidenceFile, `${JSON.stringify({ schema_version: 1, runs: [] })}\n`);
  const deps: Deps = {
    run: (command, args) => {
      calls.push([command, ...args].join(" "));
      const isVitest = args.some((arg) => arg.endsWith("vitest.mjs"));
      const key = isVitest ? "vitest" : `${command} ${args[0] ?? ""}${args[0] === "context" ? ` ${args[1]}` : ""}`;
      const out = args.find((arg) => arg.startsWith("--outputFile.json="));
      if (isVitest && out !== undefined) writeFileSync(out.slice("--outputFile.json=".length), JSON.stringify(REPORT));
      return { ...(BASE[key] ?? OK), ...overrides[key] };
    },
    makeTempDir,
    log: (message) => logs.push(message),
    now: () => new Date(Date.UTC(2026, 9, 15)),
    root,
    evidenceFile,
  };
  return { deps, calls, logs, evidenceFile };
}

describe("main", () => {
  it("starts the profile, runs the gated tests, stops the profile", () => {
    const { deps, calls } = harness();
    expect(script.main([], {}, deps)).toBe(EXIT.ok);
    expect(calls).toEqual([
      "colima version",
      "docker --version",
      "docker context show",
      "colima start omf-m3f --cpu 2 --memory 4 --activate=false",

      "docker context inspect colima-omf-m3f --format {{.Endpoints.docker.Host}}",
      expect.stringMatching(
        /vitest\.mjs run tests\/gated --reporter=default --reporter=json --outputFile\.json=.+vitest\.json$/,
      ),
      "colima stop omf-m3f",
      "docker context show",
    ]);
    expect(calls.filter((call) => call.startsWith("colima ") && call !== "colima version")).toSatisfy(
      (list: string[]) => list.every((call) => call.split(" ")[2] === PROFILE),
    );
  });

  it("restores the user's current context if the run changed it", () => {
    const { deps, calls } = harness();
    const run = deps.run;
    let shows = 0;
    deps.run = (command, args, options) => {
      if (command === "docker" && args[0] === "context" && args[1] === "show") {
        shows += 1;
        calls.push("docker context show");
        return { status: 0, stdout: shows === 1 ? "desktop-linux\n" : "colima-omf-m3f\n", stderr: "" };
      }
      return run(command, args, options);
    };
    expect(script.main([], {}, deps)).toBe(EXIT.ok);
    expect(calls.at(-2)).toBe("docker context show");
    expect(calls.at(-1)).toBe("docker context use desktop-linux");
    expect(calls.indexOf("docker context show")).toBeLessThan(
      calls.indexOf("colima start omf-m3f --cpu 2 --memory 4 --activate=false"),
    );
  });

  it("passes --only to vitest as -t", () => {
    const { deps, calls } = harness();
    script.main(["--only", "G-inspect-parser-real"], {}, deps);
    expect(calls.some((call) => call.endsWith(" -t G-inspect-parser-real"))).toBe(true);
  });

  it("stops the profile when a gated test fails (exit 1)", () => {
    const { deps, calls } = harness({ vitest: { status: 1 } });
    expect(script.main([], {}, deps)).toBe(EXIT.failed);
    expect(calls.at(-2)).toBe("colima stop omf-m3f");
  });

  it("exits 3 and still stops when colima cannot start the profile", () => {
    const { deps, calls } = harness({ "colima start": { status: 1 } });
    expect(script.main([], {}, deps)).toBe(EXIT.colima);
    expect(calls.at(-2)).toBe("colima stop omf-m3f");
    expect(calls.some((call) => call.includes("vitest"))).toBe(false);
  });

  it("exits 2 and still stops when the context points at another socket", () => {
    const { deps, calls } = harness({
      "docker context inspect": { stdout: "unix:///home/dev/.colima/default/docker.sock\n" },
    });
    expect(script.main([], {}, deps)).toBe(EXIT.refused);
    expect(calls.at(-2)).toBe("colima stop omf-m3f");
  });

  it.each([
    ["colima is missing", { "colima version": { status: 127 } }, {}],
    ["docker is missing", { "docker --version": { status: 127 } }, {}],
    ["OMF_GATED names another switch", {}, { OMF_GATED: "podman" }],
    ["--record meets a dirty tree", { "git status": { stdout: " M src/x.ts\n" } }, {}],
  ])("exits 2 and starts nothing when %s", (label, overrides, env) => {
    const { deps, calls } = harness(overrides);
    const argv = label.startsWith("--record") ? ["--record"] : [];
    expect(script.main(argv, env, deps)).toBe(EXIT.refused);
    expect(calls.some((call) => call.startsWith("colima start") || call.startsWith("colima stop"))).toBe(false);
  });

  it("--record appends one record per fully passed G- suite and nothing else", () => {
    const { deps, evidenceFile } = harness();
    expect(script.main(["--record"], {}, deps)).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(evidenceFile, "utf8")).runs).toEqual([RECORD]);
  });

  it("--record stamps the commit read before the run, not the one found after it", () => {
    const { deps, calls, evidenceFile } = harness();
    const run = deps.run;
    let reads = 0;
    deps.run = (command, args, options) => {
      if (command === "git" && args[0] === "rev-parse") {
        reads += 1;
        calls.push("git rev-parse");
        return { status: 0, stdout: `${(reads === 1 ? "a" : "b").repeat(40)}\n`, stderr: "" };
      }
      return run(command, args, options);
    };
    expect(script.main(["--record"], {}, deps)).toBe(EXIT.ok);
    expect(reads).toBe(1);
    expect(calls.indexOf("git rev-parse")).toBeLessThan(calls.findIndex((call) => call.startsWith("colima start")));
    expect(JSON.parse(readFileSync(evidenceFile, "utf8")).runs).toEqual([RECORD]);
  });

  it("--record writes nothing when the tests failed", () => {
    const { deps, evidenceFile } = harness({ vitest: { status: 1 } });
    expect(script.main(["--record"], {}, deps)).toBe(EXIT.failed);
    expect(JSON.parse(readFileSync(evidenceFile, "utf8")).runs).toEqual([]);
  });
});

describe("model mode environment", () => {
  const BASE = {
    PATH: "/bin",
    OMF_IMPLEMENTER_API_KEY: "key-value-1",
    ANTHROPIC_API_KEY: "reconciler-key",
    OMF_GATED_IMPLEMENTER_IMAGE: "sha256:a",
    OMF_API_TOKEN: "t",
  };

  it("--model switches to docker+model and adds exactly the implementer key and the report path; without it the key is dropped, and ANTHROPIC_API_KEY never passes", () => {
    const plain = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home");
    const model = script.gatedEnv(BASE, "/tmp/cfg", "/tmp/omf-home", {
      model: true,
      report: "/tmp/r/model-report.json",
    });
    expect(plain.OMF_GATED).toBe("docker");
    expect(plain.OMF_IMPLEMENTER_API_KEY).toBeUndefined();
    expect(plain.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plain.OMF_GATED_IMPLEMENTER_IMAGE).toBe("sha256:a");
    expect(plain.OMF_API_TOKEN).toBeUndefined();
    expect(model).toEqual({
      ...plain,
      OMF_GATED: "docker+model",
      OMF_IMPLEMENTER_API_KEY: "key-value-1",
      OMF_GATED_MODEL_REPORT: "/tmp/r/model-report.json",
    });
    expect(
      script.gatedEnv({ ...BASE, OMF_IMPLEMENTER_API_KEY: "" }, "/c", "/h", { model: true }).OMF_IMPLEMENTER_API_KEY,
    ).toBeUndefined();
  });

  it("childEnv removes the key and keeps everything else, for the children that are not the test process", () => {
    expect(script.childEnv({ PATH: "/bin", OMF_IMPLEMENTER_API_KEY: "k", ANTHROPIC_API_KEY: "r", HOME: "/h" })).toEqual(
      { PATH: "/bin", HOME: "/h" },
    );
  });
});

describe("createRedactor", () => {
  const KEY = "sk-ant-SECRET-0123456789";
  const run = (chunks: Array<string | Buffer>, secrets: string[] = [KEY]): string => {
    const redactor = script.createRedactor(secrets);
    return [...chunks.map((chunk) => redactor.write(chunk)), redactor.flush()].join("");
  };

  it("replaces the secret wherever the chunk boundary falls, also one character at a time", () => {
    const text = `before ${KEY} after ${KEY}`;
    for (let cut = 1; cut < text.length; cut += 1) {
      expect(run([text.slice(0, cut), text.slice(cut)])).toBe("before [redacted] after [redacted]");
    }
    expect(run([...text])).toBe("before [redacted] after [redacted]");
  });

  it("also hides the JSON-escaped spelling of a secret that holds a quote and a backslash", () => {
    const key = 'a"b\\c-0123456789';
    expect(run([JSON.stringify({ key })], [key])).toBe('{"key":"[redacted]"}');
  });

  it("holds back only a possible start of the secret, and redacts a stream that ends inside one", () => {
    const redactor = script.createRedactor([KEY]);
    expect(redactor.write("plain output sk-ant-SEC")).toBe("plain output ");
    expect(redactor.write("RET-0123456789!")).toBe("[redacted]!");
    expect(redactor.flush()).toBe("");
    const cut = script.createRedactor([KEY]);
    expect(cut.write("x sk-ant-SEC")).toBe("x ");
    expect(cut.flush()).toBe("[redacted]");
  });

  it("keeps a multi-byte character that is split between two chunks", () => {
    const bytes = Buffer.from("héllo wörld", "utf8");
    expect(run([bytes.subarray(0, 2), bytes.subarray(2)])).toBe("héllo wörld");
  });
});

describe("the optional model field of a run record", () => {
  const MODEL = { vendor: "claude", name: "default", spend_micro_usd: 123456, log_bytes: 2048 };

  it("accepts the model report (an unknown cost is null), rejects free text and extra fields, and recordsFromVitest attaches it to the real-run suite only", () => {
    const file = join(makeTempDir("omf-gated-ev-"), "gated-runs.json");
    writeFileSync(file, `${JSON.stringify({ schema_version: 1, runs: [] })}\n`);
    const real = { ...RECORD, test: "G-implementer-real-run" };
    script.appendGatedRuns(file, [
      { ...real, model: MODEL },
      { ...real, model: { ...MODEL, spend_micro_usd: null } },
    ]);
    const before = readFileSync(file, "utf8");
    for (const bad of [
      { ...MODEL, name: "free text with a space" },
      { ...MODEL, vendor: "codex" },
      { ...MODEL, spend_micro_usd: -1 },
      { ...MODEL, note: "x" },
      { vendor: "claude", name: "default", spend_micro_usd: 1 },
    ]) {
      expect(() => script.appendGatedRuns(file, [{ ...real, model: bad }])).toThrow(/gated run record rejected/);
    }
    expect(readFileSync(file, "utf8")).toBe(before);

    const passed = ["G-implementer-real-run", "G-e6-l2-leak-redteam"].map((name) => ({
      ancestorTitles: [name],
      status: "passed",
    }));
    const report = { testResults: [{ assertionResults: passed }] };
    const meta = { at: RECORD.at, commit: COMMIT, docker: RECORD.docker };
    expect(script.recordsFromVitest(report, { ...meta, model: MODEL }).map((r) => [r.test, "model" in r])).toEqual([
      ["G-implementer-real-run", true],
      ["G-e6-l2-leak-redteam", false],
    ]);
    expect(script.recordsFromVitest(report, { ...meta, model: null }).some((r) => "model" in r)).toBe(false);
  });
});
