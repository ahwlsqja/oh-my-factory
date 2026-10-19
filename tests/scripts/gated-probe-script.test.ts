import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTAINER_PROBE_ARGV, parseProbe } from "../../src/container/measure.js";
import { makeTempDir } from "../helpers/tmp.js";

// The real probe script, run by a local shell against a planted home and PATH instead of a container: it must name each
// vendor binary and each credential path it is written to look for, and say nothing about a clean one. Only the pieces a host
// can stage are covered here (the home directory and the programs on PATH); /root and the Docker socket are fixed paths that
// only a container can show, which is what the gated author-boundary suite is for.

const run = (home: string, bin: string) => {
  const [, ...args] = CONTAINER_PROBE_ARGV;
  // An absolute shell: the child's PATH holds only the planted programs.
  const result = spawnSync("/bin/sh", args, { env: { HOME: home, PATH: bin }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

describe("the container probe script", () => {
  it("names every vendor binary and credential path it looks for, as lines the parser reads back", () => {
    const home = makeTempDir("omf-probe-home-");
    const bin = makeTempDir("omf-probe-bin-");
    const vendors = ["claude", "codex", "docker", "gh", "aws", "gcloud", "az", "kubectl"];
    for (const name of vendors) {
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
    }
    const credentials = [
      ".claude",
      ".claude.json",
      ".codex",
      ".aws",
      ".ssh",
      ".netrc",
      ".config/gh",
      ".docker/config.json",
    ];
    for (const path of credentials) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), "x");
    }
    const checks = parseProbe(run(home, bin));
    expect(checks.vendor_binaries).toEqual([...vendors].sort());
    expect(checks.credential_paths).toEqual([...credentials].sort());
  });

  it("names exactly the one vendor binary or credential that is present, for each of them", () => {
    const vendors = ["claude", "codex", "docker", "gh", "aws", "gcloud", "az", "kubectl"];
    for (const name of vendors) {
      const bin = makeTempDir("omf-probe-bin-");
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
      expect(parseProbe(run(makeTempDir("omf-probe-home-"), bin)).vendor_binaries, name).toEqual([name]);
    }
    for (const path of [
      ".claude",
      ".claude.json",
      ".codex",
      ".aws",
      ".ssh",
      ".netrc",
      ".config/gh",
      ".docker/config.json",
    ]) {
      const home = makeTempDir("omf-probe-home-");
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), "x");
      expect(parseProbe(run(home, makeTempDir("omf-probe-bin-"))).credential_paths, path).toEqual([path]);
    }
  });

  it("says nothing about a clean home and an empty PATH, and always ends with a socket line and end", () => {
    const out = run(makeTempDir("omf-probe-home-"), makeTempDir("omf-probe-bin-"));
    const lines = out.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("end");
    expect(lines.at(-2)).toMatch(/^socket:[01]$/);
    expect(lines.filter((line) => line.startsWith("vendor:") || line.startsWith("cred:"))).toEqual([]);
  });
});
