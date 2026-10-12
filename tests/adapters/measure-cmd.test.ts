import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dockerArgs,
  isolationOf,
  parseMeasurement,
  runInDocker,
  runMeasurement,
  runOnHost,
} from "../../src/adapters/measure-cmd.js";
import { makeTempDir } from "../helpers/tmp.js";

describe("parseMeasurement", () => {
  it("takes the last non-empty stdout line as the value", () => {
    expect(parseMeasurement("42\n")).toEqual({ ok: true, value: 42 });
    expect(parseMeasurement("warming up\n12.5\n\n")).toEqual({ ok: true, value: 12.5 });
    expect(parseMeasurement("1e3")).toEqual({ ok: true, value: 1000 });
    expect(parseMeasurement("-3")).toEqual({ ok: true, value: -3 });
  });

  it("fails on empty output or a non-number (empty means fail)", () => {
    expect(parseMeasurement("")).toEqual({ ok: false, reason: "the command printed nothing" });
    expect(parseMeasurement("n/a\n")).toEqual({ ok: false, reason: "the last line of stdout is not a number" });
    expect(parseMeasurement("0x10")).toEqual({ ok: false, reason: "the last line of stdout is not a number" });
  });
});

describe("runOnHost", () => {
  const env = { PATH: process.env.PATH, HOME: "/caller/home", OMF_SECRET: "s3cret" };

  it("runs the command in the repository and returns its value", () => {
    const repo = makeTempDir();
    writeFileSync(join(repo, "marker"), "");
    expect(runOnHost(["sh", "-c", "test -f marker && echo 7"], repo, env)).toEqual({ ok: true, value: 7 });
  });

  it("reports a non-zero exit", () => {
    expect(runOnHost(["sh", "-c", "echo 1; exit 3"], makeTempDir(), env)).toEqual({ ok: false, reason: "exit code 3" });
  });

  it("does not pass the caller's environment or home", () => {
    const script = 'if [ -z "$OMF_SECRET" ] && [ "$HOME" != "/caller/home" ]; then echo 1; else echo 0; fi';
    expect(runOnHost(["sh", "-c", script], makeTempDir(), env)).toEqual({ ok: true, value: 1 });
  });

  it("times out", () => {
    expect(runOnHost(["sh", "-c", "sleep 5"], makeTempDir(), env, 200)).toEqual({ ok: false, reason: "timed out" });
  });
});

describe("docker runner", () => {
  it("builds a disposable, network-less, read-only container", () => {
    const args = dockerArgs(["sh", "bench.sh"], "/repo", "alpine:3.20", "omf-measure-1");
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--name", "omf-measure-1"]);
    expect(args).toContain("--read-only");
    expect(args.join(" ")).toContain("--network none");
    expect(args.join(" ")).toContain("--volume /repo:/work:ro");
    expect(args.slice(-3)).toEqual(["alpine:3.20", "sh", "bench.sh"]);
    expect(isolationOf("docker")).toBe("container");
    expect(isolationOf("host")).toBe("none");
  });

  it("needs an image", () => {
    const metric = { metric_id: "m-x", command: ["sh", "x.sh"], unit: "ms", watched_paths: [], image: null };
    expect(runMeasurement(metric, makeTempDir(), "docker")).toEqual({
      ok: false,
      reason: "metric m-x has no image; propose it with --image or measure with --runner host",
    });
  });

  it.skipIf(process.env.OMF_TEST_DOCKER !== "1")("runs in Docker when OMF_TEST_DOCKER=1", () => {
    expect(runInDocker(["sh", "-c", "echo 9"], makeTempDir(), "alpine:3.20")).toEqual({ ok: true, value: 9 });
  });
});
