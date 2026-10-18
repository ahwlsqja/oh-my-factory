// The only thing every contract shares. It spawns the built `omf` and reads files; it imports nothing from the
// repository that ships it (no src/, no dist/, no tests/), so any checkout of this directory can be pointed at any
// build with OMF_OUTER_BIN. Standard library only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTER = resolve(HERE, "..");
const REFUSING_DIRS = [join(HERE, "refusing-docker"), join(HERE, "refusing-agents")];
const TTY_DRIVER = join(HERE, "tty-run.py");

export const GOAL = "g-hello";

/** Environment names a contract child never inherits: locations, credentials and anything that names a daemon. */
const SCRUBBED =
  /^(GIT_|XDG_|OMF_|ANTHROPIC_|OPENAI_|CLAUDE|CODEX|GH_|GITHUB_|AWS_|DOCKER_)|(_API_KEY|_TOKEN|_SECRET)$/;

/** The caller's environment without locations and credentials; HOME, OMF_HOME and PATH are set by the world. */
export function cleanEnv(base) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !SCRUBBED.test(name)));
}

/** The executable under test: a path to a built `omf` entry point, taken from OMF_OUTER_BIN. */
export function omfBin() {
  const bin = process.env.OMF_OUTER_BIN;
  if (bin === undefined || bin === "")
    throw new Error("OMF_OUTER_BIN must name the built omf entry point (dist/cli/main.js)");
  return resolve(bin);
}

function pythonCommand() {
  return process.env.OMF_OUTER_PYTHON ?? "python3";
}

