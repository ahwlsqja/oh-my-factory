#!/usr/bin/env node
// Runs the Docker-gated test suites (tests/gated) on the dedicated colima profile `omf-m3f` and nowhere else.
//
//   npm run test:gated                          start the profile, run every gated suite, stop the profile
//   npm run test:gated -- --only G-<suite>      run one suite (vitest -t)
//   OMF_IMPLEMENTER_API_KEY=<dedicated, spend-limited key> npm run test:gated -- --only G-<suite>
//                                               for a suite that calls a real model: the key is passed to the
//                                               test process under that name only, never ANTHROPIC_API_KEY
//   npm run test:gated -- --record              also append one record per fully passed suite to
//                                               docs/evidence/gated-runs.json (clean working tree only)
//
// Exit codes: 0 every selected gated test passed; 1 a gated test failed or nothing could be recorded;
// 2 refused (colima or docker missing, another OMF_GATED value, a context that is not the omf-m3f socket,
// --record on a dirty tree, an unknown argument); 3 colima could not start the profile.
//
// The run never changes the user's current Docker context (`--activate=false`, and it is restored if it changed anyway).
//
// The script names exactly one profile and one context. It never touches another profile and never removes
// one: the machine runs other colima profiles that belong to other work. The test process gets a temporary
// DOCKER_CONFIG that holds only the omf-m3f context, a temporary OMF_HOME, and no HOME.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

export const PROFILE = "omf-m3f";
export const CONTEXT = "colima-omf-m3f";
export const EXIT = { ok: 0, failed: 1, refused: 2, colima: 3 };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = new URL("../schemas/gated-runs.schema.json", import.meta.url);
/** colima's socket for the profile; a context that points anywhere else is refused. */
const HOST_PATTERN = /^unix:\/\/\/.+\/omf-m3f\/docker\.sock$/;

/** The only colima and docker commands the driver runs against the profile, as data so a test can read them. */
export function colimaPlan() {
  return {
    start: ["colima", "start", PROFILE, "--cpu", "2", "--memory", "4", "--activate=false"],
    stop: ["colima", "stop", PROFILE],
    // Read-only: the user's current Docker context, noted before the start so a run can leave it as it found it.
    currentContext: ["docker", "context", "show"],
    restoreContext: (name) => ["docker", "context", "use", name],
    // Read-only: asks the user's docker config where colima put the profile's socket.
    contextHost: ["docker", "context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}"],
  };
}

export function parseArgs(argv) {
  let only = null;
  let record = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--record") record = true;
    else if (arg === "--only") {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith("--")) return { error: "--only needs a test name" };
      only = name;
      i += 1;
    } else return { error: `unknown argument: ${arg}` };
  }
  return { only, record };
}

/**
 * Writes a docker config directory that holds the omf-m3f context and nothing else, so the test process
 * cannot reach any other daemon even by mistake. The context directory is named by the sha256 of the
 * context name, which is how the docker CLI stores contexts.
 */
export function dockerConfigFor(dir, host) {
  if (!HOST_PATTERN.test(host)) throw new Error(`the ${CONTEXT} endpoint is not the ${PROFILE} socket`);
  const metaDir = join(dir, "contexts", "meta", createHash("sha256").update(CONTEXT).digest("hex"));
  mkdirSync(metaDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ currentContext: CONTEXT })}\n`, { mode: 0o600 });
  const meta = { Name: CONTEXT, Metadata: {}, Endpoints: { docker: { Host: host, SkipTLSVerify: false } } };
  writeFileSync(join(metaDir, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  return dir;
}

/** The whole environment of the test process. No HOME and never ANTHROPIC_API_KEY; the only caller variables passed are TMPDIR, the fixture switch, the two gated image digests and the dedicated implementer key. */
export function gatedEnv(env, dockerConfig, omfHome) {
  const out = {
    PATH: env.PATH ?? "",
    DOCKER_CONFIG: dockerConfig,
    OMF_GATED: "docker",
    OMF_GATED_CONTEXT: CONTEXT,
    OMF_HOME: omfHome,
  };
  for (const name of [
    "TMPDIR",
    "OMF_CAPTURE_FIXTURES",
    "OMF_GATED_BASE_IMAGE",
    "OMF_GATED_HARNESS_IMAGE",
    "OMF_IMPLEMENTER_API_KEY",
  ]) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  return out;
}

let validator;
export function checkGatedRuns(doc) {
  validator ??= new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf8")));
  if (validator(doc)) return { ok: true };
  return { ok: false, errors: validator.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") };
}

/** Appends records after checking the whole resulting document against the schema; a rejected record leaves the file untouched. */
export function appendGatedRuns(file, records) {
  const current = JSON.parse(readFileSync(file, "utf8"));
  const before = checkGatedRuns(current);
  if (!before.ok) throw new Error(`gated run record rejected: the existing file is invalid: ${before.errors}`);
  const next = { ...current, runs: [...current.runs, ...records] };
  const after = checkGatedRuns(next);
  if (!after.ok) throw new Error(`gated run record rejected: ${after.errors}`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, file);
}

/** One record per `G-` suite (the top-level describe) in which every test passed; a skipped test disqualifies the suite. */
export function recordsFromVitest(report, meta) {
  const suites = new Map();
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      const name = test.ancestorTitles?.[0];
      if (typeof name !== "string" || !name.startsWith("G-")) continue;
      suites.set(name, (suites.get(name) ?? true) && test.status === "passed");
    }
  }
  return [...suites]
    .filter(([, passed]) => passed)
    .map(([test]) => ({ test, result: "pass", at: meta.at, omf_commit: meta.commit, docker: meta.docker }));
}

function refuse(deps, message) {
  deps.log(`refused: ${message}`);
  return EXIT.refused;
}

function record(deps, testEnv, reportFile, head) {
  const info = deps.run("docker", ["--context", CONTEXT, "info", "--format", "{{.ServerVersion}} {{.Architecture}}"], {
    env: { PATH: testEnv.PATH, DOCKER_CONFIG: testEnv.DOCKER_CONFIG },
  });
  const match = /^(\S+) (\S+)$/.exec(info.stdout.trim());
  if (info.status !== 0 || match === null) {
    deps.log("could not read the docker server version, nothing recorded");
    return EXIT.failed;
  }
  try {
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    const records = recordsFromVitest(report, {
      at: deps.now().toISOString(),
      commit: head,
      docker: { server_version: match[1], context: CONTEXT, arch: match[2] },
    });
    if (records.length === 0) {
      deps.log("no G- suite passed completely, nothing recorded");
      return EXIT.failed;
    }
    appendGatedRuns(deps.evidenceFile, records);
    deps.log(`recorded ${records.map((r) => r.test).join(", ")}`);
    return EXIT.ok;
  } catch (err) {
    deps.log(`nothing recorded: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.failed;
  }
}

