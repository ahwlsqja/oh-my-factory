import { describe, expect, it } from "vitest";
import { execArgv } from "../../src/container/argv.js";
import { markMeasured } from "../../src/container/measured-handles.js";
import { createDockerRuntime } from "../../src/container/docker-cli.js";
import { createDockerRuntimeSync } from "../../src/container/docker-sync.js";
import { ContainerSpecError, SECRET_ENV_NAMES, type SecretEnvName } from "../../src/container/spec.js";
import { IMPLEMENTER_BASE, TEST_SECRET, secretHandle, specFor } from "../helpers/container-fixture.js";
import { FakeDocker, fakeDockerBin, verbOf } from "../helpers/fake-docker.js";
import { addImage } from "../helpers/fake-docker-core.mjs";

// The one vendor key reaches a container only as a name-only `--env NAME` at exec time; the docker client reads the value from
// its own environment for that one child. It is never in an argv, a spec, a golden or a record (spec §5.6, §7).
const PLAIN = { argv: ["env"], timeoutMs: 1000, maxOutputBytes: 1000 } as const;
const spec = specFor("implementer");
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ContainerSpecError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

interface Logged {
  argv: readonly string[];
  env: Readonly<Record<string, string>> | undefined;
}

/** The real runtime over a FakeDocker, logging the argv and the extra client environment of every docker call. */
function runtimeOver(fake: FakeDocker, log: Logged[]) {
  return createDockerRuntime({
    context: "fake",
    run: async (argv, options) => {
      log.push({ argv, env: options.env });
      return fake.run(argv, options);
    },
    env: { PATH: "/usr/bin", HOME: "/home/x" },
  });
}

async function started(fake: FakeDocker, log: Logged[]) {
  addImage(fake.state, IMPLEMENTER_BASE);
  const runtime = runtimeOver(fake, log);
  // Stands in for createMeasured: a secret exec needs a handle that was measured.
  const handle = markMeasured(await runtime.create(spec));
  await runtime.start(handle);
  return { runtime, handle };
}

