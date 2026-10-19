#!/usr/bin/env node
// Synthetic, offline baseline only: no production state, model, Docker, or metric execution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { goals: [1, 5, 20], samples: 7 };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  const value = process.argv[++index];
  if (flag === "--goals") options.goals = value?.split(",").map(Number) ?? [];
  else if (flag === "--samples") options.samples = Number(value);
  else throw new Error(`Unknown option: ${flag}. Use --goals 1,5,20 --samples 7`);
}
assert(options.goals.length > 0 && options.goals.length <= 50);
assert(new Set(options.goals).size === options.goals.length, "goal counts must be distinct");
assert(options.goals.every((n) => Number.isInteger(n) && n >= 1 && n <= 50));
assert(Number.isInteger(options.samples) && options.samples >= 1 && options.samples <= 100);

// Discover the executable before replacing PATH; subprocess arguments never pass through a shell.
const gitPath = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((entry) => entry !== "")
  .map((entry) => resolve(entry, "git"))
  .find((entry) => {
    try {
      const target = realpathSync(entry);
      accessSync(target, constants.X_OK);
      return lstatSync(target).isFile();
    } catch {
      return false;
    }
  });
assert(gitPath, "git must be an ordinary executable file on PATH");
const realGit = realpathSync(gitPath);
const originalEnv = { ...process.env };
const root = mkdtempSync(join(tmpdir(), "omf-ui-baseline-"));
const home = join(root, "home");
const shim = join(root, "bin");
const calls = join(root, "git-calls.log");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function inventory(dir) {
  const result = [];
  function visit(path, relative) {
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), `unexpected fixture symlink: ${relative}`);
    result.push({
      path: relative,
      mode: stat.mode,
      mtime_ms: stat.mtimeMs,
      bytes: stat.isFile() ? stat.size : 0,
      sha256: stat.isFile() ? hash(readFileSync(path)) : null,
    });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
  }
  visit(dir, ".");
  return result;
}

function contentHash(dir) {
  return hash(JSON.stringify(inventory(dir).map(({ path, sha256 }) => ({ path, sha256 }))));
}