/**
 * The whole run, with every process and clock injected so a test drives it with a fake runner. The profile
 * is stopped in `finally`, including after a failed start or a refusal that happens after the start.
 */
export function main(argv, env, deps) {
  const args = parseArgs(argv);
  if ("error" in args) return refuse(deps, args.error);
  if (env.OMF_GATED !== undefined && env.OMF_GATED !== "docker")
    return refuse(deps, 'OMF_GATED must be unset or "docker"');
  for (const [tool, probe] of [
    ["colima", ["version"]],
    ["docker", ["--version"]],
  ]) {
    if (deps.run(tool, probe, {}).status !== 0) return refuse(deps, `${tool} is not installed or does not run`);
  }
  // The commit is read together with the clean-tree check, before the run: the record names the code that was tested.
  let head = "";
  if (args.record) {
    const tree = deps.run("git", ["status", "--porcelain"], { cwd: deps.root });
    if (tree.status !== 0 || tree.stdout.trim() !== "") return refuse(deps, "--record needs a clean working tree");
    const read = deps.run("git", ["rev-parse", "HEAD"], { cwd: deps.root });
    head = read.stdout.trim();
    if (read.status !== 0 || head === "") return refuse(deps, "--record could not read the current commit");
  }

  const plan = colimaPlan();
  const exec = (argvList, options = {}) => deps.run(argvList[0], argvList.slice(1), options);
  // `--activate=false` keeps colima from switching the user's current context; this is the backstop if it ever does.
  const before = exec(plan.currentContext);
  const previous = before.status === 0 ? before.stdout.trim() : "";
  try {
    if (exec(plan.start).status !== 0) {
      deps.log(`colima could not start the ${PROFILE} profile`);
      return EXIT.colima;
    }
    const located = exec(plan.contextHost);
    const host = located.stdout.trim();
    if (located.status !== 0 || !HOST_PATTERN.test(host)) {
      return refuse(deps, `the ${CONTEXT} context does not point at the ${PROFILE} socket`);
    }
    const dockerConfig = dockerConfigFor(deps.makeTempDir("omf-gated-docker-"), host);
    const testEnv = gatedEnv(env, dockerConfig, deps.makeTempDir("omf-gated-home-"));
    const reportFile = join(deps.makeTempDir("omf-gated-report-"), "vitest.json");
    const vitest = exec(
      [
        process.execPath,
        join(deps.root, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "tests/gated",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportFile}`,
        ...(args.only === null ? [] : ["-t", args.only]),
      ],
      { cwd: deps.root, env: testEnv, inherit: true },
    );
    if (vitest.status !== 0) return EXIT.failed;
    return args.record ? record(deps, testEnv, reportFile, head) : EXIT.ok;
  } finally {
    exec(plan.stop);
    if (previous !== "" && previous !== CONTEXT) {
      const after = exec(plan.currentContext);
      if (after.status === 0 && after.stdout.trim() !== previous) exec(plan.restoreContext(previous));
    }
  }
}

function realDeps() {
  const made = [];
  return {
    cleanup: () => {
      for (const dir of made) rmSync(dir, { recursive: true, force: true });
    },
    deps: {
      run: (command, args, options = {}) => {
        const result = spawnSync(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          encoding: "utf8",
          stdio: options.inherit === true ? "inherit" : "pipe",
        });
        return { status: result.status ?? 127, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
      makeTempDir: (prefix) => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        made.push(dir);
        return dir;
      },
      log: (message) => process.stderr.write(`${message}\n`),
      now: () => new Date(),
      root: ROOT,
      evidenceFile: join(ROOT, "docs", "evidence", "gated-runs.json"),
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { deps, cleanup } = realDeps();
  try {
    process.exitCode = main(process.argv.slice(2), process.env, deps);
  } finally {
    cleanup();
  }
}
