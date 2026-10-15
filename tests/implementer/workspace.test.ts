import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { contextTar } from "../../src/implementer/context-files.js";
import {
  CAPTURE_SCRIPT,
  captureWorkspace,
  FINALIZE_SCRIPT,
  finalizeAndBundle,
  KILL_ALL_ARGV,
  killAllProcesses,
  PREPARE_SCRIPT,
  type PrepareCode,
  prepareWorkspace,
  TOOLCHECK_ARGV,
} from "../../src/implementer/workspace.js";
import { FIXTURE_WORK_ID } from "../helpers/container-fixture.js";
import {
  BASE_ENTRIES,
  baseTar,
  type LocalTree,
  openLocalTree,
  runStub,
  STUB_BEHAVIOURS,
  treeOfEntries,
} from "../helpers/implementer-container.js";
import { isAlive, waitDead } from "../helpers/process.js";
import { makeTempDir } from "../helpers/tmp.js";

const MAX = 16 * 1024 * 1024;
const INPUT = {
  baseTar: baseTar(),
  contextTar: contextTar(FIXTURE_WORK_ID, { spec: "# spec\n", intent: "# intent\n" }),
};
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const lines = (text: string): string[] => text.trim().split("\n");
const exited = (status: number, stdout = "", stderr = ""): ProcessResult => ({
  kind: "exited",
  status,
  signal: null,
  stdout,
  stderr,
});

const trees: LocalTree[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const tree of trees.splice(0)) tree.local.dispose();
});

async function open(): Promise<LocalTree> {
  const tree = await openLocalTree();
  trees.push(tree);
  return tree;
}

async function prepared(): Promise<LocalTree> {
  const tree = await open();
  expect(await prepareWorkspace(tree.runtime, tree.handle, INPUT)).toEqual({ ok: true });
  return tree;
}

/** The fake daemon answers the one exec whose argv holds `marker`, instead of the double. */
function answer(tree: LocalTree, marker: string, result: ProcessResult): void {
  tree.fake.intercept = (argv) => (argv.includes(marker) ? result : null);
}

