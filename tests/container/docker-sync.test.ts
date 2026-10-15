import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArgv, execArgv, inspectArgv, removeArgv, startArgv } from "../../src/container/argv.js";
import { type SyncRun, SyncRuntimeError, createDockerRuntimeSync } from "../../src/container/docker-sync.js";
import { CONTEXT, measureFixture } from "../helpers/measure-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

type Reply = { status: number | null; stdout: string; stderr: string };
const ok = (stdout = ""): Reply => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): Reply => ({ status: 1, stdout: "", stderr });

/** A runner that answers from a queue and records every argv. */
function scripted(...replies: Reply[]): { run: SyncRun; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...replies];
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      return queue.shift() ?? fail("unscripted");
    },
  };
}

describe("createDockerRuntimeSync", () => {
  it("builds every container argv with the same builders as the async runtime", async () => {
    const spec = (await measureFixture()).spec("sut");
    const { run, calls } = scripted(ok("c0ffee0123456789\n"), ok('[{"Id":"x"}]'), ok(), ok("out"), ok());
    const runtime = createDockerRuntimeSync({ context: CONTEXT, run });
    const handle = runtime.createSync(spec);
    expect(handle).toEqual({ name: spec.name, id: "c0ffee0123456789", role: "sut" });
    expect(runtime.inspectSync(handle)).toEqual([{ Id: "x" }]);
    runtime.startSync(handle);
    expect(runtime.execSync(handle, { argv: ["true"], timeoutMs: 1000, maxOutputBytes: 100 })).toMatchObject({
      kind: "exited",
      status: 0,
      stdout: "out",
    });
    runtime.removeSync(handle);
    expect(calls).toEqual([
      createArgv(spec, CONTEXT),
      inspectArgv(spec.name, CONTEXT),
      startArgv(spec.name, CONTEXT),
      execArgv(spec.name, { argv: ["true"], stdin: false }, CONTEXT),
      removeArgv([spec.name], CONTEXT),
    ]);
  });

  it("returns the exact docker info failure (capped), and refuses to run without a context", () => {
    const down = "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?";
    const info = (reply: Reply) => createDockerRuntimeSync({ context: CONTEXT, run: scripted(reply).run }).infoSync();
    expect(info(ok("29.0.1\n"))).toEqual({ ok: true, server_version: "29.0.1" });
    expect(info(fail(`${down}\n`))).toEqual({ ok: false, failure: down });
    const long = info(fail("x".repeat(5000)));
    expect(long.ok === false && long.failure.length).toBe(2000);
    const never = scripted(ok());
    const runtime = createDockerRuntimeSync({ context: null, run: never.run });
    expect(() => runtime.infoSync()).toThrow(SyncRuntimeError);
    expect(never.calls).toEqual([]);
  });

  it("classifies the endpoint (asking once) and reads a local image without pulling", () => {
    const table = [
      ["unix:///Users/x/.colima/omf-m3f/docker.sock", "unix", true],
      ["tcp://10.0.0.5:2376", "tcp", false],
      ["ssh://ci@build", "ssh", false],
      ["npipe:////./pipe/docker", "other", false],
    ] as const;
    for (const [host, kind, local] of table) {
      const { run, calls } = scripted(ok(`${host}\n`));
      const runtime = createDockerRuntimeSync({ context: CONTEXT, run });
      expect(runtime.endpointSync()).toEqual({ kind, local });
      expect(runtime.endpointSync()).toEqual({ kind, local });
      expect(calls).toHaveLength(1);
    }
    const doc = [
      {
        Id: `sha256:${"c".repeat(64)}`,
        Config: { Env: ["PATH=/bin", "NODE_VERSION=1"], User: "", Volumes: { "/data": {} } },
      },
    ];
    const image = (reply: Reply) =>
      createDockerRuntimeSync({ context: CONTEXT, run: scripted(reply).run }).imageInfoSync("img@sha256:x");
    expect(image(ok(JSON.stringify(doc)))).toEqual({
      id: `sha256:${"c".repeat(64)}`,
      env_names: ["NODE_VERSION", "PATH"],
      user: "",
      volumes: ["/data"],
    });
    expect(image(fail("No such image"))).toBeNull();
  });

  it("gives the docker client PATH and DOCKER_CONFIG only, never HOME or a credential", () => {
    const bin = makeTempDir("omf-bin-");
    const out = join(makeTempDir("omf-out-"), "env.txt");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\n/usr/bin/env > '${out}'\necho 29.0.0\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const runtime = createDockerRuntimeSync({
      context: CONTEXT,
      env: { PATH: bin, HOME: "/home/someone", OMF_HOME: "/elsewhere", ANTHROPIC_API_KEY: "k" },
    });
    expect(runtime.infoSync()).toEqual({ ok: true, server_version: "29.0.0" });
    const text = readFileSync(out, "utf8");
    const names = text.split("\n").map((line) => line.split("=")[0]);
    expect(text).toContain("DOCKER_CONFIG=/home/someone/.docker");
    for (const name of ["HOME", "OMF_HOME", "ANTHROPIC_API_KEY"]) expect(names).not.toContain(name);
  });
});
