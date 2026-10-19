import { appendFileSync, chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHOR_EGRESS_WARNING, probeBaseEnv, runDoctor, runDoctorParallel } from "../../src/core/doctor.js";
import { projectDir } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const SECRETS = {
  OMF_AUTHOR_API_KEY: "author-secret-value",
  OMF_IMPLEMENTER_API_KEY: "implementer-secret-value",
  ANTHROPIC_API_KEY: "anthropic-secret-value",
  CODEX_API_KEY: "codex-secret-value",
  OPENAI_API_KEY: "openai-secret-value",
  GITHUB_TOKEN: "token-secret-value",
  DOCKER_AUTH_CONFIG: "docker-auth-secret-value",
};

/** Fake CLIs that dump their whole environment to <name>.env beside them, then behave like the real tools. */
function dumpingBin(): string {
  const dir = makeTempDir("omf-envbin-");
  const dump = 'env > "${0%/*}/$(basename "$0").env"';
  const write = (name: string, body: string): void => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${dump}\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write("claude", 'echo "2.1.0"');
  write("codex", 'echo "codex-cli 0.160.1"');
  write("docker", 'if [ "$1" = "info" ]; then echo 29; else echo "Docker version 29"; fi');
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\n${dump}\nexec ${realGit} "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  for (const name of ["env", "basename"]) {
    symlinkSync(execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(), join(dir, name));
  }
  return dir;
}

function callerEnv(bin: string): NodeJS.ProcessEnv {
  const home = makeTempDir("omf-home-");
  return { HOME: home, OMF_HOME: join(home, ".omf"), PATH: bin, DOCKER_HOST: "unix:///tmp/x.sock", ...SECRETS };
}

function dumped(bin: string, name: string): string {
  return readFileSync(join(bin, `${name}.env`), "utf8");
}

describe("doctor probe environment", () => {
  it("keeps key and secret variables out of every probe child", async () => {
    for (const run of [
      async (r: string, e: NodeJS.ProcessEnv) => runDoctor(r, e),
      async (r: string, e: NodeJS.ProcessEnv) => runDoctorParallel(r, e),
    ]) {
      const bin = dumpingBin();
      const e = callerEnv(bin);
      await run(makeGitRepo(), e);
      for (const tool of ["claude", "codex", "docker", "git"]) {
        const text = dumped(bin, tool);
        for (const [name, value] of Object.entries(SECRETS)) {
          expect(text, `${tool} saw ${name}`).not.toContain(`${name}=`);
          expect(text).not.toContain(value);
        }
      }
    }
  });

  it("gives DOCKER_* only to the docker probe", () => {
    const bin = dumpingBin();
    runDoctor(makeGitRepo(), callerEnv(bin));
    expect(dumped(bin, "docker")).toContain("DOCKER_HOST=unix:///tmp/x.sock");
    for (const tool of ["claude", "codex", "git"]) expect(dumped(bin, tool)).not.toContain("DOCKER_HOST");
  });

  it("probeBaseEnv drops anything outside the allowlist", () => {
    const env = { PATH: "/bin", LANG: "C", FOO: "1", MY_SECRET: "x", DOCKER_CONTEXT: "c", DOCKER_AUTH_CONFIG: "y" };
    expect(probeBaseEnv(env, "plain")).toEqual({ PATH: "/bin", LANG: "C" });
    expect(probeBaseEnv(env, "docker")).toEqual({ PATH: "/bin", LANG: "C", DOCKER_CONTEXT: "c" });
  });
});

describe("author egress in doctor", () => {
  function configured(context: string | null, image: boolean): ReturnType<typeof runDoctor> {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = { HOME: home, OMF_HOME: join(home, ".omf"), PATH: makeTempDir("omf-emptybin-") };
    initProject(repo, e);
    const config = join(projectDir(repo, e), "config.toml");
    appendFileSync(
      config,
      `\n[judge]\n${context === null ? "" : `docker_context = "${context}"\n`}\n[author]\n${image ? `image = "sha256:${"a".repeat(64)}"\n` : ""}`,
    );
    return runDoctor(repo, e);
  }

  it("warns that author egress is not restricted once an author image is configured", () => {
    expect(configured("colima-omf", true).warnings).toContain(AUTHOR_EGRESS_WARNING);
    expect(configured("colima-omf", false).warnings).not.toContain(AUTHOR_EGRESS_WARNING);
  });

  it("warns when the docker context is a shared one, not when it is dedicated", () => {
    const shared = configured("colima", true).warnings.join("\n");
    expect(shared).toContain('docker context "colima" is a shared context');
    expect(configured("colima-omf", true).warnings.join("\n")).not.toContain("shared context");
  });
});