/** True when the terminal driver can run: python3 with the standard `pty` module. */
export function ttyAvailable() {
  const probe = spawnSync(pythonCommand(), ["-c", "import pty"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * What a contract that needs a terminal passes as its `skip` option: false when it can run, or when the run must
 * fail loudly instead (--require-tty sets OMF_OUTER_REQUIRE_TTY=1); otherwise the reason it is skipped.
 */
export function ttySkip() {
  if (process.env.OMF_OUTER_REQUIRE_TTY === "1" || ttyAvailable()) return false;
  return "no terminal driver (python3 with pty); install python3 or run with --require-tty to fail instead";
}

function toText(result) {
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Throws unless the result exited 0; the message carries both streams so a failed setup step explains itself. */
export function must(label, result) {
  if (result.code !== 0) {
    throw new Error(`${label} exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/** Maps every path under `dir` to its content hash (directories to "dir"), skipping the named top-level entries. */
export function snapshot(dir, skip = []) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path);
      if (skip.includes(rel.split("/")[0])) continue;
      if (entry.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(path);
      } else {
        out[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * A temporary world: a HOME, an OMF_HOME outside the repository, and a one-commit git repository, none of them the
 * real ones. `omf()` runs the built executable in it with a scrubbed environment and the refusing docker first on
 * PATH. `cleanup()` removes everything.
 */
export function createWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omf-outer-")));
  const home = join(root, "home");
  const omfHome = join(root, "omf-home");
  const repo = join(root, "repo");
  for (const dir of [home, repo]) mkdirSync(dir);
  for (const dir of REFUSING_DIRS) for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o755);

  const baseEnv = () => ({
    ...cleanEnv(process.env),
    HOME: home,
    OMF_HOME: omfHome,
    PATH: [...REFUSING_DIRS, process.env.PATH ?? ""].join(delimiter),
    LC_ALL: "C",
    NO_COLOR: "1",
  });

  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, env: baseEnv(), encoding: "utf8" });
    return must(`git ${args.join(" ")}`, toText(result));
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "outer@example.invalid");
  git("config", "user.name", "omf-outer");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# outer fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");

  const world = {
    root,
    home,
    omfHome,
    repo,
    git,
    /** Runs omf. `env` entries are added last (a contract may set OMF_HOME or a dummy key); stdin is /dev/null. */
    omf(args, { cwd = repo, env = {} } = {}) {
      const result = spawnSync(process.execPath, [omfBin(), ...args], {
        cwd,
        env: { ...baseEnv(), ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return toText(result);
    },
    /** Runs omf on a pseudo terminal and types `line` into it (the retype of a J-decision). */
    tty(line, args, { cwd = repo, env = {} } = {}) {
      if (!ttyAvailable())
        throw new Error("the terminal driver is not available (python3 with pty); --require-tty makes this a failure");
      const result = spawnSync(pythonCommand(), [TTY_DRIVER, line, process.execPath, omfBin(), ...args], {
        cwd,
        env: { ...baseEnv(), ...env },
        encoding: "utf8",
      });
      return toText(result);
    },
    projectDir() {
      const projects = join(omfHome, "projects");
      const ids = readdirSync(projects);
      if (ids.length !== 1) throw new Error(`expected one project under ${projects}, found ${ids.length}`);
      return join(projects, ids[0]);
    },
    ledgerPath() {
      return join(world.projectDir(), "ledger.jsonl");
    },
    ledgerBytes() {
      return readFileSync(world.ledgerPath());
    },
    /** The ledger's events, parsed straight from the file: the contracts read the bytes, not the CLI. */
    events() {
      return readFileSync(world.ledgerPath(), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}

/** Flips the first digit of the year in event `seq` (1-based) so its hash no longer matches; returns the new bytes. */
export function tamperLedger(world, seq = 3) {
  const file = world.ledgerPath();
  const lines = readFileSync(file, "utf8").split("\n");
  const line = lines[seq - 1];
  if (line === undefined || !line.includes('"ts":"20')) throw new Error(`cannot tamper with event ${seq}`);
  lines[seq - 1] = line.replace('"ts":"20', '"ts":"21');
  writeFileSync(file, lines.join("\n"));
  return readFileSync(file);
}

/** Initializes OMF state and creates a goal with locked metrics, one ready work item and one open decision. */
export function prepareItem(world, { resolve: resolveDecision }) {
  const fixture = join(OUTER, "fixtures", "goal");
  for (const name of ["goal.md", "app", "bench", "bands", "reconciler.mjs"]) {
    cpSync(join(fixture, name), join(world.repo, name), { recursive: true });
  }
  world.git("add", "-A");
  world.git("commit", "-q", "-m", "fixture goal");

  must("init", world.omf(["init"]));
  const created = must("goal new", world.omf(["goal", "new", GOAL]));
  const goalFile = /^created (.+)$/m.exec(created.stdout)?.[1];
  if (goalFile === undefined) throw new Error(`goal new printed no path: ${created.stdout}`);
  cpSync(join(fixture, "goal.md"), goalFile);
  mkdirSync(join(dirname(goalFile), "bands"), { recursive: true });
  cpSync(join(fixture, "bands", "m-bad-results.yaml"), join(dirname(goalFile), "bands", "m-bad-results.yaml"));
  must(
    "propose m-search-cost",
    world.omf([
      "metric",
      "propose",
      "m-search-cost",
      "--unit",
      "compares",
      "--watch",
      "bench/**",
      "--",
      "node",
      "bench/steps.mjs",
    ]),
  );
  must(
    "propose m-bad-results",
    world.omf([
      "metric",
      "propose",
      "m-bad-results",
      "--unit",
      "results",
      "--watch",
      "bench/**",
      "--",
      "node",
      "bench/check.mjs",
    ]),
  );
  appendFileSync(
    join(world.projectDir(), "config.toml"),
    `\n[reconciler]\nkind = "command"\ncommand = ["node", ${JSON.stringify(join(world.repo, "reconciler.mjs"))}]\n`,
  );
  must("goal approve", world.tty(GOAL, ["goal", "approve", GOAL]));
  must("goal tick", world.omf(["goal", "tick", GOAL, "--runner", "host"]));
  const listed = must("work list", world.omf(["work", "list", GOAL]));
  const workId = /^(w-[0-9a-f]{12})\b/m.exec(listed.stdout)?.[1];
  if (workId === undefined) throw new Error(`the tick made no work item: ${listed.stdout}`);

  const answers = join(OUTER, "fixtures", "answers");
  must("decide add", world.omf(["decide", "add", workId, "--file", join(answers, "add.json")]));
  if (resolveDecision) {
    must(
      "decide resolve",
      world.tty(`${workId}/d-interface`, [
        "decide",
        "resolve",
        workId,
        "d-interface",
        "--file",
        join(answers, "resolve.json"),
      ]),
    );
  }
  return workId;
}

/** The path of an answer file under outer/fixtures/answers. */
export function answerFile(name) {
  return join(OUTER, "fixtures", "answers", name);
}
