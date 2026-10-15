import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessGroup } from "../adapters/process-group.js";
import type { ProcessResult } from "../adapters/process-group.js";
import type { FixtureId, ScenarioRunner, ScenarioSession } from "./runner.js";
import type { RefusalCode, StepObservation } from "./types.js";

export interface FixtureEntry {
  id: FixtureId;
  file: string;
  sha256: string;
}

/**
 * The only programs the host adapter will ever execute (spec §5.3). Committed constants, not a hash
 * computed at install time: a hash recomputed from the shipped file would follow an edit of that file. A drift
 * test recomputes these from fixtures/, so changing a fixture or adding one is a reviewed change to this list.
 */
export const FIXTURE_ALLOWLIST: readonly FixtureEntry[] = [
  {
    id: "null-error",
    file: "null-error.mjs",
    sha256: "ef8b36e05e60fc2fca3c517376e6c503594c5ff5da127ece2f95b97c528d81e7",
  },
  {
    id: "null-empty",
    file: "null-empty.mjs",
    sha256: "271b9e38d87f8d367122ff6bf1fa9efd3c798f5bae49a82e9e5b8b3e911e785c",
  },
  {
    id: "echo-everything",
    file: "echo-everything.mjs",
    sha256: "5fb041d12b5ebc1c0fa4e6da82b619bc95f4191f149e7fd78ce906ef5a6ccfbe",
  },
];

/** `<package>/fixtures`, two levels above both `src/scenario` and `dist/scenario` (like `schemaUrl`). Never throws. */
export function fixturesDir(): string {
  const dir = fileURLToPath(new URL("../../fixtures", import.meta.url));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export type FixtureCheck =
  | { ok: true; id: FixtureId; realPath: string; source: string }
  | { ok: false; code: RefusalCode };

/**
 * Checks one fixture against the committed allowlist: the id must be listed, the file must exist in `dir`
 * (default: the package fixtures directory), its realpath must be a direct child of the real `dir`, it must be a
 * regular file and not a link, and the bytes read once must hash to the listed sha256. `source` is exactly those
 * bytes, so the caller executes what was verified. `dir` is a test seam only: the allowlist is always the
 * committed constant, so a modified copy in another directory is refused on its hash.
 */
export function verifyFixture(id: string, dir?: string): FixtureCheck {
  const entry = FIXTURE_ALLOWLIST.find((candidate) => candidate.id === id);
  if (entry === undefined) return { ok: false, code: "unknown_fixture" };
  let base: string;
  let stat: Stats;
  let real: string;
  try {
    base = realpathSync(dir ?? fixturesDir());
    const path = join(base, entry.file);
    stat = lstatSync(path);
    real = realpathSync(path);
  } catch {
    return { ok: false, code: "fixture_missing" };
  }
  if (dirname(real) !== base) return { ok: false, code: "fixture_outside_dir" };
  if (!stat.isFile()) return { ok: false, code: "fixture_not_regular_file" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(real);
  } catch {
    return { ok: false, code: "fixture_missing" };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    return { ok: false, code: "fixture_hash_mismatch" };
  return { ok: true, id: entry.id, realPath: real, source: bytes.toString("utf8") };
}

export interface HostFixtureRunnerOptions {
  /** Test seam: records the spawn. Defaults to the process-group adapter. */
  exec?: typeof runProcessGroup;
  /** One mkdtemp per scenario session, removed by close(). Default: the OS temp directory. */
  scratchRoot?: string;
  /** Test seam only. The committed allowlist still applies, so a modified copy is refused on its hash. */
  fixturesDir?: string;
}

/**
 * `runProcessGroup` decodes stdout lossily, so invalid UTF-8 arrives as U+FFFD. Fail closed: such output is an
 * `error` observation, never evidence about the implementation. A status of null means the group leader ended
 * by a signal; it is never mapped to an exit code.
 */
function observe(result: ProcessResult): StepObservation {
  switch (result.kind) {
    case "timeout":
      return { outcome: "timeout" };
    case "output_limit":
      return { outcome: "output_limit" };
    case "error":
      return { outcome: "error" };
    case "exited":
      if (result.status === null) return { outcome: "signaled", signal: result.signal ?? "unknown" };
      if (result.stdout.includes("�")) return { outcome: "error" };
      return { outcome: "exited", exit_code: result.status, stdout: result.stdout };
  }
}

function refusedSession(code: RefusalCode): ScenarioSession {
  return { runStep: async () => ({ outcome: "refused", code }), close: async () => {} };
}

/**
 * The only host adapter. Each step spawns `[process.execPath, "--input-type=module", "-e", <verified
 * source>, "--", ...step.argv]` with cwd = the scenario's scratch directory, shared by all steps of the
 * scenario, env = { LC_ALL: "C", HOME: scratch, TMPDIR: scratch } only, stdin = step.stdin and the
 * step limits. The program is always the node binary and the verified bytes; no element of a scenario is ever
 * the program, and the source is passed rather than re-read, so there is no gap between the hash check and the
 * execution. A candidate target is refused without a spawn: running candidate code is the M3f container's job.
 * The fixture is verified once per session, before the scratch directory is made.
 */
export function createHostFixtureRunner(options: HostFixtureRunnerOptions = {}): ScenarioRunner {
  const exec = options.exec ?? runProcessGroup;
  const scratchRoot = options.scratchRoot ?? tmpdir();
  return {
    id: "host-fixture",
    executes: "omf_fixture",
    async openScenario(target) {
      if (target.kind !== "fixture") return refusedSession("candidate_needs_container");
      const check = verifyFixture(target.id, options.fixturesDir);
      if (!check.ok) return refusedSession(check.code);
      const scratch = mkdtempSync(join(scratchRoot, "omf-scenario-"));
      let closed = false;
      return {
        async runStep(step, limits) {
          if (closed) return { outcome: "error" };
          const result = await exec([process.execPath, "--input-type=module", "-e", check.source, "--", ...step.argv], {
            cwd: scratch,
            env: { LC_ALL: "C", HOME: scratch, TMPDIR: scratch },
            stdin: step.stdin,
            timeoutMs: limits.timeoutMs,
            maxOutputBytes: limits.maxOutputBytes,
          });
          return observe(result);
        },
        async close() {
          closed = true;
          rmSync(scratch, { recursive: true, force: true });
        },
      };
    },
  };
}
