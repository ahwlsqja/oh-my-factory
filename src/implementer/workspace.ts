import type { ProcessResult } from "../adapters/process-group.js";
import type { ContainerHandle, ContainerRuntime, ExecSpec } from "../container/runtime.js";

/** The line that ends a bundle stream. A stream without it (or with anything after it) was cut off or tampered with. */
const BUNDLE_TERMINATOR = "OMF-BUNDLE-END";
/** The same for the workspace capture; a different word, so one stream can never pass for the other. */
const CAPTURE_TERMINATOR = "OMF-CAPTURE-END";
/** Written to stderr when `tar` fails: a pipe hides the exit status of its first command, so the failure is spelled out. */
const TAR_FAILED = "OMF-TAR-FAILED";

const QUICK_MS = 30_000;
const STEP_MS = 120_000;
const CAPTURE_MS = 300_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;

const script = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

/**
 * Checked before anything is extracted, so a missing tool reads as `tool_missing` and not as a half-built tree. Each tool has its
 * own `command -v`, because the shells of minimal images disagree about several operands.
 */
export const TOOLCHECK_ARGV: readonly string[] = [
  "sh",
  "-c",
  [
    "command -v git >/dev/null",
    "command -v tar >/dev/null",
    "command -v base64 >/dev/null",
    "command -v tr >/dev/null",
    "command -v sleep >/dev/null",
  ].join(" && "),
];

/**
 * Run twice from `/work`, once after the base tree is extracted and once after the context files are. It is a constant: nothing
 * about the tree, the item or the host is interpolated, and a file name in the tree is never a word of the script. Only `.` and
 * the git directory under it are named.
 *
 * First run (no `.git` yet): the commit of the base tree. The attributes file under `.git/info` outranks every `.gitattributes`
 * in the tree, so `git add` converts nothing: no line-ending conversion, no `$Id$` contraction, no clean filter. The root tree
 * therefore equals the tree the host built from raw blobs, which the host later proves. `--force` keeps a tracked file that an
 * ignore rule would otherwise hide. Second run: the commit of the `.omf` directory, which holds the two context files.
 */
export const PREPARE_SCRIPT: string = script([
  "set -eu",
  'GIT_AUTHOR_DATE="2000-01-01T00:00:00+0000"',
  'GIT_COMMITTER_DATE="2000-01-01T00:00:00+0000"',
  "export GIT_AUTHOR_DATE GIT_COMMITTER_DATE",
  "if [ -d .git ]; then",
  "  git add --all --force -- .omf",
  "  git commit -q --no-verify --no-gpg-sign -m context",
  "else",
  "  git init -q --template=",
  "  mkdir -p .git/info",
  "  printf '%s\\n' '* -text -eol -ident -filter -working-tree-encoding' > .git/info/attributes",
  "  git config user.name omf-implementer",
  "  git config user.email omf-implementer@invalid",
  "  git config core.autocrlf false",
  "  git config core.safecrlf false",
  "  git config core.hooksPath /dev/null",
  "  git config commit.gpgsign false",
  "  git add --all --force -- .",
  "  git commit -q --allow-empty --no-verify --no-gpg-sign -m base",
  "fi",
]);

/**
 * Every process of the container except the idle entrypoint and the shell that runs this command. The kernel leaves out PID 1
 * and the caller on its own, so the exec survives to report its status. Only a container is ever given this command.
 */
