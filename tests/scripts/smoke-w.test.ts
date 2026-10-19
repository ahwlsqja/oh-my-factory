import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// scripts/smoke-w.sh walks omf seal, run and report in a throwaway project against an item that does not exist. It spends
// nothing, so unlike the model suites it can run here with made-up keys; it must refuse without keys, print no key and leave
// nothing behind.
const SCRIPT = fileURLToPath(new URL("../../scripts/smoke-w.sh", import.meta.url));
const AUTHOR = "sk-test-author-aaaa1111";
const IMPL = "sk-test-implementer-bbbb2222";

describe("scripts/smoke-w.sh", () => {
  it("is executable, valid POSIX sh, and neither traces nor echoes a key", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const syntax = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/set -[a-z]*x/);
    expect(source).not.toMatch(/(?:echo|printf)[^\n]*\$\{?OMF_(?:AUTHOR|IMPLEMENTER)_API_KEY/);
  });

  it.each([
    ["OMF_AUTHOR_API_KEY", { OMF_IMPLEMENTER_API_KEY: IMPL }],
    ["OMF_IMPLEMENTER_API_KEY", { OMF_AUTHOR_API_KEY: AUTHOR }],
  ])("refuses without %s and runs nothing", (missing, env) => {
    const result = spawnSync("sh", [SCRIPT], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toContain("Nothing was run");
    expect(result.stdout + result.stderr).not.toMatch(/sk-test/);
  });

  it("walks the three verbs in a temp project, prints no key and removes its scratch directory", () => {
    const bin = makeTempDir("omf-smoke-w-bin-");
    const scratchParent = makeTempDir("omf-smoke-w-tmp-");
    // The only docker the script may see answers `context inspect` and nothing else, like a client with no daemon.
    writeFileSync(
      join(bin, "docker"),
      [
        "#!/bin/sh",
        'if [ "$1" = "context" ] && [ "$2" = "inspect" ]; then',
        '  echo "unix:///home/dev/.colima/omf-m3f/docker.sock"',
        "  exit 0",
        "fi",
        'echo "docker is not available" >&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "docker"), 0o755);
    const result = spawnSync("sh", [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: makeTempDir("omf-smoke-w-home-"),
        TMPDIR: scratchParent,
        OMF_AUTHOR_API_KEY: AUTHOR,
        OMF_IMPLEMENTER_API_KEY: IMPL,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const verb of ["seal", "run", "report"])
      expect(result.stdout).toContain(`ok: omf ${verb} refuses an unknown item`);
    expect(result.stdout + result.stderr).not.toContain(AUTHOR);
    expect(result.stdout + result.stderr).not.toContain(IMPL);
    expect(readdirSync(scratchParent)).toEqual([]);
  });
});
