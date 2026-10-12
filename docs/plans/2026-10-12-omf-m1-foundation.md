# OMF M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the host-side foundation of oh-my-factory: a hash-chained ledger in host state,
schema validation, budgets that never reset, a claim lock, and the `omf init`, `omf doctor` and
`omf ledger verify` commands.

**Architecture:** One npm package (`oh-my-factory`, bin `omf`) written in TypeScript and compiled
with `tsc` to `dist/`. Domain code lives in `src/core/`, and the CLI is a thin commander layer in
`src/cli/`. All OMF state lives under `~/.omf/projects/<repo-hash>/` (or under `$OMF_HOME`). Nothing
is written to the user's repository. Every state change is an append to `ledger.jsonl`. Each
ledger event carries the SHA-256 of its canonical JSON and the hash of the previous event, and
every command verifies the chain before it acts.

**Tech Stack:**
- Node.js 22.12 or later (developed on Node 24)
- TypeScript 7.0.2
- vitest 5.0.2
- commander 15.0.0
- ajv 8.20.0 (JSON Schema draft 2020-12)

**Spec:** `docs/design/2026-10-12-omf-v0-design.md`. This milestone covers:
- §8 shared state (layout, ledger envelope, hash chain)
- §4.4 budgets that never reset and the claim lock
- §7 the measured isolation report: `omf doctor` writes `preflight.json`. In M1 the level is
  `unmeasured`, because containers arrive in M3.
- §11 rule 1 (no writes to the repo, `~/.claude` or `~/.codex`)
- Enforcement tests E3 and E5 and the ledger-tamper test

**Out of scope for M1:**
- Goals, metrics and work items (M2).
- Containers, sealing and judging (M3).
- Human requests (M4).
- Parsing `config.toml`. M1 only writes the default file.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `README.md` | Package, compiler, test runner, license |
| `src/core/canonical-json.ts` | Deterministic JSON serialization and SHA-256 |
| `src/core/paths.ts` | `OMF_HOME`, repository toplevel, project id and project directory |
| `src/core/lock.ts` | Exclusive file lock with PID and process start time, stale detection |
| `src/core/schema.ts` | Loads and caches JSON Schemas from `schemas/`, validates data |
| `schemas/ledger-event.schema.json` | Ledger event envelope schema |
| `src/core/ledger.ts` | Append-only hash-chained ledger with verification |
| `src/core/budget.ts` | Budgets derived from ledger events; only people declare or raise them |
| `src/core/project.ts` | `initProject`: creates host state and the first ledger event |
| `src/core/doctor.ts` | `runDoctor`: probes tools, repo, ledger and isolation, writes `preflight.json` |
| `src/cli/main.ts` | `omf` command line: `init`, `doctor`, `ledger verify` |
| `tests/helpers/tmp.ts` | Temp directories and fixture git repositories |
| `tests/global-setup.ts` | Builds `dist/` once before CLI tests |
| `tests/core/*.test.ts` | Unit tests per core module |
| `tests/helpers/cli.ts` | Runs the built `omf` binary with an isolated HOME |
| `tests/cli/cli.test.ts` | CLI behaviour through the built binary |
| `tests/enforcement/*.test.ts` | One test per control claim in the spec |
| `tests/enforcement/README.md` | Maps each enforcement test to the spec claim it backs |

---

### Task 1: Scaffold the package

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `README.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "oh-my-factory",
  "version": "0.0.1",
  "description": "A goal-driven software factory for Claude Code and Codex CLI",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "bin": {
    "omf": "dist/cli/main.js"
  },
  "files": [
    "dist",
    "schemas",
    "LICENSE",
    "README.md"
  ],
  "engines": {
    "node": ">=22.12"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

`"private": true` prevents an accidental `npm publish` before the first release.

- [ ] **Step 2: Install pinned dependencies**

Run:
```bash
npm install --save-exact --no-audit --no-fund -D typescript@7.0.2 vitest@5.0.2 @types/node@24.19.2
npm install --save-exact --no-audit --no-fund commander@15.0.0 ajv@8.20.0
```
Expected: `package.json` gains `devDependencies` and `dependencies` with exact versions, and
`node_modules/.bin/tsc` and `node_modules/.bin/vitest` exist.

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"],
    "sourceMap": false
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30000,
  },
});
```

- [ ] **Step 5: Write `tests/global-setup.ts`**

It builds `dist/` once so that CLI tests run the real binary.

```ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function setup(): void {
  execFileSync(join("node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { stdio: "inherit" });
}
```

- [ ] **Step 6: Write `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
*.log
```

- [ ] **Step 7: Add the Apache-2.0 license text**

Run:
```bash
curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
head -3 LICENSE
```
Expected output contains `Apache License` and `Version 2.0, January 2004`.

- [ ] **Step 8: Write `README.md`**

```markdown
# oh-my-factory

A goal-driven software factory for Claude Code and Codex CLI. People approve goals, decisions and
evidence. Agents do the work inside an isolated, sealed verification loop.

Status: pre-alpha. The design is in `docs/design/2026-10-12-omf-v0-design.md`
(Korean: `docs/ko/design/`). Implementation plans are in `docs/plans/`.

License: Apache-2.0.
```

- [ ] **Step 9: Add a placeholder source file so `tsc` has an input**

Create `src/core/canonical-json.ts` with a single line. Task 2 replaces it.

```ts
export {};
```

- [ ] **Step 10: Verify the toolchain**

Run: `npm run typecheck && npx vitest run --passWithNoTests`
Expected: typecheck prints nothing and exits 0. vitest reports `No test files found` and exits 0.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore LICENSE README.md src tests/global-setup.ts
git commit -m "build: scaffold oh-my-factory package (TypeScript 7, vitest 5)"
```

---

### Task 2: Canonical JSON and SHA-256

**Files:**
- Modify: `src/core/canonical-json.ts`
- Test: `tests/core/canonical-json.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../src/core/canonical-json.js";

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });

  it("omits object fields whose value is undefined", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
  });

  it("rejects undefined at the top level and inside arrays", () => {
    expect(() => canonicalize(undefined)).toThrow(TypeError);
    expect(() => canonicalize([1, undefined])).toThrow(TypeError);
  });
});

