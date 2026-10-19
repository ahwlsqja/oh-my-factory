// The exec behaviour behind the CLI acceptance (tests/helpers/cli-line.ts). The generated `docker` program of fakeDockerBin()
// loads this module once per call and asks it to answer `docker exec`; the daemon itself is fake-docker-core.mjs. Roles are told
// apart by container name (`omf-<role>-<run id>-<round>-<serial>`), and the protocol constants come from cli-line-hooks.json,
// written by the test from `src`, so none is copied here. Two things this module never does: run the kill-all exec (`kill -9 -1`
// on a host would be catastrophic), and run a command outside sh, tar, git and base64.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// matcher.js has type imports only, so loading it costs one file read per call.
const { evaluateExpect } = await import(new URL("../../dist/scenario/matcher.js", import.meta.url).href);

const reply = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });
const same = (a, b) => a.length === b.length && a.every((part, index) => part === b[index]);
const startsWith = (argv, prefix) => prefix.every((part, index) => argv[index] === part);
const FAULTS = new Set(["error", "refused"]);
const ALLOWED_COMMANDS = ["sh", "tar", "git", "base64"];
/** Any other script that signals processes widely is refused, never spawned on the host. */
const PROCESS_KILLER = /\b(pkill|killall)\b|\bkill\b[^\n]*(\s-1\b|\s-[A-Za-z0-9]+\s+-1\b)/;

/** `work`, `tmp` and `agent` stand for `/work`, `/tmp` and `/agent`; a root of their own stands for `/`. One tree per container. */
function treeOf(root, name) {
  const base = join(root, "trees", name);
  const tree = { root: base, work: join(base, "work"), tmp: join(base, "tmp"), agent: join(base, "agent") };
  for (const dir of [tree.work, tree.tmp, tree.agent]) mkdirSync(dir, { recursive: true });
  return tree;
}

