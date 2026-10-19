import { describe, expect, it } from "vitest";
import { execArgv } from "../../src/container/argv.js";
import { createDockerRuntime } from "../../src/container/docker-cli.js";
import { markMeasured } from "../../src/container/measured-handles.js";
import {
  CREDENTIAL_SHAPED_ENV_NAMES,
  ContainerSpecError,
  ROLE_SECRET,
  SECRET_ENV_NAMES,
  type SecretEnvName,
} from "../../src/container/spec.js";
import { AUTHOR_BASE, FIXTURE_RUN_ID, secretHandle, specFor } from "../helpers/container-fixture.js";
import { FakeDocker } from "../helpers/fake-docker.js";
import { addImage } from "../helpers/fake-docker-core.mjs";
import { fakeRuntime } from "../helpers/fake-runtime.js";

// covers: S5.3.role-bound-secrets
// W-secret-role-bound: a vendor key reaches a container only as a name-only `--env NAME` on an exec, the value read by the
// docker client from its own environment for that one child. Each key belongs to one role: the implementer carries the
// Anthropic key and the author the Codex key. Candidate code runs in every other role, and a key given to the wrong agent role
// would be a key given to the wrong vendor. Any other pairing is refused before a process starts or the value is read.
const NAME = `omf-author-${FIXTURE_RUN_ID}-1-1`;
const PLAIN = { argv: ["env"], timeoutMs: 1000, maxOutputBytes: 1000 } as const;
const CODEX_KEY = "sk-codex-test-0123456789abcdefghij";

async function startedAuthor(fake: FakeDocker) {
  addImage(fake.state, AUTHOR_BASE);
  const runtime = fakeRuntime(fake);
  // Stands in for createMeasured: a secret exec needs a handle that was measured.
  const handle = markMeasured(await runtime.create(specFor("author")));
  await runtime.start(handle);
  return { runtime, handle };
}