describe("sha256Hex", () => {
  it("returns the lowercase hex digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/canonical-json.test.ts`
Expected: FAIL, because `canonicalize` is not exported.

- [ ] **Step 3: Implement**

Replace `src/core/canonical-json.ts` with:

```ts
import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, undefined fields dropped.
 * The ledger hashes this form, so the same event always has the same hash.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("undefined is not representable in canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number in canonical JSON: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/canonical-json.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/canonical-json.ts tests/core/canonical-json.test.ts
git commit -m "feat(core): add canonical JSON and SHA-256 helpers"
```

---

### Task 3: Paths and test helpers

**Files:**
- Create: `src/core/paths.ts`, `tests/helpers/tmp.ts`
- Test: `tests/core/paths.test.ts`

- [ ] **Step 1: Write the test helpers**

`tests/helpers/tmp.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "omf-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fresh git repository with one commit and no remote. */
export function makeGitRepo(): string {
  const dir = makeTempDir("omf-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git(
    "-c", "user.name=omf-test",
    "-c", "user.email=omf-test@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init",
  );
  return dir;
}
```

- [ ] **Step 2: Write the failing test**

`tests/core/paths.test.ts`:

```ts
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotAGitRepoError, omfHome, projectDir, projectId, repoToplevel } from "../../src/core/paths.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("omfHome", () => {
  it("uses OMF_HOME when it is set", () => {
    expect(omfHome({ OMF_HOME: "/x/omf", HOME: "/h" })).toBe("/x/omf");
  });

  it("falls back to $HOME/.omf", () => {
    expect(omfHome({ HOME: "/h" })).toBe("/h/.omf");
  });
});

describe("repoToplevel", () => {
  it("returns the real path of the repository root from a subdirectory", () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, "sub"));
    expect(repoToplevel(join(repo, "sub"))).toBe(realpathSync(repo));
  });

  it("throws NotAGitRepoError outside a repository", () => {
    expect(() => repoToplevel(makeTempDir())).toThrow(NotAGitRepoError);
  });
});

describe("projectId and projectDir", () => {
  it("is 16 lowercase hex characters and stable", () => {
    const repo = makeGitRepo();
    const top = repoToplevel(repo);
    expect(projectId(top)).toMatch(/^[0-9a-f]{16}$/);
    expect(projectId(top)).toBe(projectId(top));
  });

  it("differs between repositories", () => {
    expect(projectId(repoToplevel(makeGitRepo()))).not.toBe(projectId(repoToplevel(makeGitRepo())));
  });

  it("places the project under OMF_HOME/projects/<id>", () => {
    const repo = makeGitRepo();
    const id = projectId(repoToplevel(repo));
    expect(projectDir(repo, { OMF_HOME: "/x/omf" })).toBe(`/x/omf/projects/${id}`);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/core/paths.test.ts`
Expected: FAIL, because `src/core/paths.js` does not exist.

- [ ] **Step 4: Implement `src/core/paths.ts`**

```ts
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./canonical-json.js";

export class NotAGitRepoError extends Error {
  constructor(readonly cwd: string) {
    super(`not a git repository: ${cwd}`);
    this.name = "NotAGitRepoError";
  }
}

/** Root of all OMF host state. Never inside the user's repository. */
export function omfHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMF_HOME ?? join(env.HOME ?? homedir(), ".omf");
}

export function repoToplevel(cwd: string): string {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new NotAGitRepoError(cwd);
  }
  return realpathSync(out.trim());
}

/** First 16 hex characters of the SHA-256 of the repository's real path. */
export function projectId(toplevel: string): string {
  return sha256Hex(realpathSync(toplevel)).slice(0, 16);
}

export function projectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(omfHome(env), "projects", projectId(repoToplevel(cwd)));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/core/paths.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/paths.ts tests/helpers/tmp.ts tests/core/paths.test.ts
git commit -m "feat(core): resolve OMF home, repo toplevel and project directory"
```

---

### Task 4: Claim lock

The lock follows Kilroy's `run_ownership_lock` (MIT): it is created with `O_EXCL` and records the
PID and the process start time, so a reused PID is detected as stale (spec §4.4). It assumes a
single host.

**Files:**
- Create: `src/core/lock.ts`
- Test: `tests/core/lock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { spawnSync } from "node:child_process";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LockHeldError, acquireLock, processStartTime, releaseLock, withLockSync } from "../../src/core/lock.js";
import { makeTempDir } from "../helpers/tmp.js";

const lockPath = (): string => join(makeTempDir(), "work.lock");

describe("acquireLock", () => {
  it("records pid and start time, and refuses a second acquire", () => {
    const path = lockPath();
    const owner = acquireLock(path);
    expect(owner.pid).toBe(process.pid);
    expect(owner.start_time).toBe(processStartTime(process.pid));
    expect(() => acquireLock(path)).toThrow(LockHeldError);
  });

  it("can be acquired again after release", () => {
    const path = lockPath();
    acquireLock(path);
    releaseLock(path);
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("reclaims a lock whose process has exited", () => {
    const path = lockPath();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(path, JSON.stringify({ pid: dead, start_time: "x", acquired_at: "x" }));
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("reclaims a lock whose pid was reused by another process", () => {
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, start_time: "Thu Jan  1 00:00:00 1970", acquired_at: "x" }),
    );
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("treats a fresh unreadable lock as held", () => {
    const path = lockPath();
    writeFileSync(path, "");
    expect(() => acquireLock(path)).toThrow(LockHeldError);
  });

  it("reclaims an unreadable lock older than the grace period", () => {
    const path = lockPath();
    writeFileSync(path, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(acquireLock(path).pid).toBe(process.pid);
  });
});

describe("releaseLock", () => {
  it("refuses to release a lock owned by another live process", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 1, start_time: null, acquired_at: "x" }));
    expect(() => releaseLock(path)).toThrow(/pid 1/);
  });
});

describe("withLockSync", () => {
  it("releases the lock when the callback throws", () => {
    const path = lockPath();
    expect(() =>
      withLockSync(path, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("returns the callback result", () => {
    expect(withLockSync(lockPath(), () => 42)).toBe(42);
  });
});

describe("processStartTime", () => {
  it("returns a C-locale timestamp for a live pid", () => {
    expect(processStartTime(process.pid)).toMatch(/^[A-Z][a-z]{2} /);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/lock.test.ts`
Expected: FAIL, because `src/core/lock.js` does not exist.

- [ ] **Step 3: Implement `src/core/lock.ts`**

```ts
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

export interface LockOwner {
  pid: number;
  start_time: string | null;
  acquired_at: string;
}

/** A lock file with no readable owner is presumed mid-write for this long. */
const UNREADABLE_GRACE_MS = 5000;

export class LockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly owner: LockOwner | null,
  ) {
    super(`lock is held: ${path}${owner ? ` (pid ${owner.pid})` : ""}`);
    this.name = "LockHeldError";
  }
}

/** Process start time from `ps`, forced to the C locale so it compares reliably. */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const value = out.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Stale when the owner is gone, or when its pid now belongs to a different process. */
export function isStale(owner: LockOwner): boolean {
  if (!isAlive(owner.pid)) return true;
  if (owner.start_time === null) return false;
  const current = processStartTime(owner.pid);
  return current !== null && current !== owner.start_time;
}

function readOwner(path: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, start_time: parsed.start_time ?? null, acquired_at: parsed.acquired_at ?? "" };
  } catch {
    return null;
  }
}

function canReclaim(path: string): boolean {
  const owner = readOwner(path);
  if (owner) return isStale(owner);
  try {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
  } catch {
    return true;
  }
}

function tryOpenExclusive(path: string): number | null {
  try {
    return openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

export function acquireLock(path: string): LockOwner {
  const owner: LockOwner = {
    pid: process.pid,
    start_time: processStartTime(process.pid),
    acquired_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = tryOpenExclusive(path);
    if (fd === null) {
      if (!canReclaim(path)) throw new LockHeldError(path, readOwner(path));
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(owner));
    } finally {
      closeSync(fd);
    }
    return owner;
  }
  throw new LockHeldError(path, readOwner(path));
}

export function releaseLock(path: string): void {
  const owner = readOwner(path);
  if (owner && owner.pid !== process.pid) {
    throw new Error(`refusing to release a lock owned by pid ${owner.pid}: ${path}`);
  }
  rmSync(path, { force: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` while holding the lock. Waits up to `timeoutMs` for a held lock. */
export function withLockSync<T>(path: string, fn: () => T, timeoutMs = 2000): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      acquireLock(path);
      break;
    } catch (err) {
      if (!(err instanceof LockHeldError) || Date.now() >= deadline) throw err;
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(path);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/lock.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts tests/core/lock.test.ts
git commit -m "feat(core): add O_EXCL claim lock with pid and start-time staleness"
```

---

### Task 5: Schema validation and the ledger event schema

**Files:**
- Create: `schemas/ledger-event.schema.json`, `src/core/schema.ts`
- Test: `tests/core/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";

const valid = {
  schema_version: 1,
  seq: 1,
  prev_hash: "0".repeat(64),
  ts: "2026-10-12T00:00:00.000Z",
  actor: "omf",
  type: "project.initialized",
  payload: {},
  hash: "a".repeat(64),
};

describe("ledger-event schema", () => {
  it("accepts a well-formed event", () => {
    expect(validate("ledger-event.schema.json", valid)).toEqual({ ok: true });
  });

  it("accepts human and agent actors", () => {
    expect(validate("ledger-event.schema.json", { ...valid, actor: "human:dev@example.com" }).ok).toBe(true);
    expect(validate("ledger-event.schema.json", { ...valid, actor: "agent:codex" }).ok).toBe(true);
  });

  it("rejects a missing field", () => {
    const { hash: _hash, ...missing } = valid;
    const result = validate("ledger-event.schema.json", missing);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors).toMatch(/must have required property 'hash'/);
  });

  it("rejects an unknown actor form", () => {
    expect(validate("ledger-event.schema.json", { ...valid, actor: "robot" }).ok).toBe(false);
  });

  it("rejects an extra property", () => {
    expect(validate("ledger-event.schema.json", { ...valid, extra: 1 }).ok).toBe(false);
  });

  it("rejects a malformed type", () => {
    expect(validate("ledger-event.schema.json", { ...valid, type: "Initialized" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/schema.test.ts`
Expected: FAIL, because `src/core/schema.js` does not exist.

- [ ] **Step 3: Write `schemas/ledger-event.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "OMF ledger event",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "seq", "prev_hash", "ts", "actor", "type", "payload", "hash"],
  "properties": {
    "schema_version": { "const": 1 },
    "seq": { "type": "integer", "minimum": 1 },
    "prev_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "ts": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" },
    "actor": { "type": "string", "pattern": "^(omf|human:\\S+|agent:[a-z0-9-]+)$" },
    "type": { "type": "string", "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" },
    "payload": { "type": "object" },
    "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
  }
}
```

- [ ] **Step 4: Implement `src/core/schema.ts`**

`ajv/dist/2020.js` exposes a named `Ajv2020` export. This named import compiles under
TypeScript 7 with `NodeNext` and works at runtime, as checked before writing this plan.

```ts
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

export type Validation = { ok: true } | { ok: false; errors: string };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const compiled = new Map<string, ValidateFunction>();

/** Schemas live in `<package>/schemas`, two levels above both `src/core` and `dist/core`. */
export function schemaUrl(name: string): URL {
  return new URL(`../../schemas/${name}`, import.meta.url);
}

export function validate(name: string, data: unknown): Validation {
  let fn = compiled.get(name);
  if (!fn) {
    fn = ajv.compile(JSON.parse(readFileSync(schemaUrl(name), "utf8")));
    compiled.set(name, fn);
  }
  return fn(data) ? { ok: true } : { ok: false, errors: ajv.errorsText(fn.errors) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/core/schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/ledger-event.schema.json src/core/schema.ts tests/core/schema.test.ts
git commit -m "feat(core): validate data against JSON Schemas; add ledger event schema"
```

---

### Task 6: Hash-chained ledger

Spec §8: append-only, a hash chain, written only by the omf host process, verified before every
command acts.

**Files:**
- Create: `src/core/ledger.ts`
- Test: `tests/core/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, Ledger, LedgerCorruptError } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-ledger-"));

function rewriteLine(ledger: Ledger, index: number, edit: (event: Record<string, unknown>) => void): void {
  const lines = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
  const event = JSON.parse(lines[index] ?? "") as Record<string, unknown>;
  edit(event);
  lines[index] = JSON.stringify(event);
  writeFileSync(ledger.file, `${lines.join("\n")}\n`);
}

describe("Ledger", () => {
  it("chains events and verifies", () => {
    const ledger = newLedger();
    const first = ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    const second = ledger.append({ actor: "human:dev", type: "budget.declared", payload: { goal_id: "g-x", rounds: 3 } });
    expect(first.seq).toBe(1);
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(first.hash);
    expect(ledger.verify()).toEqual({ ok: true, count: 2, head: second.hash });
  });

  it("verifies an empty or missing ledger as ok with zero events", () => {
    expect(newLedger().verify()).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it("detects a tampered payload", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.payload = { a: 2 };
    });
    expect(ledger.verify()).toEqual({ ok: false, seq: 1, reason: "hash mismatch" });
  });

  it("detects a deleted event", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const lines = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
    writeFileSync(ledger.file, `${lines[1]}\n`);
    expect(ledger.verify()).toEqual({ ok: false, seq: 1, reason: "seq is 2" });
  });

  it("detects an unparseable line", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    writeFileSync(ledger.file, `${readFileSync(ledger.file, "utf8")}{not json\n`);
    expect(ledger.verify()).toEqual({ ok: false, seq: 2, reason: "unparseable line" });
  });

  it("refuses to append to a corrupt ledger", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.payload = { a: 2 };
    });
    expect(() => ledger.append({ actor: "omf", type: "project.touched", payload: {} })).toThrow(LedgerCorruptError);
  });

  it("rejects an invalid event without writing it", () => {
    const ledger = newLedger();
    expect(() => ledger.append({ actor: "robot", type: "project.initialized", payload: {} })).toThrow(/invalid event/);
    expect(ledger.verify()).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it("readVerified throws on a corrupt ledger", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.actor = "human:mallory";
    });
    expect(() => ledger.readVerified()).toThrow(LedgerCorruptError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/ledger.test.ts`
Expected: FAIL, because `src/core/ledger.js` does not exist.

- [ ] **Step 3: Implement `src/core/ledger.ts`**

```ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "./canonical-json.js";
import { withLockSync } from "./lock.js";
import { validate } from "./schema.js";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEvent {
  schema_version: 1;
  seq: number;
  prev_hash: string;
  ts: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  hash: string;
}

export interface NewEvent {
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}

export type VerifyResult = { ok: true; count: number; head: string } | { ok: false; seq: number; reason: string };

export class LedgerCorruptError extends Error {
  constructor(
    readonly seq: number,
    readonly reason: string,
  ) {
    super(`ledger corrupt at seq ${seq}: ${reason}`);
    this.name = "LedgerCorruptError";
  }
}

export function hashEvent(body: Omit<LedgerEvent, "hash">): string {
  return sha256Hex(canonicalize(body));
}

export class Ledger {
  readonly file: string;
  readonly lockFile: string;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(dir, "ledger.jsonl");
    this.lockFile = join(dir, "ledger.lock");
  }

  /** Raw read without verification. Prefer readVerified. */
  readAll(): LedgerEvent[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter((line) => line.length > 0);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch {
        throw new LedgerCorruptError(index + 1, "unparseable line");
      }
    });
  }

  verify(): VerifyResult {
    let events: LedgerEvent[];
    try {
      events = this.readAll();
    } catch (err) {
      if (err instanceof LedgerCorruptError) return { ok: false, seq: err.seq, reason: err.reason };
      throw err;
    }
    let prev = GENESIS_HASH;
    for (const [index, event] of events.entries()) {
      const seq = index + 1;
      if (event.seq !== seq) return { ok: false, seq, reason: `seq is ${event.seq}` };
      if (event.prev_hash !== prev) return { ok: false, seq, reason: "prev_hash mismatch" };
      const { hash, ...body } = event;
      if (hashEvent(body) !== hash) return { ok: false, seq, reason: "hash mismatch" };
      const shape = validate("ledger-event.schema.json", event);
      if (!shape.ok) return { ok: false, seq, reason: `schema: ${shape.errors}` };
      prev = hash;
    }
    return { ok: true, count: events.length, head: prev };
  }

  /** Every command reads through here, so a broken chain stops the command. */
  readVerified(): LedgerEvent[] {
    const result = this.verify();
    if (!result.ok) throw new LedgerCorruptError(result.seq, result.reason);
    return this.readAll();
  }

  append(input: NewEvent): LedgerEvent {
    return withLockSync(this.lockFile, () => {
      const state = this.verify();
      if (!state.ok) throw new LedgerCorruptError(state.seq, state.reason);
      const body: Omit<LedgerEvent, "hash"> = {
        schema_version: 1,
        seq: state.count + 1,
        prev_hash: state.head,
        ts: this.now().toISOString(),
        actor: input.actor,
        type: input.type,
        payload: input.payload,
      };
      const event: LedgerEvent = { ...body, hash: hashEvent(body) };
      const shape = validate("ledger-event.schema.json", event);
      if (!shape.ok) throw new Error(`invalid event: ${shape.errors}`);
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      return event;
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/ledger.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ledger.ts tests/core/ledger.test.ts
git commit -m "feat(core): add append-only hash-chained ledger with verification"
```

---

### Task 7: Budgets that never reset (E3)

Spec §4.4 and J8: budgets accumulate in the host ledger, do not reset on restart, and are never
extended automatically. M1 tracks `rounds`. M2 adds wall time when goals arrive.

**Files:**
- Create: `src/core/budget.ts`
- Test: `tests/core/budget.test.ts`, `tests/enforcement/E3-budget-no-reset.test.ts`

- [ ] **Step 1: Write the failing unit test**

`tests/core/budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BudgetError, budgetState, consumeBudget, declareBudget, raiseBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-budget-"));

describe("budgets", () => {
  it("is null until declared", () => {
    expect(budgetState(newLedger(), "g-a")).toBeNull();
  });

  it("tracks declared, raised and consumed rounds per goal", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", 3, "human:dev");
    declareBudget(ledger, "g-b", 1, "human:dev");
    consumeBudget(ledger, "g-a");
    raiseBudget(ledger, "g-a", 2, "human:dev");
    expect(budgetState(ledger, "g-a")).toEqual({ declared: 3, raised: 2, consumed: 1, remaining: 4 });
    expect(budgetState(ledger, "g-b")).toEqual({ declared: 1, raised: 0, consumed: 0, remaining: 1 });
  });

  it("only people declare budgets", () => {
    expect(() => declareBudget(newLedger(), "g-a", 3, "agent:claude")).toThrow(BudgetError);
  });

  it("rejects non-positive or fractional rounds", () => {
    const ledger = newLedger();
    expect(() => declareBudget(ledger, "g-a", 0, "human:dev")).toThrow(BudgetError);
    expect(() => declareBudget(ledger, "g-a", 1.5, "human:dev")).toThrow(BudgetError);
  });

  it("refuses to consume an undeclared budget", () => {
    expect(() => consumeBudget(newLedger(), "g-a")).toThrow(/no budget declared/);
  });
});
```

- [ ] **Step 2: Write the failing enforcement test**

`tests/enforcement/E3-budget-no-reset.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BudgetError, budgetState, consumeBudget, declareBudget, raiseBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §4.4, J8: budgets accumulate in the host ledger, never reset on restart,
// and are never extended automatically.
describe("E3 budget-no-reset", () => {
  it("survives a restart: a new Ledger instance sees the same consumption", () => {
    const dir = makeTempDir("omf-e3-");
    const before = new Ledger(dir);
    declareBudget(before, "g-a", 3, "human:dev");
    consumeBudget(before, "g-a");
    consumeBudget(before, "g-a");

    const afterRestart = new Ledger(dir);
    expect(budgetState(afterRestart, "g-a")?.remaining).toBe(1);
    consumeBudget(afterRestart, "g-a");
    expect(() => consumeBudget(afterRestart, "g-a")).toThrow(/budget exhausted/);
  });

  it("cannot be re-declared to reset it", () => {
    const ledger = new Ledger(makeTempDir("omf-e3-"));
    declareBudget(ledger, "g-a", 1, "human:dev");
    consumeBudget(ledger, "g-a");
    expect(() => declareBudget(ledger, "g-a", 5, "human:dev")).toThrow(/already declared/);
  });

  it("cannot be raised by omf or an agent", () => {
    const ledger = new Ledger(makeTempDir("omf-e3-"));
    declareBudget(ledger, "g-a", 1, "human:dev");
    expect(() => raiseBudget(ledger, "g-a", 1, "omf")).toThrow(BudgetError);
    expect(() => raiseBudget(ledger, "g-a", 1, "agent:codex")).toThrow(BudgetError);
    expect(budgetState(ledger, "g-a")?.remaining).toBe(1);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run tests/core/budget.test.ts tests/enforcement/E3-budget-no-reset.test.ts`
Expected: FAIL, because `src/core/budget.js` does not exist.

- [ ] **Step 4: Implement `src/core/budget.ts`**

```ts
import type { Ledger } from "./ledger.js";

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

export interface BudgetState {
  declared: number;
  raised: number;
  consumed: number;
  remaining: number;
}

function requireHuman(actor: string, action: string): void {
  if (!actor.startsWith("human:")) {
    throw new BudgetError(`only a person may ${action} a budget (J8); actor was ${actor}`);
  }
}

function requirePositiveInteger(rounds: number): void {
  if (!Number.isInteger(rounds) || rounds <= 0) {
    throw new BudgetError(`rounds must be a positive integer; got ${rounds}`);
  }
}

/** Derived from the verified ledger, so restarting a process cannot change it. */
export function budgetState(ledger: Ledger, goalId: string): BudgetState | null {
  let declared: number | null = null;
  let raised = 0;
  let consumed = 0;
  for (const event of ledger.readVerified()) {
    if (event.payload.goal_id !== goalId) continue;
    const rounds = Number(event.payload.rounds ?? 0);
    if (event.type === "budget.declared") declared = rounds;
    else if (event.type === "budget.raised") raised += rounds;
    else if (event.type === "budget.consumed") consumed += rounds;
  }
  if (declared === null) return null;
  return { declared, raised, consumed, remaining: declared + raised - consumed };
}

export function declareBudget(ledger: Ledger, goalId: string, rounds: number, actor: string): void {
  requireHuman(actor, "declare");
  requirePositiveInteger(rounds);
  if (budgetState(ledger, goalId) !== null) {
    throw new BudgetError(`budget already declared for ${goalId}; raise it instead`);
  }
  ledger.append({ actor, type: "budget.declared", payload: { goal_id: goalId, rounds } });
}

export function raiseBudget(ledger: Ledger, goalId: string, rounds: number, actor: string): void {
  requireHuman(actor, "raise");
  requirePositiveInteger(rounds);
  if (budgetState(ledger, goalId) === null) throw new BudgetError(`no budget declared for ${goalId}`);
  ledger.append({ actor, type: "budget.raised", payload: { goal_id: goalId, rounds } });
}

export function consumeBudget(ledger: Ledger, goalId: string, rounds = 1, actor = "omf"): BudgetState {
  requirePositiveInteger(rounds);
  const state = budgetState(ledger, goalId);
  if (state === null) throw new BudgetError(`no budget declared for ${goalId}`);
  if (state.remaining < rounds) throw new BudgetError(`budget exhausted for ${goalId}`);
  ledger.append({ actor, type: "budget.consumed", payload: { goal_id: goalId, rounds } });
  return { ...state, consumed: state.consumed + rounds, remaining: state.remaining - rounds };
}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `npx vitest run tests/core/budget.test.ts tests/enforcement/E3-budget-no-reset.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/budget.ts tests/core/budget.test.ts tests/enforcement/E3-budget-no-reset.test.ts
git commit -m "feat(core): add ledger-derived budgets that never reset (E3)"
```

---

### Task 8: `initProject` and non-pollution (E5)

Spec §11 rule 1 and §8: `omf init` creates host state only. It writes nothing to the repository,
`~/.claude`, `~/.claude.json` or `~/.codex`.

**Files:**
- Create: `src/core/project.ts`
- Test: `tests/core/project.test.ts`, `tests/enforcement/E5-init-non-pollution.test.ts`

- [ ] **Step 1: Write the failing unit test**

`tests/core/project.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { NotAGitRepoError } from "../../src/core/paths.js";
import { DEFAULT_CONFIG, PROJECT_SUBDIRS, initProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("initProject", () => {
  it("creates the host layout, default config and the first ledger event", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const result = initProject(repo, { OMF_HOME: join(home, ".omf") });
    expect(result.created).toBe(true);
    for (const sub of PROJECT_SUBDIRS) expect(existsSync(join(result.projectDir, sub))).toBe(true);
    expect(readFileSync(join(result.projectDir, "config.toml"), "utf8")).toBe(DEFAULT_CONFIG);
    const events = new Ledger(result.projectDir).readVerified();
    expect(events.map((e) => e.type)).toEqual(["project.initialized"]);
    expect(events[0]?.payload.repo).toBe(result.repo);
  });

  it("is idempotent", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir("omf-home-"), ".omf") };
    initProject(repo, env);
    const second = initProject(repo, env);
    expect(second.created).toBe(false);
    expect(new Ledger(second.projectDir).readVerified()).toHaveLength(1);
  });

  it("refuses to run outside a git repository", () => {
    expect(() => initProject(makeTempDir(), { OMF_HOME: makeTempDir() })).toThrow(NotAGitRepoError);
  });
});
```

- [ ] **Step 2: Write the failing enforcement test**

`tests/enforcement/E5-init-non-pollution.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { initProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

/** Map of relative path -> content hash for every file under root (skipping .git). */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = sha256Hex(readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

function makeUserHome(): string {
  const home = makeTempDir("omf-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}\n');
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
  writeFileSync(join(home, ".claude.json"), '{"projects":{}}\n');
  return home;
}

// Spec §11 rule 1: OMF only reads the user's repo, ~/.claude, ~/.claude.json and ~/.codex.
describe("E5 init-non-pollution", () => {
  it("omf init writes only under $HOME/.omf", () => {
    const repo = makeGitRepo();
    const home = makeUserHome();
    const before = {
      repo: snapshot(repo),
      claude: snapshot(join(home, ".claude")),
      codex: snapshot(join(home, ".codex")),
      claudeJson: readFileSync(join(home, ".claude.json"), "utf8"),
      status: execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" }),
    };

    initProject(repo, { HOME: home });

    expect(snapshot(repo)).toEqual(before.repo);
    expect(snapshot(join(home, ".claude"))).toEqual(before.claude);
    expect(snapshot(join(home, ".codex"))).toEqual(before.codex);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before.claudeJson);
    expect(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" })).toBe(
      before.status,
    );
    expect(existsSync(join(home, ".omf", "projects"))).toBe(true);
    expect(readdirSync(home).sort()).toEqual([".claude", ".claude.json", ".codex", ".omf"]);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run tests/core/project.test.ts tests/enforcement/E5-init-non-pollution.test.ts`
Expected: FAIL, because `src/core/project.js` does not exist.

- [ ] **Step 4: Implement `src/core/project.ts`**

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, LedgerCorruptError, type LedgerEvent } from "./ledger.js";
import { omfHome, projectId, repoToplevel } from "./paths.js";

export const PROJECT_SUBDIRS = ["vault/metrics", "vault/scenarios", "runs", "worktrees"] as const;

export const DEFAULT_CONFIG = `# oh-my-factory project configuration (host state; never inside the repository)

[isolation]
declared = "L2"

[roles]
author = { vendor = "codex" }
implementer = { vendor = "claude" }
judge = { vendor = "codex" }
reconciler = { vendor = "claude" }
`;

export interface InitResult {
  projectDir: string;
  repo: string;
  created: boolean;
  event: LedgerEvent | null;
}

export function initProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitResult {
  const repo = repoToplevel(cwd);
  const id = projectId(repo);
  const dir = join(omfHome(env), "projects", id);
  const ledger = new Ledger(dir);

  if (existsSync(ledger.file)) {
    const state = ledger.verify();
    if (!state.ok) throw new LedgerCorruptError(state.seq, state.reason);
    return { projectDir: dir, repo, created: false, event: null };
  }

  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, { mode: 0o600 });
  const event = ledger.append({ actor: "omf", type: "project.initialized", payload: { repo, project_id: id } });
  return { projectDir: dir, repo, created: true, event };
}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `npx vitest run tests/core/project.test.ts tests/enforcement/E5-init-non-pollution.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/project.ts tests/core/project.test.ts tests/enforcement/E5-init-non-pollution.test.ts
git commit -m "feat(core): initialize host-only project state (E5)"
```

---

### Task 9: `runDoctor` and `preflight.json`

Spec §7 says isolation is measured, not declared. In M1 there are no containers yet, so the
report states `measured: "unmeasured"`. M3 fills in the measurement.

**Files:**
- Create: `src/core/doctor.ts`
- Test: `tests/core/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/core/doctor.js";
import { initProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const SYSTEM_PATH = "/usr/bin:/bin";

/** A directory of fake CLIs so the test does not depend on what is installed. */
function stubBin(opts: { dockerDaemon: boolean }): string {
  const dir = makeTempDir("omf-bin-");
  const write = (name: string, body: string): void => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  write("claude", 'echo "2.1.0 (Claude Code)"');
  write("codex", 'echo "codex-cli 0.160.1"');
  write(
    "docker",
    opts.dockerDaemon
      ? 'if [ "$1" = "info" ]; then echo "29.0.0"; else echo "Docker version 29.0.0"; fi'
      : 'if [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi',
  );
  return dir;
}

function env(home: string, bin: string | null): NodeJS.ProcessEnv {
  return { HOME: home, OMF_HOME: join(home, ".omf"), PATH: bin ? `${bin}:${SYSTEM_PATH}` : SYSTEM_PATH };
}

describe("runDoctor", () => {
  it("is ok with all tools, a running daemon and an initialized project", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tools.claude).toEqual({ found: true, version: "2.1.0 (Claude Code)" });
    expect(report.tools.docker.daemon).toBe(true);
    expect(report.isolation).toMatchObject({ declared: "L2", measured: "unmeasured" });
  });

  it("writes preflight.json into the project's host directory", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(JSON.parse(readFileSync(join(projectDir, "preflight.json"), "utf8"))).toEqual(report);
  });

  it("reports missing vendor CLIs and an unreachable docker daemon", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const bin = makeTempDir("omf-bin-");
    const docker = join(bin, "docker");
    writeFileSync(docker, '#!/bin/sh\nif [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi\n');
    chmodSync(docker, 0o755);
    const e = env(home, bin);
    initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        "claude not found on PATH",
        "codex not found on PATH",
        "docker daemon is not reachable",
      ]),
    );
  });

  it("reports an uninitialized project without writing anything", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const report = runDoctor(repo, env(home, stubBin({ dockerDaemon: true })));
    expect(report.problems).toContain("project not initialized; run omf init");
    expect(report.project.initialized).toBe(false);
  });

  it("reports a corrupt ledger", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    writeFileSync(join(projectDir, "ledger.jsonl"), "{not json\n");
    const report = runDoctor(repo, e);
    expect(report.problems).toContain("ledger corrupt at seq 1: unparseable line");
  });

  it("reports when not inside a git repository", () => {
    const home = makeTempDir("omf-home-");
    const report = runDoctor(makeTempDir(), env(home, stubBin({ dockerDaemon: true })));
    expect(report.problems).toContain("not inside a git repository");
    expect(report.repo.is_git_repo).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/doctor.test.ts`
Expected: FAIL, because `src/core/doctor.js` does not exist.

- [ ] **Step 3: Implement `src/core/doctor.ts`**

```ts
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type VerifyResult } from "./ledger.js";
import { NotAGitRepoError, omfHome, projectId, repoToplevel } from "./paths.js";

export interface ToolProbe {
  found: boolean;
  version: string | null;
}

export interface PreflightReport {
  schema_version: 1;
  generated_at: string;
  tools: {
    git: ToolProbe;
    docker: ToolProbe & { daemon: boolean };
    claude: ToolProbe;
    codex: ToolProbe;
  };
  repo: { is_git_repo: boolean; toplevel: string | null };
  project: { initialized: boolean; dir: string | null; ledger: VerifyResult | null };
  isolation: { declared: "L2"; measured: "unmeasured"; note: string };
  ok: boolean;
  problems: string[];
}

/** Runs `cmd args` with PATH taken from `env`; any failure means "not usable". */
function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv): ToolProbe {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, env });
  if (result.error || result.status !== 0) return { found: false, version: null };
  const first = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  return { found: true, version: first.length > 0 ? first : null };
}

export function runDoctor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreflightReport {
  const problems: string[] = [];

  const git = probe("git", ["--version"], env);
  const docker = probe("docker", ["--version"], env);
  const daemon = docker.found ? probe("docker", ["info", "--format", "{{.ServerVersion}}"], env).found : false;
  const claude = probe("claude", ["--version"], env);
  const codex = probe("codex", ["--version"], env);
  const tools: Array<[string, ToolProbe]> = [
    ["git", git],
    ["docker", docker],
    ["claude", claude],
    ["codex", codex],
  ];
  for (const [name, tool] of tools) if (!tool.found) problems.push(`${name} not found on PATH`);
  if (docker.found && !daemon) problems.push("docker daemon is not reachable");

  let toplevel: string | null = null;
  try {
    toplevel = repoToplevel(cwd);
  } catch (err) {
    if (!(err instanceof NotAGitRepoError)) throw err;
    problems.push("not inside a git repository");
  }

  let dir: string | null = null;
  let initialized = false;
  let ledgerResult: VerifyResult | null = null;
  if (toplevel !== null) {
    dir = join(omfHome(env), "projects", projectId(toplevel));
    const ledger = new Ledger(dir);
    initialized = existsSync(ledger.file);
    if (initialized) {
      ledgerResult = ledger.verify();
      if (!ledgerResult.ok) problems.push(`ledger corrupt at seq ${ledgerResult.seq}: ${ledgerResult.reason}`);
    } else {
      problems.push("project not initialized; run omf init");
    }
  }

  const report: PreflightReport = {
    schema_version: 1,
    generated_at: now().toISOString(),
    tools: { git, docker: { ...docker, daemon }, claude, codex },
    repo: { is_git_repo: toplevel !== null, toplevel },
    project: { initialized, dir, ledger: ledgerResult },
    isolation: {
      declared: "L2",
      measured: "unmeasured",
      note: "isolation is measured from M3 onward; until then no sealing guarantee is claimed",
    },
    ok: problems.length === 0,
    problems,
  };
  if (initialized && dir !== null) {
    writeFileSync(join(dir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/doctor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/doctor.ts tests/core/doctor.test.ts
git commit -m "feat(core): add doctor preflight report (isolation unmeasured until M3)"
```

---

### Task 10: The `omf` command line

**Files:**
- Create: `src/cli/main.ts`, `tests/helpers/cli.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write the CLI test helper**

`tests/helpers/cli.ts` runs the built binary. The global setup from Task 1 builds `dist/` before
any test file runs.

```ts
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("dist/cli/main.js");

/** Runs the built CLI with HOME pointed at `home` and OMF_HOME unset. */
export function omf(args: string[], cwd: string, home: string): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.OMF_HOME;
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
```

- [ ] **Step 2: Write the failing test**

`tests/cli/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("omf CLI", () => {
  it("lists its commands", () => {
    const out = omf(["--help"], makeTempDir(), makeTempDir());
    expect(out.code).toBe(0);
    for (const command of ["init", "doctor", "ledger"]) expect(out.stdout).toContain(command);
  });

  it("init creates host state and ledger verify confirms it", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const init = omf(["init"], repo, home);
    expect(init.code).toBe(0);
    expect(init.stdout).toMatch(/^initialized .*\.omf\/projects\/[0-9a-f]{16}\n$/);
    const again = omf(["init"], repo, home);
    expect(again.stdout).toMatch(/^already initialized /);
    const verify = omf(["ledger", "verify"], repo, home);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toMatch(/^ok: 1 events, head [0-9a-f]{64}\n$/);
  });

  it("ledger verify fails before init", () => {
    const out = omf(["ledger", "verify"], makeGitRepo(), makeTempDir("omf-home-"));
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("project not initialized; run omf init");
  });

  it("init outside a git repository exits 2 with a clear message", () => {
    const out = omf(["init"], makeTempDir(), makeTempDir("omf-home-"));
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("not a git repository");
  });

  it("doctor --json prints the preflight report", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    const out = omf(["doctor", "--json"], repo, home);
    const report = JSON.parse(out.stdout) as { schema_version: number; isolation: { measured: string } };
    expect(report.schema_version).toBe(1);
    expect(report.isolation.measured).toBe("unmeasured");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: FAIL. The global setup's `tsc` build succeeds, but `dist/cli/main.js` does not exist, so
every `spawnSync` exits non-zero.

- [ ] **Step 4: Implement `src/cli/main.ts`**

```ts
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Command } from "commander";
import { runDoctor } from "../core/doctor.js";
import { Ledger } from "../core/ledger.js";
import { projectDir } from "../core/paths.js";
import { initProject } from "../core/project.js";

const program = new Command()
  .name("omf")
  .description("oh-my-factory: a goal-driven software factory for Claude Code and Codex CLI")
  .version("0.0.1");

program
  .command("init")
  .description("create OMF host state for this repository (writes nothing to the repository)")
  .action(() => {
    const result = initProject(process.cwd());
    console.log(`${result.created ? "initialized" : "already initialized"} ${result.projectDir}`);
  });

program
  .command("doctor")
  .description("check tools, repository, ledger and isolation; writes preflight.json")
  .option("--json", "print the full report as JSON")
  .action((options: { json?: boolean }) => {
    const report = runDoctor(process.cwd());
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.ok) {
      console.log("ok");
    } else {
      console.log("problems:");
      for (const problem of report.problems) console.log(`  - ${problem}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  });

const ledgerCommand = program.command("ledger").description("inspect the host ledger");

ledgerCommand
  .command("verify")
  .description("verify the ledger hash chain")
  .action(() => {
    const ledger = new Ledger(projectDir(process.cwd()));
    if (!existsSync(ledger.file)) {
      console.error("project not initialized; run omf init");
      process.exitCode = 1;
      return;
    }
    const result = ledger.verify();
    if (result.ok) {
      console.log(`ok: ${result.count} events, head ${result.head}`);
    } else {
      console.error(`corrupt at seq ${result.seq}: ${result.reason}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Check that the shebang survived the build**

Run: `head -1 dist/cli/main.js`
Expected: `#!/usr/bin/env node`

- [ ] **Step 7: Commit**

```bash
git add src/cli/main.ts tests/helpers/cli.ts tests/cli/cli.test.ts
git commit -m "feat(cli): add omf init, doctor and ledger verify"
```

---

### Task 11: Ledger tamper stops commands

Spec §8: "Every command verifies the chain before acting. If the chain is broken, OMF stops."

**Files:**
- Create: `tests/enforcement/ledger-tamper-stops.test.ts`, `tests/enforcement/README.md`

- [ ] **Step 1: Write the enforcement test**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// Spec §8: every command verifies the hash chain before acting; a broken chain stops OMF.
describe("ledger-tamper-stops", () => {
  it("verify, doctor and init all refuse a tampered ledger", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);

    const file = join(projectDir(repo, { HOME: home }), "ledger.jsonl");
    const event = JSON.parse(readFileSync(file, "utf8")) as { payload: Record<string, unknown> };
    event.payload.repo = "/somewhere/else";
    writeFileSync(file, `${JSON.stringify(event)}\n`);

    const verify = omf(["ledger", "verify"], repo, home);
    expect(verify.code).toBe(1);
    expect(verify.stderr).toContain("corrupt at seq 1: hash mismatch");

    const doctor = omf(["doctor", "--json"], repo, home);
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stdout).problems).toContain("ledger corrupt at seq 1: hash mismatch");

    const init = omf(["init"], repo, home);
    expect(init.code).toBe(2);
    expect(init.stderr).toContain("ledger corrupt at seq 1: hash mismatch");
  });
});
```

- [ ] **Step 2: Write `tests/enforcement/README.md`**

```markdown
# Enforcement tests

Each control claim in `docs/design/2026-10-12-omf-v0-design.md` links to one test here. A claim
without a test is labeled "not enforced" in the spec.

| Test | Claim | Spec |
|---|---|---|
| `E3-budget-no-reset.test.ts` | Budgets accumulate in the host ledger, never reset on restart, and only people declare or raise them | §4.4, §6 J8 |
| `E5-init-non-pollution.test.ts` | `omf init` writes nothing to the repository, `~/.claude`, `~/.claude.json` or `~/.codex` | §11 rule 1 |
| `ledger-tamper-stops.test.ts` | Every command verifies the ledger chain and stops on a broken chain | §8 |

Planned in later milestones: E1 metric-tamper-stops (M2), E2 canary-no-leak (M2/M3), E4
unevaluated-is-undetermined (M3), E6 l2-leak-redteam (M3), E7 empty-means-fail (M3),
E8 no-auto-approve (M4).
```

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS. The counts are 12 test files and 60 tests:

| File | Tests |
|---|---|
| canonical-json | 5 |
| paths | 7 |
| lock | 10 |
| schema | 6 |
| ledger | 8 |
| budget | 5 |
| E3 | 3 |
| project | 3 |
| E5 | 1 |
| doctor | 6 |
| cli | 5 |
| ledger-tamper | 1 |

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/enforcement/ledger-tamper-stops.test.ts tests/enforcement/README.md
git commit -m "test(enforcement): ledger tamper stops verify, doctor and init"
```

---

### Task 12: Close the milestone

**Files:**
- Modify: `README.md`, `docs/plans/README.md`

- [ ] **Step 1: Add usage to `README.md`**

Append:

```markdown
## Usage (M1)

    npm install
    npm run build
    node dist/cli/main.js init          # host state under ~/.omf; nothing written to the repo
    node dist/cli/main.js doctor        # tools, repo, ledger, isolation -> preflight.json
    node dist/cli/main.js ledger verify # hash-chain check
```

- [ ] **Step 2: Mark M1 done in `docs/plans/README.md`**

In the milestone table, change the M1 row's plan cell from
`` `2026-10-12-omf-m1-foundation.md` `` to `` `2026-10-12-omf-m1-foundation.md` (done) ``.

- [ ] **Step 3: Full check**

Run: `npm run typecheck && npm test`
Expected: typecheck prints nothing. All 60 tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/plans/README.md
git commit -m "docs: document M1 usage and mark the milestone done"
```

---

## Deviations during execution

Every task went through a spec review and a code-quality review. The lead approved these changes
beyond the plan text; the code and tests are the source of truth.

- **Task 2.** `canonicalize` rejects values that are not plain JSON (Date, Map, class instances,
  undefined, functions, symbols, bigint, non-finite numbers, sparse arrays), so two values that look
  equal cannot hash differently.
- **Task 3.** The project identity is the main working tree from `git worktree list --porcelain`,
  so linked worktrees share one project; bare repositories are refused. `assertOutsideRepo`
  compares real paths of the nearest existing ancestor (macOS `/var` is `/private/var`) and treats a
  `..foo` directory as inside. `OMF_HOME` must be absolute. Git runs without `GIT_*` variables and
  with `LC_ALL=C`, because localized messages broke error matching.
- **Task 4.** Reclaiming a stale lock is serialized by a `.reclaim` guard file, and a lock file that
  has vanished is never removed by a reclaimer. Staleness thresholds are 1000 ms, inside the 2 s
  wait. The owner's pid and start time are validated, and release checks both. `ps` runs with
  `LC_ALL=C`. The callback's error wins over a release error. The lock is not reentrant. A
  multi-process contention test was added.
- **Task 5.** One cached Ajv 2020 instance; schemas resolve from both `src/` and `dist/`.
- **Task 6.** Torn-tail policy (spec §8): an unterminated final line that parses as an event is kept
  and gets its newline; otherwise the next append truncates it and records `ledger.tail_discarded`.
  Lines that are not JSON objects are corruption. `readVerified` parses once. `appendWith` checks and
  writes under one lock. Limits are documented. A contention test was added.
- **Task 7.** Budget events from the ledger are validated (positive integer rounds, declared before
  use, declared and raised only by `human:` actors, declared once); an invalid event stops the line.
  `consumeBudget` checks and writes inside `appendWith`, and only `omf` or `human:` actors consume.
  The contention test reproduced the race before the fix.
- **Task 8.** Initialization is decided by a `project.initialized` event in the ledger, not by files
  on disk, and the directory layout is repaired on every `init`. Directories are 0700, files 0600.
- **Task 9.** Tool probes time out after 5 s with SIGKILL and take `PATH` from the given
  environment; tests use a stub-only `PATH`. Repository and project-directory errors become
  problems. `preflight.json` is written only for an initialized project.
- **Task 10.** A torn tail is reported on stderr with exit 0. Exit codes are in `--help`. The version
  is read from `package.json`.
- **Task 11.** Reuses `tests/helpers/cli.ts`. The test also checks the ledger bytes are unchanged
  after the refused commands. The README lists the contention tests.
- **Task 12.** The plan expected 60 tests; at Task 12 there were 109. After the final-review fixes
  there are 144 tests in 15 files.
- **After Task 12.** Tests are type-checked (`tsconfig.test.json`), the test setup builds `dist/`
  from scratch, and spec §8 documents the `hash` field, torn writes and the ledger's limits.

### Final-review fixes

A whole-branch review after Task 12 found three important issues and several minor ones. All
were fixed on this branch with tests:

- `omf doctor` ran `codex --version` and `claude --version` with the caller's home, and Codex wrote
  into `~/.codex`. Agent CLIs are now probed with a throwaway home (under `TMPDIR` when set) that is
  removed afterwards; E5 covers `doctor` as well as `init`.
- On case-insensitive APFS, an `OMF_HOME` naming the repository in another letter case passed the
  outside-the-repo check. Paths are now compared with `realpathSync.native`. `OMF_HOME` inside
  `~/.claude`, `~/.codex`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is refused, and the outside-the-repo
  error says to set `OMF_HOME`.
- "Initialized" meant three things. There is now one project location (`locateProject`,
  `resolveProject`) and one status (`readProjectStatus`: the ledger verifies and holds
  `project.initialized`). `doctor` reports a torn final line as a warning.
- Ledger: a torn tail is recorded by its raw bytes; both events of an append are validated before
  any repair, so a rejected append leaves the file unchanged; an empty line or a BOM-prefixed tail
  is not accepted as an event; `inspect()` replaces the unverified `readAll()`.
- `withLockSync` refuses an async callback.
- Directory and file modes are enforced on existing paths too; the test suite removes its temp
  directories; `npm run build` starts from a clean `dist/` and `prepack` builds.

### Carried into M2

- Settle the budget event shape before any real ledger exists: `goal.md` budgets also have
  `wall_time` and `max_open_work_items`, and S6 has a disclosure budget, so budget events need a
  kind field rather than `rounds` only.
- Give `BudgetError` a code that separates "exhausted" (escalate to J6) from misuse, and return the
  written event from `declareBudget` and `raiseBudget`.
- When a third command needs the absent / corrupt / not-initialized decision, extract one helper
  instead of repeating it (today `doctor` and `ledger verify`).
- Symlinks planted inside `~/.omf` are followed (spec §8). Revisit with `O_NOFOLLOW` or `lstat`
  checks when M3 starts writing sealed material there.