export const KILL_ALL_ARGV: readonly string[] = [
  "sh",
  "-c",
  [
    // With no process left to signal, `kill -9 -1` prints "No such process" and exits 1, so its own status and message are
    // ignored. What decides is the process table: the exec succeeds only when nothing but PID 1 and this shell is still alive
    // (a zombie is dead and does not count). The kill is asynchronous, so the table is polled for a short while.
    "kill -9 -1 2>/dev/null",
    "n=0",
    "while [ $n -lt 20 ]; do",
    "  left=0",
    "  for d in /proc/[0-9]*; do",
    '    p=${d#/proc/}; [ "$p" = 1 ] && continue; [ "$p" = "$$" ] && continue',
    '    st=""; while read -r k v _; do [ "$k" = "State:" ] && st=$v; done < "$d/status" 2>/dev/null',
    '    [ -n "$st" ] && [ "$st" != Z ] && left=1',
    "  done",
    "  [ $left -eq 0 ] && exit 0",
    "  n=$((n+1)); kill -9 -1 2>/dev/null; sleep 0.1 2>/dev/null || sleep 1",
    "done",
    "exit 1",
  ].join("\n"),
];

/**
 * Commits what the implementer left uncommitted and writes the bundle of `HEAD`. Hooks are switched off on the command line
 * (which outranks the repository's own config, a file the implementer could have edited), git's output goes to the null device
 * (a stray line on stdout would break the stream), and the stream is exactly one base64 line and the terminator line. Ignore
 * rules apply: build output the implementer ignored is not committed.
 */
export const FINALIZE_SCRIPT: string = script([
  "set -eu",
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }',
  "g add --all >/dev/null 2>&1",
  "if ! g diff --cached --quiet >/dev/null 2>&1; then",
  '  g commit -q --no-verify --no-gpg-sign -m "uncommitted work" >/dev/null 2>&1',
  "fi",
  'g bundle create "$OMF_TMP/candidate.bundle" HEAD >/dev/null 2>&1',
  "base64 < \"$OMF_TMP/candidate.bundle\" | tr -d '\\n'",
  `printf '\\n${BUNDLE_TERMINATOR}\\n'`,
]);

/** Run from `/`: the three writable trees of the container as one tar stream, armoured like the bundle. */
export const CAPTURE_SCRIPT: string = script([
  "set -u",
  `{ tar -c -f - work tmp agent 2>/dev/null || echo ${TAR_FAILED} >&2; } | base64 | tr -d '\\n'`,
  `printf '\\n${CAPTURE_TERMINATOR}\\n'`,
]);

export type PrepareCode = "tool_missing" | "extract_failed" | "init_failed";
export type BundleCode = "finalize_failed" | "bundle_too_large" | "bundle_malformed";

/** A runtime that throws (daemon gone, bad name) is an error result: the callers map every non-exit to a closed code. */
async function execOrError(runtime: ContainerRuntime, handle: ContainerHandle, spec: ExecSpec): Promise<ProcessResult> {
  try {
    return await runtime.exec(handle, spec);
  } catch {
    return { kind: "error", code: null, message: "runtime_error" };
  }
}

const succeeded = (result: ProcessResult): boolean => result.kind === "exited" && result.status === 0;

/** The most output a stream of `maxBytes` raw bytes can take once armoured, plus the terminator and a little slack. */
const armouredLimit = (maxBytes: number): number => Math.ceil(maxBytes / 3) * 4 + 4096;

/**
 * `<base64>\n<terminator>\n` and nothing else. `ProcessResult.stdout` is decoded text, so binary output travels armoured. The
 * decode is strict: the alphabet, the length and the canonical padding are all checked, and the bytes must encode back to the
 * same text, so a lossy or lenient reading can never pass.
 */
function decodeArmoured(stdout: string, terminator: string): Buffer | null {
  const lines = stdout.split("\n");
  if (lines.length !== 3 || lines[1] !== terminator || lines[2] !== "") return null;
  const data = lines[0] ?? "";
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : null;
}

const extractSpec = (tar: Buffer): ExecSpec => ({
  argv: ["tar", "-x", "-f", "-"],
  stdin: tar,
  workdir: "/work",
  timeoutMs: STEP_MS,
  maxOutputBytes: SMALL_OUTPUT_BYTES,
});

