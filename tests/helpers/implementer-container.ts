import { execFileSync, type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { containerSpecFor } from "../../src/container/golden.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerHandle, ContainerRuntime } from "../../src/container/runtime.js";
import { type ContainerSpec, IMPLEMENTER_FIXED_ENV } from "../../src/container/spec.js";
import { type TarEntry, tarOfEntries } from "../../src/container/tar-dir.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { FIXTURE_RUN_ID, FIXTURE_WORK_ID, SUT_BASE } from "./container-fixture.js";
import { FakeDocker } from "./fake-docker.js";
import type { FakeExecCall, FakeResult } from "./fake-docker-core.mjs";
import { fakeRuntime } from "./fake-runtime.js";
import { makeTempDir } from "./tmp.js";

/** The directories of the tools the scripts use. The double's PATH holds these and nothing else (no shim, no developer tool). */
const TOOL_PATH = [
  ...new Set(
    ["git", "tar", "base64", "tr", "sleep"].map((tool) =>
      dirname(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim()),
    ),
  ),
].join(":");

export interface LocalExec {
  argv: readonly string[];
  workdir: string | null;
  /** False for the kill-all exec: it is recorded and simulated, never run. */
  ran: boolean;
}

/** The kill-all exec as the double recognises it, by whole-argv equality (workspace.ts `KILL_ALL_ARGV` is pinned to the same value). */
const KILL_ALL: readonly string[] = ["sh", "-c", "kill -9 -1"];
/** Commands the double will run on the host. */
const ALLOWED_COMMANDS: readonly string[] = ["sh", "tar", "git", "base64"];

/** True when at least one process is left in the process group. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The container as three directories. `work`, `tmp` and `agent` stand for `/work`, `/tmp` and `/agent`, and a root of their own
 * stands for `/`, so the shipped scripts run unmodified: they name only `.`, `$OMF_TMP` and (for the capture) three relative
 * directory names. The double is a `FakeDocker` exec hook. It runs the real `sh`, `tar`, `git` and `base64` with an environment
 * built from scratch: its own HOME, no system or global git config, a PATH of the tool directories only. Nothing is read from
 * or written to the developer's home, and the process environment is never copied. The kill-all exec is never run, because
 * `kill -9 -1` on a host would be catastrophic; the double signals only the process groups it started itself.
 */
export class LocalTreeContainer {
  readonly root: string = realpathSync(makeTempDir("omf-local-tree-"));
  readonly work: string = join(this.root, "work");
  readonly tmp: string = join(this.root, "tmp");
  readonly agent: string = join(this.root, "agent");
  readonly execs: LocalExec[] = [];
  /** The process group of every command the double ran, and the groups its simulated kill-all signalled. */
  readonly spawnedGroups: number[] = [];
  readonly killedGroups: number[] = [];
  private path: string = TOOL_PATH;

  constructor() {
    for (const dir of [this.work, this.tmp, this.agent]) mkdirSync(dir);
  }

  /** Replaces the PATH of later commands; an empty directory models an image without the tools. */
  setPath(path: string): void {
    this.path = path;
  }

  /** Hook for `new FakeDocker({ exec })`. */
  readonly exec = (call: FakeExecCall): FakeResult => {
    if (call.argv.length === KILL_ALL.length && call.argv.every((part, i) => part === KILL_ALL[i])) {
      return this.simulateKillAll(call);
    }
    const [command = "", ...args] = call.argv;
    // Only the tools the shipped scripts and the stub behaviours use run on the host. `claude`, `docker` and anything else is
    // refused, so a test that routes a real session adapter through the double can never start a bypass-flag agent on the host.
    if (!ALLOWED_COMMANDS.includes(command)) {
      this.execs.push({ argv: call.argv, workdir: call.workdir, ran: false });
      return { status: 127, stdout: "", stderr: `command not allowed in the local double: ${command}` };
    }
    // `detached` makes the child lead its own process group, which is what the simulated kill-all signals. The typings of
    // `spawnSync` omit the option although Node honours it, so the options are built apart from the call.
    const options: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
      cwd: this.dirOf(call.workdir),
      env: this.envFor(call.env),
      input: call.stdin ?? undefined,
      encoding: "utf8",
      detached: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
      killSignal: "SIGKILL",
    };
    const done = spawnSync(command === "sh" ? "/bin/sh" : command, args, options);
    // `spawnSync` has reaped the leader. Keep the group only if something is still alive in it (a background job); a group that
    // is already empty is dropped, so a later kill can never hit a process group that reuses the number.
    if (done.pid !== undefined && groupAlive(done.pid)) this.spawnedGroups.push(done.pid);
    this.execs.push({ argv: call.argv, workdir: call.workdir, ran: true });
    return {
      status: done.error === undefined ? (done.status ?? 137) : 127,
      stdout: done.stdout ?? "",
      stderr: done.stderr ?? "",
    };
  };

  /** Runs `git` in `/work` with the double's environment (for reading what the scripts and a stub committed). */
  git(args: readonly string[], input?: Buffer | string): string {
    return execFileSync("git", args, {
      cwd: this.work,
      env: this.envFor({}),
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** Signals every process group the double started that is still alive, then removes the directories. */
  dispose(): void {
    this.signalGroups(false);
    rmSync(this.root, { recursive: true, force: true });
  }

  private simulateKillAll(call: FakeExecCall): FakeResult {
    this.execs.push({ argv: call.argv, workdir: call.workdir, ran: false });
    this.signalGroups(true);
    return { status: 0, stdout: "", stderr: "" };
  }

  private signalGroups(record: boolean): void {
    for (const group of this.spawnedGroups) {
      if (!groupAlive(group)) continue;
      try {
        process.kill(-group, "SIGKILL");
        if (record) this.killedGroups.push(group);
      } catch {
        // the group has already ended
      }
    }
  }

  private dirOf(workdir: string | null): string {
    switch (workdir) {
      case "/work":
        return this.work;
      case "/tmp":
        return this.tmp;
      case "/agent":
        return this.agent;
      default:
        return this.root;
    }
  }

  private envFor(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return {
      ...Object.fromEntries(IMPLEMENTER_FIXED_ENV),
      HOME: this.agent,
      CLAUDE_CONFIG_DIR: join(this.agent, "claude"),
      OMF_TMP: this.tmp,
      PATH: this.path,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extra,
    };
  }
}

/** What an implementer might do, as shell run in `/work`. The double runs them for real; they are test data, not product code. */
export const STUB_BEHAVIOURS = {
  /** A plan commit alone first, then a code commit, both with a plain `git commit` (no flag, no identity set up). */
  good: [
    "set -eu",
    `mkdir -p .omf/${FIXTURE_WORK_ID}`,
    `echo plan > .omf/${FIXTURE_WORK_ID}/plan.md`,
    "git add .omf",
    "git commit -q -m plan",
    "echo code > feature.txt",
    "git add feature.txt",
    "git commit -q -m feature",
  ].join("\n"),
  /** Leaves work behind: an edit to a tracked file, a new ignore rule, an ignored file and a note in /tmp, all uncommitted. */
  messy: [
    "set -eu",
    "echo '*.log' > .gitignore",
    "echo noisy > build.log",
    "echo changed >> README.md",
    'echo needle-in-tmp > "$OMF_TMP/note.txt"',
  ].join("\n"),
  /** Turns the repository's hooks back on and plants hooks that record that they ran. */
  hostileHook: [
    "set -eu",
    "mkdir -p .git/hooks",
    `printf '%s\\n' '#!/bin/sh' 'touch "$OMF_TMP/hook-ran"' > .git/hooks/post-commit`,
    "cp .git/hooks/post-commit .git/hooks/pre-commit",
    "chmod +x .git/hooks/post-commit .git/hooks/pre-commit",
    "git config core.hooksPath .git/hooks",
    "echo dirty > dirty.txt",
  ].join("\n"),
  /** A job that outlives its exec, with its pid in /tmp. */
  background: ["sleep 300 >/dev/null 2>&1 </dev/null &", 'echo $! > "$OMF_TMP/bg.pid"'].join("\n"),
} as const;

const file = (path: string, text: string, executable = false): TarEntry => ({
  path,
  kind: "file",
  data: Buffer.from(text),
  linkTarget: "",
  executable,
});

/**
 * A base tree built to break a naive `git add`: CRLF bytes under `text=auto`, a contracted-looking `$Id: ...$` under `ident`,
 * `export-subst` text, a filter attribute, an executable, a symlink, and names a shell would misread.
 */
export const BASE_ENTRIES: readonly TarEntry[] = [
  file(".gitattributes", "* text=auto\n*.dat filter=custom\nsub.txt export-subst\nid.txt ident\n"),
  file("README.md", "# fixture\n"),
  file("crlf.txt", "one\r\ntwo\r\n"),
  file("id.txt", "$Id: deadbeef $\n"),
  file("sub.txt", "$Format:%H$\n"),
  file("run.sh", "#!/bin/sh\necho hi\n", true),
  { path: "link", kind: "symlink", data: Buffer.alloc(0), linkTarget: "README.md", executable: false },
  file("$(touch pwned)", "x\n"),
  file(" a b ", "x\n"),
  file("-n", "x\n"),
  file("semi;colon `tick`.txt", "x\n"),
];

export const baseTar = (entries: readonly TarEntry[] = BASE_ENTRIES): Buffer => tarOfEntries(entries);

/**
 * The tree sha of `entries` computed without a work tree: raw blobs and an index built by hand, so no attribute, filter or
 * line-ending rule can touch a byte. This is what the host computes for the base commit, and what the container's root commit
 * must equal.
 */
export function treeOfEntries(entries: readonly TarEntry[]): string {
  const dir = makeTempDir("omf-expected-tree-");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
  const git = (args: string[], input?: Buffer | string): string =>
    execFileSync("git", args, { cwd: dir, env, input, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  const lines = entries.map((entry) => {
    const bytes = entry.kind === "symlink" ? Buffer.from(entry.linkTarget) : entry.data;
    const mode = entry.kind === "symlink" ? "120000" : entry.executable ? "100755" : "100644";
    const blob = git(["hash-object", "-w", "-t", "blob", "--no-filters", "--stdin"], bytes);
    return `${mode} ${blob}\t${entry.path}\n`;
  });
  git(["update-index", "--add", "--index-info"], lines.join(""));
  return git(["write-tree"]);
}

export function implementerSpec(serial = 1): ContainerSpec {
  return containerSpecFor({
    role: "implementer",
    image: pinnedImage(SUT_BASE),
    labels: { work_id: FIXTURE_WORK_ID, run_id: FIXTURE_RUN_ID, round: 1 },
    serial,
    limits: { kind: "implementer", implementer: CONFIG_DEFAULTS.implementer },
  });
}

export interface LocalTree {
  local: LocalTreeContainer;
  fake: FakeDocker;
  runtime: ContainerRuntime;
  handle: ContainerHandle;
}

/** A started implementer container on the fake daemon whose `docker exec` runs in a `LocalTreeContainer`. */
export async function openLocalTree(): Promise<LocalTree> {
  const local = new LocalTreeContainer();
  const fake = new FakeDocker({ exec: local.exec });
  const runtime = fakeRuntime(fake);
  const handle = await runtime.create(implementerSpec());
  await runtime.start(handle);
  return { local, fake, runtime, handle };
}

/** Runs `script` as the implementer would, through the runtime like any other exec. */
export function runStub(tree: LocalTree, script: string): Promise<ProcessResult> {
  return tree.runtime.exec(tree.handle, {
    argv: ["sh", "-c", script],
    workdir: "/work",
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
}