describe("execArgv and a secret", () => {
  it("passes a secret by name after the plain env flags and before the container name", () => {
    expect(SECRET_ENV_NAMES).toEqual(["ANTHROPIC_API_KEY", "CODEX_API_KEY"]);
    const base = { argv: ["claude", "-p"], workdir: "/work", env: { LANG: "C" }, stdin: true };
    const plain = execArgv(spec.name, base, "ctx");
    const withSecret = execArgv(spec.name, { ...base, secret: "ANTHROPIC_API_KEY" }, "ctx");
    const at = plain.indexOf(spec.name);
    expect(withSecret).toEqual([...plain.slice(0, at), "--env", "ANTHROPIC_API_KEY", ...plain.slice(at)]);
    expect(withSecret.some((element) => element.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
  });

  it.each(["ANTHROPIC_API_KEY", "CODEX_API_KEY"])("refuses %s=value in env, where a value could reach argv", (name) => {
    expect(codeOf(() => execArgv(spec.name, { argv: ["env"], env: { [name]: "x" }, stdin: false }, null))).toBe(
      "invalid_exec",
    );
  });

  it("refuses a secret name outside the closed set", () => {
    const secret = "OPENAI_API_KEY" as SecretEnvName;
    expect(codeOf(() => execArgv(spec.name, { argv: ["env"], secret, stdin: false }, null))).toBe("invalid_exec");
  });
});

describe("the runtime and a secret", () => {
  it("hands the value to the docker client for that one exec and never records it", async () => {
    const hookEnvs: Array<Record<string, string>> = [];
    const fake = new FakeDocker({
      exec: (call) => {
        hookEnvs.push(call.env);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const log: Logged[] = [];
    const { runtime, handle } = await started(fake, log);
    await runtime.exec(handle, PLAIN);
    await runtime.exec(handle, { ...PLAIN, secret: secretHandle() });
    await runtime.exec(handle, PLAIN);

    const execs = log.filter((entry) => verbOf(entry.argv) === "exec");
    expect(execs.map((entry) => entry.env)).toEqual([undefined, { ANTHROPIC_API_KEY: TEST_SECRET }, undefined]);
    expect(log.filter((entry) => verbOf(entry.argv) !== "exec").every((entry) => entry.env === undefined)).toBe(true);
    expect(hookEnvs).toEqual([{}, { ANTHROPIC_API_KEY: TEST_SECRET }, {}]);
    const argv = execs[1]?.argv ?? [];
    expect(argv).toContain("ANTHROPIC_API_KEY");
    expect(argv.some((element) => element.includes(TEST_SECRET))).toBe(false);
    expect(JSON.stringify(fake.state.calls)).not.toContain(TEST_SECRET);
  });

  it.each(["sut", "harness", "workcopy"] as const)(
    "refuses a secret for a %s handle before the value is read or anything reaches the daemon",
    async (role) => {
      const fake = new FakeDocker();
      const { runtime, handle } = await started(fake, []);
      let reads = 0;
      const secret = {
        name: "ANTHROPIC_API_KEY" as const,
        reveal: () => {
          reads += 1;
          return TEST_SECRET;
        },
      };
      await expect(runtime.exec({ ...handle, role }, { ...PLAIN, secret })).rejects.toMatchObject({
        code: "invalid_exec",
      });
      expect(reads).toBe(0);
      expect(fake.calls("exec")).toHaveLength(0);
    },
  );

  it("refuses a secret in the synchronous twin, which never carries one", () => {
    const calls: string[][] = [];
    const runtime = createDockerRuntimeSync({
      context: "fake",
      run: (argv) => {
        calls.push([...argv]);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const handle = { name: "omf-x", id: "abc", role: "implementer" } as const;
    expect(() => runtime.execSync(handle, { ...PLAIN, secret: secretHandle() })).toThrow(
      expect.objectContaining({ code: "invalid_exec" }),
    );
    expect(calls).toEqual([]);
  });

  it("refuses a secret name in ExecSpec.env before anything reaches the daemon", async () => {
    const fake = new FakeDocker();
    const { runtime, handle } = await started(fake, []);
    await expect(runtime.exec(handle, { ...PLAIN, env: { ANTHROPIC_API_KEY: TEST_SECRET } })).rejects.toMatchObject({
      code: "invalid_exec",
    });
    expect(fake.calls("exec")).toHaveLength(0);
  });

  it.each([
    ["empty", ""],
    ["newline", "a\nb"],
    ["carriage return", "a\rb"],
    ["NUL", "a\0b"],
  ])("refuses a value the client could not carry faithfully (%s)", async (_label, value) => {
    const fake = new FakeDocker();
    const { runtime, handle } = await started(fake, []);
    await expect(runtime.exec(handle, { ...PLAIN, secret: secretHandle(value) })).rejects.toMatchObject({
      code: "invalid_exec",
    });
    expect(fake.calls("exec")).toHaveLength(0);
  });

  it("through the default runner the docker child holds the variable for that exec only", async () => {
    const bin = fakeDockerBin();
    bin.update((state) => void addImage(state, IMPLEMENTER_BASE));
    const runtime = createDockerRuntime({
      context: "fake",
      env: { PATH: bin.path, HOME: "/home/x", ANTHROPIC_API_KEY: "caller-env-must-not-pass" },
    });
    // Stands in for createMeasured: a secret exec needs a handle that was measured.
    const handle = markMeasured(await runtime.create(spec));
    await runtime.start(handle);
    await runtime.exec(handle, PLAIN);
    await runtime.exec(handle, { ...PLAIN, secret: secretHandle() });

    const state = bin.state();
    const keys = (verb: string) =>
      state.calls.filter((call) => verbOf(call.argv) === verb).map((call) => call.env_keys?.join(","));
    expect(keys("exec")).toEqual(["DOCKER_CONFIG,PATH", "ANTHROPIC_API_KEY,DOCKER_CONFIG,PATH"]);
    for (const verb of ["create", "start", "context inspect"]) {
      expect(new Set(keys(verb))).toEqual(new Set(["DOCKER_CONFIG,PATH"]));
    }
    expect(JSON.stringify(state)).not.toContain(TEST_SECRET);
    expect(JSON.stringify(state)).not.toContain("caller-env-must-not-pass");
  });
});