function git(repo, args) {
  return execFileSync(realGit, args, {
    cwd: repo,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  for (const dir of [home, shim, join(root, "tmp"), join(home, "config"), join(home, "cache"), join(home, "data")])
    mkdirSync(dir, { recursive: true });
  // A literal, quoted executable path and "$@" preserve each argument without evaluation.
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shellQuote(calls)}\nGIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 exec ${shellQuote(realGit)} "$@"\n`,
    { mode: 0o700 },
  );
  for (const name of ["claude", "codex", "docker"])
    writeFileSync(join(shim, name), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    OMF_HOME: join(home, "omf"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    TMPDIR: join(root, "tmp"),
    PATH: [shim, dirname(realGit), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });

  const [{ initProject }, { resolveProject }, { Ledger }, goals, metrics, { lockGoal }, { readUiSnapshot }] =
    await Promise.all([
      import("../dist/core/project.js"),
      import("../dist/core/paths.js"),
      import("../dist/core/ledger.js"),
      import("../dist/goal/goal-file.js"),
      import("../dist/goal/metrics.js"),
      import("../dist/goal/goal-lock.js"),
      import("../dist/ui/read-model.js"),
    ]);

  const report = {
    schema_version: 1,
    purpose: "OMF #59 baseline only; no optimization acceptance claim",
    started_at: new Date().toISOString(),
    source: {
      revision: git(sourceRoot, ["rev-parse", "HEAD"]),
      changed_tracked_files: git(sourceRoot, ["diff", "--name-only", "HEAD", "--"]),
      src_sha256: contentHash(join(sourceRoot, "src")),
      schemas_sha256: contentHash(join(sourceRoot, "schemas")),
      dist_sha256: contentHash(join(sourceRoot, "dist")),
      benchmark_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    },
    toolchain: { node: process.version, git: git(sourceRoot, ["--version"]), real_git: realGit },
    machine: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logical_cpus: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes: freemem(),
      load_average: loadavg(),
    },
    method: {
      warmups_per_fixture: 1,
      samples_per_fixture: options.samples,
      p95: "nearest rank: sorted[ceil(0.95 * n) - 1]",
      timing: "readUiSnapshot only, including Git counting shim overhead; excludes setup/build/invariant checks",
      cache: "warm repeated reads; no OS cache flush; distinct synthetic temporary fixture per case",
      fixture: "one shared metric proposal, one metric lock per distinct goal, no work/ticks/measurements/bands",
      invariants:
        "repo and isolated home file names/content/modes/mtimes unchanged by every snapshot, including warmup",
    },
    cases: [],
    invalidation: [],
  };

  function fixture(count, watched) {
    const repo = join(root, `repo-${watched ? "watched" : "empty"}-${count}`);
    mkdirSync(join(repo, "bench"), { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "Synthetic UI baseline"]);
    git(repo, ["config", "user.email", "ui-baseline@example.invalid"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    git(repo, ["config", "core.hooksPath", "/dev/null"]);
    writeFileSync(join(repo, "bench", "value.sh"), "echo 1\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Synthetic snapshot fixture"]);
    initProject(repo, process.env);
    const location = resolveProject(repo, process.env);
    const ledger = new Ledger(location.dir);
    metrics.proposeMetric(
      ledger,
      location.dir,
      {
        metric_id: "m-baseline",
        command: ["sh", "bench/value.sh"],
        unit: "ms",
        watched_paths: watched ? ["bench/value.sh"] : [],
        image: null,
      },
      "human:synthetic",
    );
    const ids = Array.from({ length: count }, (_, i) => `g-baseline-${String(i + 1).padStart(3, "0")}`);
    for (const id of ids) {
      const file = goals.createGoal(location.dir, id);
      writeFileSync(file, goals.goalTemplate(id).replaceAll("m-replace-me", "m-baseline"));
      lockGoal(location, id, "human:synthetic");
    }
    return { repo, location, ledger, ids };
  }

  function measure(fx, states = fx.ids.map(() => "approved")) {
    const beforeRepo = inventory(fx.repo);
    const beforeHome = inventory(home);
    writeFileSync(calls, "");
    const started = performance.now();
    const snapshot = readUiSnapshot(fx.repo, process.env);
    const elapsed = performance.now() - started;
    const commands = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
    assert.deepEqual(inventory(fx.repo), beforeRepo, "snapshot changed repository (including .git/index)");
    assert.deepEqual(inventory(home), beforeHome, "snapshot changed isolated home/state/ledger");
    assert.equal(snapshot.status, "ok", JSON.stringify(snapshot));
    assert.deepEqual(
      snapshot.goals.map((goal) => goal.goal_id),
      fx.ids,
    );
    assert.deepEqual(
      snapshot.goals.map((goal) => goal.audit_state),
      states,
    );
    return {
      elapsed_ms: elapsed,
      git_calls: commands.length,
      git_commands: Object.fromEntries(
        [...new Set(commands)].sort().map((name) => [name, commands.filter((cmd) => cmd === name).length]),
      ),
      returned_goals: snapshot.goals.length,
      audit_states: snapshot.goals.map((goal) => goal.audit_state),
      ledger_head: snapshot.ledger_head,
      read_only_verified: true,
    };
  }

  function observeInvalidation(fx) {
    const id = fx.ids[0];
    const mutations = [
      [
        "dirty watched tracked file, same size, without commit",
        join(fx.repo, "bench", "value.sh"),
        () => "echo 2\n",
        "needs_reapproval",
      ],
      [
        "goal semantic target",
        goals.goalFile(fx.location.dir, id),
        (text) => text.replace("value: 0", "value: 1"),
        "needs_reapproval",
      ],
      [
        "metric lock integrity",
        metrics.lockFile(fx.location.dir, id, "m-baseline"),
        (text) => JSON.stringify({ ...JSON.parse(text), unit: "s" }),
        "tampered",
      ],
      [
        "proposal definition",
        metrics.proposalFile(fx.location.dir, "m-baseline"),
        (text) => JSON.stringify({ ...JSON.parse(text), unit: "s" }),
        "needs_reapproval",
      ],
    ];
    for (const [name, file, change, state] of mutations) {
      const original = readFileSync(file, "utf8");
      writeFileSync(file, change(original));
      const changed = measure(fx, [state]);
      writeFileSync(file, original);
      const restored = measure(fx);
      report.invalidation.push({ mutation: name, changed, restored });
    }
  }

  for (const watched of [true, false]) {
    for (const count of options.goals) {
      const fx = fixture(count, watched);
      const warmup = measure(fx);
      const samples = Array.from({ length: options.samples }, () => measure(fx));
      const times = samples.map((sample) => sample.elapsed_ms).sort((a, b) => a - b);
      const bytes = inventory(fx.location.dir).reduce((sum, file) => sum + file.bytes, 0);
      const ledgerBytes = lstatSync(fx.ledger.file).size;
      const middle = Math.floor(times.length / 2);
      report.cases.push({
        goals: count,
        watched_paths: watched ? ["bench/value.sh"] : [],
        ledger_events: fx.ledger.readVerified().length,
        ledger_bytes: ledgerBytes,
        state_bytes_including_ledger: bytes,
        state_bytes_excluding_ledger: bytes - ledgerBytes,
        median_ms: times.length % 2 === 0 ? (times[middle - 1] + times[middle]) / 2 : times[middle],
        p95_ms: times[Math.ceil(0.95 * times.length) - 1],
        warmup,
        samples,
      });
      if (watched && count === 1) observeInvalidation(fx);
      process.stderr.write(
        `Verified ${watched ? "watched" : "empty-watch"} / ${count} goals / ${options.samples} samples\n`,
      );
    }
  }
  report.finished_at = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
}