const prepareSpec = (): ExecSpec => ({
  argv: ["sh", "-c", PREPARE_SCRIPT],
  workdir: "/work",
  timeoutMs: STEP_MS,
  maxOutputBytes: SMALL_OUTPUT_BYTES,
});

/**
 * Puts the base tree and the context files into `/work` and commits them as a root commit and a context commit, in this order:
 * tool check, extract the base, commit it, extract the context, commit it. The first failing step decides the closed code.
 */
export async function prepareWorkspace(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  input: { baseTar: Buffer; contextTar: Buffer },
): Promise<{ ok: true } | { ok: false; code: PrepareCode }> {
  const steps: ReadonlyArray<{ code: PrepareCode; spec: ExecSpec }> = [
    { code: "tool_missing", spec: { argv: TOOLCHECK_ARGV, timeoutMs: QUICK_MS, maxOutputBytes: SMALL_OUTPUT_BYTES } },
    { code: "extract_failed", spec: extractSpec(input.baseTar) },
    { code: "init_failed", spec: prepareSpec() },
    { code: "extract_failed", spec: extractSpec(input.contextTar) },
    { code: "init_failed", spec: prepareSpec() },
  ];
  for (const step of steps) {
    if (!succeeded(await execOrError(runtime, handle, step.spec))) return { ok: false, code: step.code };
  }
  return { ok: true };
}

/**
 * Run after the session whatever its outcome and before the capture and the finalize, so that no background job of the
 * implementer is still writing while the workspace is read or bundled.
 */
export async function killAllProcesses(runtime: ContainerRuntime, handle: ContainerHandle): Promise<{ ok: boolean }> {
  const result = await execOrError(runtime, handle, {
    argv: KILL_ALL_ARGV,
    timeoutMs: QUICK_MS,
    maxOutputBytes: SMALL_OUTPUT_BYTES,
  });
  return { ok: succeeded(result) };
}

/** Finalizes the workspace and returns the bundle of `HEAD`. The bundle is hostile data until the host has imported it. */
export async function finalizeAndBundle(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  maxBytes: number,
): Promise<{ ok: true; bundle: Buffer } | { ok: false; code: BundleCode }> {
  const result = await execOrError(runtime, handle, {
    argv: ["sh", "-c", FINALIZE_SCRIPT],
    workdir: "/work",
    timeoutMs: STEP_MS,
    maxOutputBytes: armouredLimit(maxBytes),
  });
  if (result.kind === "output_limit") return { ok: false, code: "bundle_too_large" };
  if (result.kind !== "exited" || result.status !== 0) return { ok: false, code: "finalize_failed" };
  const bundle = decodeArmoured(result.stdout, BUNDLE_TERMINATOR);
  if (bundle === null) return { ok: false, code: "bundle_malformed" };
  return bundle.length > maxBytes ? { ok: false, code: "bundle_too_large" } : { ok: true, bundle };
}

/**
 * The writable trees of the container (`/work`, `/tmp`, `/agent`) as exact tar bytes, for scanning only: the host never
 * extracts them. `complete` is false when the cap was hit, the exec failed, `tar` reported a failure or the decode was not
 * strict; a caller treats an incomplete capture as a failed scan, never as a clean one.
 */
export async function captureWorkspace(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  maxBytes: number,
): Promise<{ bytes: Buffer; complete: boolean }> {
  const incomplete = { bytes: Buffer.alloc(0), complete: false };
  const result = await execOrError(runtime, handle, {
    argv: ["sh", "-c", CAPTURE_SCRIPT],
    workdir: "/",
    timeoutMs: CAPTURE_MS,
    maxOutputBytes: armouredLimit(maxBytes),
  });
  if (result.kind !== "exited" || result.status !== 0 || result.stderr.includes(TAR_FAILED)) return incomplete;
  const bytes = decodeArmoured(result.stdout, CAPTURE_TERMINATOR);
  return bytes === null || bytes.length > maxBytes ? incomplete : { bytes, complete: true };
}
