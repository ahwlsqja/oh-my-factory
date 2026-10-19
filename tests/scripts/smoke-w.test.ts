import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
    // Stand-ins for the programs the script would use after the key check: any call to one of them leaves a mark.
    const bin = makeTempDir("omf-smoke-w-marks-");
    const marks = join(bin, "marks");
    for (const tool of ["docker", "git", "node"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> ${JSON.stringify(marks)}\nexit 1\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const result = spawnSync("sh", [SCRIPT], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr.startsWith(`${missing} is not set;`)).toBe(true);
    expect(result.stderr).toContain("Nothing was run");
    expect(result.stdout + result.stderr).not.toMatch(/sk-test/);
    expect(existsSync(marks), "a program was started after the refusal").toBe(false);
  });

  it("refuses with exit 2 and 'Nothing was run' when dist is missing, a tool is missing or the docker context is the wrong one", () => {
    const keys = { OMF_AUTHOR_API_KEY: AUTHOR, OMF_IMPLEMENTER_API_KEY: IMPL };
    // No build: a copy of the script in a tree that has no dist/.
    const tree = makeTempDir("omf-smoke-w-tree-");
    mkdirSync(join(tree, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(tree, "scripts", "smoke-w.sh"));
    const noDist = spawnSync("sh", [join(tree, "scripts", "smoke-w.sh")], {
      env: { PATH: process.env.PATH ?? "", ...keys },
      encoding: "utf8",
    });
    expect(noDist.status).toBe(2);
    expect(noDist.stderr).toContain("dist/ is missing");
    expect(noDist.stderr).toContain("Nothing was run");

    // No docker on PATH: only the programs the script needs before it, linked from where they really are.
    const tools = makeTempDir("omf-smoke-w-tools-");
    for (const name of ["printenv", "dirname", "mktemp", "rm", "git"]) {
      const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (found !== "") symlinkSync(found, join(tools, name));
    }
    symlinkSync(process.execPath, join(tools, "node"));
    const noDocker = spawnSync("/bin/sh", [SCRIPT], { env: { PATH: tools, ...keys }, encoding: "utf8" });
    expect(noDocker.status, noDocker.stderr).toBe(2);
    expect(noDocker.stderr).toContain("docker is not installed");
    expect(noDocker.stderr).toContain("Nothing was run");

    // A context that points anywhere but the omf-m3f socket.
    const bin = makeTempDir("omf-smoke-w-bin-");
    writeFileSync(join(bin, "docker"), '#!/bin/sh\necho "unix:///var/run/docker.sock"\n');
    chmodSync(join(bin, "docker"), 0o755);
    const wrong = spawnSync("sh", [SCRIPT], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...keys },
      encoding: "utf8",
    });
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain("does not point at the omf-m3f socket");
    expect(wrong.stderr).toContain("Nothing was run");
  });

  it("removes its scratch directory when it is terminated mid-walk", async () => {
    const bin = makeTempDir("omf-smoke-w-bin-");
    const scratchParent = makeTempDir("omf-smoke-w-tmp-");
    const pidFile = join(bin, "git.pid");
    writeFileSync(join(bin, "docker"), '#!/bin/sh\necho "unix:///home/dev/.colima/omf-m3f/docker.sock"\n');
    // The first program the walk starts hangs, so the script is still inside it when the signal arrives.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\n[ -e ${JSON.stringify(pidFile)} ] && exit 1\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 20\n`,
    );
    for (const tool of ["docker", "git"]) chmodSync(join(bin, tool), 0o755);
    const child = spawn("sh", [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: makeTempDir("omf-smoke-w-home-"),
        TMPDIR: scratchParent,
        OMF_AUTHOR_API_KEY: AUTHOR,
        OMF_IMPLEMENTER_API_KEY: IMPL,
      },
      stdio: "ignore",
    });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(pidFile), "the walk reached its first git call").toBe(true);
    expect(readdirSync(scratchParent).length).toBe(1);
    const hung = Number(readFileSync(pidFile, "utf8").trim());
    child.kill("SIGTERM");
    // The shell may wait for its foreground program before it acts on the signal: end the hung program by its own pid.
    try {
      process.kill(hung, "SIGTERM");
    } catch {
      // already gone
    }
    await closed;
    expect(readdirSync(scratchParent)).toEqual([]);
    expect(dirname(pidFile)).toBe(bin);
  }, 60_000);

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