describe("the secret tables", () => {
  it("lists exactly the credential-shaped names the golden refuses in an image", () => {
    expect([...CREDENTIAL_SHAPED_ENV_NAMES]).toEqual([
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "HF_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]);
  });

  it("names two secrets, binds each to one role, and keeps both credential-shaped", () => {
    expect([...SECRET_ENV_NAMES]).toEqual(["ANTHROPIC_API_KEY", "CODEX_API_KEY"]);
    expect(ROLE_SECRET).toEqual({ implementer: "ANTHROPIC_API_KEY", author: "CODEX_API_KEY" });
    for (const name of SECRET_ENV_NAMES) expect(CREDENTIAL_SHAPED_ENV_NAMES).toContain(name);
  });
});

describe("execArgv and the Codex key", () => {
  it("is a name-only flag after the workdir and before the container name", () => {
    const exec = {
      argv: ["codex", "exec", "--ephemeral", "-"],
      workdir: "/in",
      stdin: true,
      secret: "CODEX_API_KEY",
    } as const;
    expect(execArgv(NAME, exec, "colima-omf-m3f").join(" ")).toBe(
      `--context colima-omf-m3f exec -i --workdir /in --env CODEX_API_KEY ${NAME} codex exec --ephemeral -`,
    );
  });

  it("refuses a malformed env name or a NUL in an env value, and passes a plain pair as KEY=value", () => {
    const code = (env: Record<string, string>) => {
      try {
        execArgv(NAME, { argv: ["env"], env, stdin: false }, null);
      } catch (error) {
        return error instanceof ContainerSpecError ? error.code : String(error);
      }
      return "no error";
    };
    expect(code({ "bad name": "x" })).toBe("invalid_exec");
    expect(code({ "1BAD": "x" })).toBe("invalid_exec");
    expect(code({ "A=B": "x" })).toBe("invalid_exec");
    expect(code({ FOO: "a\0b" })).toBe("invalid_exec");
    expect(code({ FOO: "plain" })).toBe("no error");
    expect(execArgv(NAME, { argv: ["env"], env: { FOO: "plain" }, stdin: false }, null)).toContain("FOO=plain");
  });

  it.each(["ANTHROPIC_API_KEY", "CODEX_API_KEY"])("refuses %s=value in env, where a value could reach argv", (name) => {
    const bad = () => execArgv(NAME, { argv: ["env"], env: { [name]: "x" }, stdin: false }, null);
    expect(bad).toThrow(expect.objectContaining({ code: "invalid_exec" }));
  });
});

describe("the runtime binds a secret to its role", () => {
  it("hands the author's key to the docker client for that one exec and records it nowhere", async () => {
    const envs: Array<Record<string, string>> = [];
    const fake = new FakeDocker({
      exec: (call) => {
        envs.push(call.env);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const { runtime, handle } = await startedAuthor(fake);
    await runtime.exec(handle, PLAIN);
    await runtime.exec(handle, { ...PLAIN, secret: secretHandle(CODEX_KEY, "CODEX_API_KEY") });
    expect(envs).toEqual([{}, { CODEX_API_KEY: CODEX_KEY }]);
    const argv = fake.calls("exec")[1]?.argv ?? [];
    expect(argv).toContain("CODEX_API_KEY");
    expect(argv.some((element) => element.includes(CODEX_KEY))).toBe(false);
    expect(JSON.stringify(fake.state.calls)).not.toContain(CODEX_KEY);
  });

  it.each([
    ["author", "ANTHROPIC_API_KEY"],
    ["implementer", "CODEX_API_KEY"],
    ["sut", "ANTHROPIC_API_KEY"],
    ["sut", "CODEX_API_KEY"],
    ["harness", "CODEX_API_KEY"],
    ["workcopy", "ANTHROPIC_API_KEY"],
    ["workcopy", "CODEX_API_KEY"],
  ] as const)(
    "refuses a %s exec carrying %s before the value is read or anything reaches the daemon",
    async (role, name) => {
      const fake = new FakeDocker();
      const { runtime, handle } = await startedAuthor(fake);
      let reads = 0;
      const secret = {
        name: name satisfies SecretEnvName,
        reveal: () => {
          reads += 1;
          return CODEX_KEY;
        },
      };
      await expect(runtime.exec({ ...handle, role }, { ...PLAIN, secret })).rejects.toMatchObject({
        code: "invalid_exec",
      });
      expect(reads).toBe(0);
      expect(fake.calls("exec")).toHaveLength(0);
      await expect(runtime.exec({ ...handle, role }, { ...PLAIN, secret })).rejects.toBeInstanceOf(ContainerSpecError);
    },
  );

  it("gives the key to the docker client as the environment of that one exec and to no other call", async () => {
    const fake = new FakeDocker();
    addImage(fake.state, AUTHOR_BASE);
    const seen: Array<{ argv: readonly string[]; env: Readonly<Record<string, string>> | undefined }> = [];
    const runtime = createDockerRuntime({
      context: "fake",
      run: async (argv, options) => {
        seen.push({ argv, env: options.env });
        return fake.run(argv, options);
      },
      runSync: fake.runSync,
      env: { PATH: "/usr/bin", HOME: "/home/x" },
    });
    const handle = markMeasured(await runtime.create(specFor("author")));
    await runtime.start(handle);
    await runtime.exec(handle, PLAIN);
    const result = await runtime.exec(handle, { ...PLAIN, secret: secretHandle(CODEX_KEY, "CODEX_API_KEY") });
    await runtime.remove(handle);
    const carrying = seen.filter((call) => call.env !== undefined && Object.keys(call.env).length > 0);
    expect(carrying.map((call) => call.argv.includes("exec"))).toEqual([true]);
    expect(carrying[0]?.env).toEqual({ CODEX_API_KEY: CODEX_KEY });
    expect(JSON.stringify(seen.map((call) => call.argv))).not.toContain(CODEX_KEY);
    expect(JSON.stringify(result)).not.toContain(CODEX_KEY);
    expect(JSON.stringify(fake.state)).not.toContain(CODEX_KEY);
  });

  it.each(["", "a\nb", "a\rb", "a\0b"])(
    "refuses a key value the docker client could not carry faithfully (%j)",
    async (value) => {
      const fake = new FakeDocker();
      const { runtime, handle } = await startedAuthor(fake);
      await expect(
        runtime.exec(handle, { ...PLAIN, secret: secretHandle(value, "CODEX_API_KEY") }),
      ).rejects.toMatchObject({ code: "invalid_exec" });
      expect(fake.calls("exec")).toHaveLength(0);
    },
  );
});
