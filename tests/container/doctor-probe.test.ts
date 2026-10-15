import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerRuntimeSync } from "../../src/container/docker-sync.js";
import { containerIsolationProbe } from "../../src/container/doctor-probe.js";
import type { ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import { parseConfig } from "../../src/core/config.js";
import { type ProbeProject, runDoctor } from "../../src/core/doctor.js";
import { Ledger } from "../../src/core/ledger.js";
import { locateProject, projectDir } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { DEVIATIONS, type InspectDoc, RUN, goldenInspectDoc } from "../helpers/measure-fixture.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const JUDGE_TOML = `[judge]
docker_context = "colima-omf-m3f"
sut_base_image = "registry.example/omf-base@sha256:${"a".repeat(64)}"
`;
const TOOLS = {
  git: { found: true, version: "git" },
  docker: { found: true, version: "docker", daemon: true },
  claude: { found: false, version: null },
  codex: { found: false, version: null },
};
const IMAGE: ImageInfo = { id: `sha256:${"b".repeat(64)}` as ImageId, env_names: ["PATH"], user: "", volumes: [] };

function projectOf(toml: string): { project: ProbeProject; env: NodeJS.ProcessEnv } {
  const home = makeTempDir("omf-home-");
  const env = { HOME: home, OMF_HOME: join(home, ".omf") };
  return { project: { location: locateProject(makeGitRepo(), env), config: parseConfig(toml) }, env };
}

interface StubOptions {
  info?: ReturnType<ContainerRuntimeSync["infoSync"]>;
  endpoint?: ReturnType<ContainerRuntimeSync["endpointSync"]>;
  image?: ImageInfo | null;
  edit?: (doc: InspectDoc) => void;
  probe?: string;
}

/** A daemon in memory behind the sync port. `log` is the call order; the port has no pull to call. */
function stub(options: StubOptions = {}): { runtime: ContainerRuntimeSync; log: string[] } {
  const log: string[] = [];
  const runtime: ContainerRuntimeSync = {
    context: "colima-omf-m3f",
    infoSync() {
      log.push("info");
      return options.info ?? { ok: true, server_version: "29.0.0" };
    },
    endpointSync() {
      log.push("endpoint");
      return options.endpoint ?? { kind: "unix", local: true };
    },
    imageInfoSync() {
      log.push("image");
      return options.image === undefined ? IMAGE : options.image;
    },
    createSync(spec) {
      log.push(`create:${spec.name}`);
      return { name: spec.name, id: "c0ffee0123456789", role: spec.labels.role };
    },
    inspectSync(handle) {
      log.push("inspect");
      const doc = goldenInspectDoc(handle.role);
      options.edit?.(doc);
      return [doc];
    },
    startSync() {
      log.push("start");
    },
    execSync() {
      log.push("exec");
      return { kind: "exited", status: 0, signal: null, stdout: options.probe ?? "socket:0\nend\n", stderr: "" };
    },
    removeSync() {
      log.push("remove");
    },
  };
  return { runtime, log };
}

describe("containerIsolationProbe: what it cannot measure", () => {
  it("says why, touches no runtime for a missing project or setting, and never pulls or creates otherwise", () => {
    const { project, env } = projectOf("");
    const s = stub();
    const probe = containerIsolationProbe({ runtime: s.runtime });
    const none = probe(env, TOOLS, null);
    expect(none).toMatchObject({ measured: "unmeasurable", advisory: true, failure: null });
    expect(none.note).toContain("not initialized");
    expect(none.note).toContain("not enforced");
    expect(probe(env, TOOLS, project).note).toContain("judge.docker_context is not set");
    const noImage = projectOf('[judge]\ndocker_context = "colima-omf-m3f"\n');
    expect(probe(noImage.env, TOOLS, noImage.project).note).toContain("judge.sut_base_image is not set");
    expect(s.log).toEqual([]);

    const { project: configured, env: e } = projectOf(JUDGE_TOML);
    const text = "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?";
    const down = stub({ info: { ok: false, failure: text } });
    expect(containerIsolationProbe({ runtime: down.runtime })(e, TOOLS, configured)).toMatchObject({
      measured: "unmeasurable",
      failure: text,
    });
    const remote = stub({ endpoint: { kind: "tcp", local: false } });
    expect(containerIsolationProbe({ runtime: remote.runtime })(e, TOOLS, configured).note).toContain("kind: tcp");
    const absent = stub({ image: null });
    expect(containerIsolationProbe({ runtime: absent.runtime })(e, TOOLS, configured).note).toContain("never pulls");
    for (const other of [down, remote, absent])
      expect(other.log.some((entry) => entry.startsWith("create"))).toBe(false);
  });
});

describe("containerIsolationProbe: what it measures", () => {
  it("measures a throwaway golden container L2, advisory, with a fresh run id, and removes it", () => {
    const { project, env } = projectOf(JUDGE_TOML);
    const named = stub();
    const result = containerIsolationProbe({ runtime: named.runtime, runId: () => RUN })(env, TOOLS, project);
    expect(result).toMatchObject({ declared: "L2", measured: "L2", advisory: true, failure: null });
    for (const part of ["a throwaway-container probe, not a run", "endpoint: unix", "not enforced"])
      expect(result.note).toContain(part);
    expect(named.log).toEqual([
      "info",
      "endpoint",
      "image",
      `create:omf-sut-${RUN}-0-1`,
      "inspect",
      "start",
      "exec",
      "remove",
    ]);
    const fresh = stub();
    containerIsolationProbe({ runtime: fresh.runtime })(env, TOOLS, project);
    expect(fresh.log.find((entry) => entry.startsWith("create"))).toMatch(
      /^create:omf-sut-r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}-0-1$/,
    );
  });

  it("reports L1 for a deviating container, which never starts, and still removes it", () => {
    const { project, env } = projectOf(JUDGE_TOML);
    const privileged = DEVIATIONS.find((d) => d.name === "privileged mode");
    if (privileged === undefined) throw new Error("the privileged deviation exists");
    const s = stub({ edit: privileged.edit });
    const result = containerIsolationProbe({ runtime: s.runtime })(env, TOOLS, project);
    expect(result).toMatchObject({ measured: "L1", advisory: true });
    expect(result.note).toContain("privileged");
    expect(s.log).not.toContain("start");
    expect(s.log.at(-1)).toBe("remove");
  });

  it("removes the container when the probe fails and lets the doctor report unmeasurable", () => {
    const { project, env } = projectOf(JUDGE_TOML);
    const s = stub({ probe: "no end line\n" });
    expect(() => containerIsolationProbe({ runtime: s.runtime })(env, TOOLS, project)).toThrow("probe_malformed");
    expect(s.log.at(-1)).toBe("remove");
  });
});

describe("omf doctor with the probe", () => {
  it("records nothing: no ledger event, no isolation.json, preflight.json is the only new file", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const env = { HOME: home, OMF_HOME: join(home, ".omf"), PATH: process.env.PATH ?? "" };
    initProject(repo, env);
    const dir = projectDir(repo, env);
    appendFileSync(join(dir, "config.toml"), `\n${JUDGE_TOML}`);
    const tree = (): string[] => readdirSync(dir, { recursive: true }).map(String).sort();
    const before = tree();
    const events = new Ledger(dir).readVerified().length;
    const report = runDoctor(repo, env, undefined, containerIsolationProbe({ runtime: stub().runtime }));
    expect(report.isolation).toMatchObject({ measured: "L2", advisory: true });
    expect(new Ledger(dir).readVerified()).toHaveLength(events);
    expect(tree().filter((path) => !before.includes(path))).toEqual(["preflight.json"]);
  });
});