function envFor(config, tree, extra) {
  return {
    ...Object.fromEntries(config.fixed_env),
    HOME: tree.agent,
    CLAUDE_CONFIG_DIR: join(tree.agent, "claude"),
    OMF_TMP: tree.tmp,
    PATH: config.tool_path,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

function runHere(config, tree, call, command, args) {
  const cwd = { "/work": tree.work, "/tmp": tree.tmp, "/agent": tree.agent }[call.workdir ?? ""] ?? tree.root;
  const done = spawnSync(command, args, {
    cwd,
    env: envFor(config, tree, call.env),
    input: call.stdin ?? undefined,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 60_000,
    killSignal: "SIGKILL",
    // Like LocalTreeContainer: the child leads its own process group, and the whole group is killed once the call returns, so a
    // stub script that backgrounds a job cannot outlive the test. The tree directories live under the temp root of the test.
    detached: true,
  });
  if (done.pid !== undefined) {
    try {
      process.kill(-done.pid, "SIGKILL");
    } catch {
      // the group is already gone (ESRCH), which is the normal case
    }
  }
  return reply(done.error === undefined ? (done.status ?? 137) : 127, done.stdout ?? "", done.stderr ?? "");
}

function implementer(config, root, call) {
  const tree = treeOf(root, call.name);
  const [command = "", ...args] = call.argv;
  if (same(call.argv, config.kill_all_argv)) return reply(0);
  if (same(call.argv, config.write_settings_argv)) {
    writeFileSync(join(tree.agent, "settings.json"), call.stdin ?? "");
    return reply(0);
  }
  // The session's client: the stub implementer script runs in /work with the prompt on stdin and the key in its environment.
  if (command === "claude") return runHere(config, tree, call, "/bin/sh", [config.implementer_script]);
  if (!ALLOWED_COMMANDS.includes(command)) return reply(127, "", `command not allowed in the local double: ${command}`);
  if (call.argv.some((part) => PROCESS_KILLER.test(part))) {
    return reply(126, "", "process-killing script refused by the local double");
  }
  return runHere(config, tree, call, command === "sh" ? "/bin/sh" : command, args);
}

/** Whether the tree last sent to this work copy holds the fix decides `npm test`, as in the in-process judge line. */
function workCopy(config, root, call) {
  const mark = join(root, `fix-${call.name}`);
  if (call.argv[0] === "tar") {
    if (call.stdin?.includes(config.fix_mark)) writeFileSync(mark, "1");
    else rmSync(mark, { force: true });
    return reply(0);
  }
  if (call.argv[0] === "npm" && call.argv[1] === "test") return reply(existsSync(mark) ? 0 : 1);
  return reply(0);
}

/** The harness side of the protocol (tests/helpers/sut-double.ts HarnessDouble), with its state in a file between calls. */
function harness(root, request) {
  const file = join(root, "harness.json");
  const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { set: null, runs: {} };
  const { nonce } = request;
  const scenario = (ref) => {
    const found = state.set?.scenarios.find((entry) => entry.scenario_ref === ref);
    if (found === undefined) throw new Error(`harness double: unknown scenario ${ref}`);
    return found;
  };
  let answer;
  switch (request.op) {
    case "load":
      state.set = request.set;
      state.runs = {};
      answer = { op: "load", nonce, scenarios_total: request.set.scenarios.length };
      break;
    case "begin": {
      const found = scenario(request.scenario_ref);
      state.runs[`${request.scenario_ref}#${request.rep}`] = {
        scenario_ref: request.scenario_ref,
        rep: request.rep,
        outcome: "pass",
        steps_passed: 0,
        steps_total: found.steps.length,
      };
      answer = { op: "begin", nonce, steps_total: found.steps.length, invoke: found.steps[0].invoke };
      break;
    }
    case "observe": {
      const found = scenario(request.scenario_ref);
      const step = found.steps[request.step_index];
      const run = state.runs[`${request.scenario_ref}#${request.rep}`];
      if (step === undefined || run === undefined) throw new Error("harness double: observe out of order");
      const pass = evaluateExpect({ ...step.expect, note: "" }, request.observation).pass;
      if (pass) run.steps_passed += 1;
      else run.outcome = FAULTS.has(request.observation.outcome) ? "error" : "fail";
      const next = found.steps[request.step_index + 1];
      answer = { op: "observe", nonce, step_pass: pass, next: pass && next !== undefined ? next.invoke : null };
      break;
    }
    case "verdict":
      answer = { op: "verdict", nonce, verdict: { schema_version: 1, nonce, runs: Object.values(state.runs) } };
      break;
    default:
      throw new Error("harness double: unknown op");
  }
  writeFileSync(file, JSON.stringify(state));
  return answer;
}

export default function createHooks({ stateDir }) {
  const config = JSON.parse(readFileSync(join(stateDir, "cli-line-hooks.json"), "utf8"));
  const root = realpathSync(stateDir);
  return {
    exec(call) {
      // The author container is the one this fixture never answers: its stage stays unmeasured.
      if (call.name.startsWith("omf-author-")) return reply(0);
      if (same(call.argv, config.probe_argv)) return reply(0, "socket:0\nend\n");
      if (call.name.startsWith("omf-harness-")) {
        if (!same(call.argv, config.harness_argv)) return reply(0);
        return reply(0, `${JSON.stringify(harness(root, JSON.parse(call.stdin.toString("utf8"))))}\n`);
      }
      if (call.name.startsWith("omf-sut-")) {
        const step = startsWith(call.argv, config.contract_run) ? call.argv.slice(config.contract_run.length) : [];
        return reply(0, step[0] === "cache" && step[1] === "get" ? config.sut_output : "");
      }
      if (call.name.startsWith("omf-workcopy-")) return workCopy(config, root, call);
      if (call.name.startsWith("omf-implementer-")) return implementer(config, root, call);
      return reply(0);
    },
  };
}