describe("the container scripts", () => {
  it("are constants: no interpolation point, no path but `.` and $OMF_TMP, pinned bytes", () => {
    for (const script of [PREPARE_SCRIPT, FINALIZE_SCRIPT, CAPTURE_SCRIPT]) {
      expect(script).not.toContain("${");
      expect(script).not.toContain("`");
      for (const variable of script.match(/\$[A-Za-z_]+/g) ?? []) expect(variable).toBe("$OMF_TMP");
      const stripped = script.replaceAll("/dev/null", "").replaceAll("$OMF_TMP/candidate.bundle", "");
      expect(stripped).not.toMatch(/(^|[\s"'=:(])\/[A-Za-z]/);
    }
    expect(sha256(PREPARE_SCRIPT)).toBe("e3444c599fec5941a126cf6924bb31e191260ef66140f39857121f92c368f18f");
    expect(sha256(FINALIZE_SCRIPT)).toBe("92a2d4bc1706ba5744e3289a7087eb1bc767f4b614cc3a2b7d58985ec17c1b3e");
    expect(sha256(CAPTURE_SCRIPT)).toBe("2fa11e9145d8800aeefe3c60c5ef7602aaaec247c859f8c7a5a1ef5378df9874");
    expect(KILL_ALL_ARGV).toEqual(["sh", "-c", "kill -9 -1"]);
    expect(TOOLCHECK_ARGV.slice(0, 2)).toEqual(["sh", "-c"]);
  });
});

describe("prepareWorkspace", () => {
  it("commits the base tree exactly, whatever the attributes say, then only the two context files", async () => {
    const tree = await prepared();
    expect(tree.local.git(["rev-parse", "HEAD~1^{tree}"]).trim()).toBe(treeOfEntries(BASE_ENTRIES));
    expect(lines(tree.local.git(["log", "--format=%s"]))).toEqual(["context", "base"]);
    expect(lines(tree.local.git(["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"]))).toEqual([
      `A\t.omf/${FIXTURE_WORK_ID}/intent.md`,
      `A\t.omf/${FIXTURE_WORK_ID}/spec.md`,
    ]);
    expect(tree.local.git(["cat-file", "blob", "HEAD~1:crlf.txt"])).toBe("one\r\ntwo\r\n");
    expect(existsSync(join(tree.local.work, "pwned"))).toBe(false);
  });

  it("reports a missing tool before anything is extracted", async () => {
    const tree = await open();
    tree.local.setPath(makeTempDir("omf-empty-path-"));
    expect(await prepareWorkspace(tree.runtime, tree.handle, INPUT)).toEqual({ ok: false, code: "tool_missing" });
    expect(tree.fake.calls("exec")).toHaveLength(1);
    expect(readdirSync(tree.local.work)).toEqual([]);
  });

  const FAILURES: ReadonlyArray<readonly [name: string, marker: string, code: PrepareCode, execs: number]> = [
    ["an extraction that fails", "tar", "extract_failed", 2],
    ["a commit step that fails", PREPARE_SCRIPT, "init_failed", 3],
  ];
  for (const [name, marker, code, execs] of FAILURES) {
    it(`stops at ${name} with ${code}`, async () => {
      const tree = await open();
      answer(tree, marker, exited(2));
      expect(await prepareWorkspace(tree.runtime, tree.handle, INPUT)).toEqual({ ok: false, code });
      expect(tree.fake.calls("exec")).toHaveLength(execs);
    });
  }

  it("lets the implementer commit plainly and ignores the developer's git setup", async () => {
    const dev = makeTempDir("omf-dev-home-");
    const hooks = join(dev, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\ntouch ${join(dev, "hook-ran")}\n`, { mode: 0o755 });
    writeFileSync(join(dev, ".gitconfig"), `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hooks}\n`);
    vi.stubEnv("HOME", dev);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(dev, ".gitconfig"));
    const tree = await prepared();
    expect(await runStub(tree, STUB_BEHAVIOURS.good)).toMatchObject({ kind: "exited", status: 0 });
    expect((await finalizeAndBundle(tree.runtime, tree.handle, MAX)).ok).toBe(true);
    expect(lines(tree.local.git(["log", "--format=%an %s"]))).toEqual([
      "omf-implementer feature",
      "omf-implementer plan",
      "omf-implementer context",
      "omf-implementer base",
    ]);
    expect(readdirSync(dev).sort()).toEqual([".gitconfig", "hooks"]);
  });
});

describe("finalizeAndBundle", () => {
  it("commits tracked changes, leaves ignored files out and returns the bundle byte for byte", async () => {
    const tree = await prepared();
    await runStub(tree, STUB_BEHAVIOURS.messy);
    const result = await finalizeAndBundle(tree.runtime, tree.handle, MAX);
    if (!result.ok) throw new Error(result.code);
    const written = join(tree.local.tmp, "candidate.bundle");
    expect(result.bundle.equals(readFileSync(written))).toBe(true);
    tree.local.git(["bundle", "verify", written]);
    expect(lines(tree.local.git(["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"]))).toEqual([
      "A\t.gitignore",
      "M\tREADME.md",
    ]);
    expect(tree.local.git(["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain("build.log");
  });

  it("never runs a hook the implementer planted", async () => {
    const tree = await prepared();
    await runStub(tree, STUB_BEHAVIOURS.hostileHook);
    const marker = join(tree.local.tmp, "hook-ran");
    tree.local.git(["commit", "-q", "--allow-empty", "-m", "probe"]);
    expect(existsSync(marker)).toBe(true); // control: the planted hooks do fire for a plain commit
    rmSync(marker);
    expect((await finalizeAndBundle(tree.runtime, tree.handle, MAX)).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a bundle over the cap", async () => {
    const tree = await prepared();
    expect(await finalizeAndBundle(tree.runtime, tree.handle, 10)).toEqual({ ok: false, code: "bundle_too_large" });
  });

  const STREAMS: ReadonlyArray<readonly [name: string, stdout: string]> = [
    ["no terminator", "AAAA\n"],
    ["a line after the terminator", "AAAA\nOMF-BUNDLE-END\nmore\n"],
    ["a stray line before the data", "[main abc1234] msg\nAAAA\nOMF-BUNDLE-END\n"],
    ["a character outside the alphabet", "AA*A\nOMF-BUNDLE-END\n"],
    ["a length not divisible by four", "AAA\nOMF-BUNDLE-END\n"],
    ["no data", "\nOMF-BUNDLE-END\n"],
  ];
  for (const [name, stdout] of STREAMS) {
    it(`calls ${name} malformed`, async () => {
      const tree = await open();
      answer(tree, FINALIZE_SCRIPT, exited(0, stdout));
      expect(await finalizeAndBundle(tree.runtime, tree.handle, MAX)).toEqual({ ok: false, code: "bundle_malformed" });
    });
  }

  it("decodes a well formed stream and maps every other result to a closed code", async () => {
    const tree = await open();
    answer(tree, FINALIZE_SCRIPT, exited(0, "AAAA\nOMF-BUNDLE-END\n"));
    expect(await finalizeAndBundle(tree.runtime, tree.handle, MAX)).toEqual({ ok: true, bundle: Buffer.alloc(3) });
    const failures: ReadonlyArray<readonly [ProcessResult, string]> = [
      [exited(1, "AAAA\nOMF-BUNDLE-END\n"), "finalize_failed"],
      [{ kind: "timeout", stdout: "", stderr: "" }, "finalize_failed"],
      [{ kind: "error", code: null, message: "x" }, "finalize_failed"],
      [{ kind: "output_limit", stdout: "", stderr: "" }, "bundle_too_large"],
    ];
    for (const [result, code] of failures) {
      answer(tree, FINALIZE_SCRIPT, result);
      expect(await finalizeAndBundle(tree.runtime, tree.handle, MAX)).toEqual({ ok: false, code });
    }
  });
});

describe("killAllProcesses", () => {
  it("ends a background job and runs nothing on the host but the double's own children", async () => {
    const tree = await prepared();
    expect(await runStub(tree, STUB_BEHAVIOURS.background)).toMatchObject({ kind: "exited", status: 0 });
    const pid = Number(readFileSync(join(tree.local.tmp, "bg.pid"), "utf8"));
    expect(isAlive(pid)).toBe(true);
    expect(await killAllProcesses(tree.runtime, tree.handle)).toEqual({ ok: true });
    expect(await waitDead(pid)).toBe(true);
    const kills = tree.local.execs.filter((exec) => exec.argv.join(" ").includes("kill -9 -1"));
    expect(kills).toHaveLength(1);
    expect(kills.every((exec) => !exec.ran)).toBe(true);
    expect(tree.local.killedGroups.length).toBeGreaterThan(0);
    expect(tree.local.killedGroups.every((group) => tree.local.spawnedGroups.includes(group))).toBe(true);
  });

  it("reports a failed exec as not ok", async () => {
    const tree = await open();
    answer(tree, KILL_ALL_ARGV[2] ?? "", exited(1));
    expect(await killAllProcesses(tree.runtime, tree.handle)).toEqual({ ok: false });
  });
});

describe("captureWorkspace", () => {
  it("returns the exact tar bytes of the writable trees, an untracked file in /tmp included", async () => {
    const tree = await prepared();
    await runStub(tree, STUB_BEHAVIOURS.messy);
    const capture = await captureWorkspace(tree.runtime, tree.handle, MAX);
    expect(capture.complete).toBe(true);
    expect(capture.bytes.includes("needle-in-tmp")).toBe(true);
    const independent = spawnSync("tar", ["-c", "-f", "-", "work", "tmp", "agent"], { cwd: tree.local.root });
    expect(capture.bytes.equals(independent.stdout)).toBe(true);
  });

  it("is incomplete at the cap", async () => {
    const tree = await prepared();
    expect(await captureWorkspace(tree.runtime, tree.handle, 1024)).toEqual({
      bytes: Buffer.alloc(0),
      complete: false,
    });
  });

  const BAD: ReadonlyArray<readonly [name: string, result: ProcessResult]> = [
    ["a failed exec", exited(1, "AAAA\nOMF-CAPTURE-END\n")],
    ["a tar failure on stderr", exited(0, "AAAA\nOMF-CAPTURE-END\n", "OMF-TAR-FAILED\n")],
    ["a lenient decode", exited(0, "AA*A\nOMF-CAPTURE-END\n")],
    ["a missing terminator", exited(0, "AAAA\n")],
    ["the output limit", { kind: "output_limit", stdout: "", stderr: "" }],
  ];
  for (const [name, result] of BAD) {
    it(`is incomplete after ${name}`, async () => {
      const tree = await open();
      answer(tree, CAPTURE_SCRIPT, result);
      expect(await captureWorkspace(tree.runtime, tree.handle, MAX)).toEqual({
        bytes: Buffer.alloc(0),
        complete: false,
      });
    });
  }

  it("is complete for a well formed stream", async () => {
    const tree = await open();
    answer(tree, CAPTURE_SCRIPT, exited(0, "AAAA\nOMF-CAPTURE-END\n"));
    expect(await captureWorkspace(tree.runtime, tree.handle, MAX)).toEqual({ bytes: Buffer.alloc(3), complete: true });
  });
});
