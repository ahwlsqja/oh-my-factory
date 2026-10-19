import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNMEASURED_CODES,
  dockerArgs,
  isolationOf,
  parseMeasurement,
  runInDocker,
  runMeasurement,
  runOnHost,
} from "../../src/adapters/measure-cmd.js";
import { waitDead, waitForPids } from "../helpers/process.js";
import { makeTempDir } from "../helpers/tmp.js";

describe("parseMeasurement", () => {
  it("takes the last non-empty stdout line as the value", () => {
    expect(parseMeasurement("42\n")).toEqual({ ok: true, value: 42 });
    expect(parseMeasurement("warming up\n12.5\n\n")).toEqual({ ok: true, value: 12.5 });
    expect(parseMeasurement("1e3")).toEqual({ ok: true, value: 1000 });
    expect(parseMeasurement("-3")).toEqual({ ok: true, value: -3 });
  });

  it("fails on empty output or a non-number (empty means fail)", () => {
    expect(parseMeasurement("")).toEqual({ ok: false, code: "empty_output", reason: "the command printed nothing" });
    expect(parseMeasurement("n/a\n")).toEqual({
      ok: false,
      code: "unparsable_output",
      reason: "the last line of stdout is not a number",
    });
    expect(parseMeasurement("0x10")).toEqual({
      ok: false,
      code: "unparsable_output",
      reason: "the last line of stdout is not a number",
    });
  });

  it("fails on a value that is not finite, which the ledger cannot store", () => {
    expect(parseMeasurement("1e999")).toEqual({
      ok: false,
      code: "not_finite",
      reason: "the value is not a finite number",
    });
    expect(parseMeasurement("-1e999")).toEqual({
      ok: false,
      code: "not_finite",
      reason: "the value is not a finite number",
    });
  });
});

describe("runOnHost", () => {
  const env = { PATH: process.env.PATH, HOME: "/caller/home", OMF_SECRET: "s3cret" };

  it("runs the command in the repository and returns its value", async () => {
    const repo = makeTempDir();
    writeFileSync(join(repo, "marker"), "");
    expect(await runOnHost(["sh", "-c", "test -f marker && echo 7"], repo, env)).toEqual({ ok: true, value: 7 });
  });

  it("reports a non-zero exit", async () => {
    expect(await runOnHost(["sh", "-c", "echo 1; exit 3"], makeTempDir(), env)).toEqual({
      ok: false,
      code: "nonzero_exit",
      reason: "exit code 3",
    });
  });

  it("does not pass the caller's environment or home", async () => {
    const script = 'if [ -z "$OMF_SECRET" ] && [ "$HOME" != "/caller/home" ]; then echo 1; else echo 0; fi';
    expect(await runOnHost(["sh", "-c", script], makeTempDir(), env)).toEqual({ ok: true, value: 1 });
  });

  it("times out", async () => {
    expect(await runOnHost(["sh", "-c", "sleep 5"], makeTempDir(), env, 200)).toEqual({
      ok: false,
      code: "timeout",
      reason: "timed out",
    });
  });

  it("kills a background child left behind by a command that timed out", async () => {
    const pidFile = join(makeTempDir(), "pids");
    const script = 'sleep 20 & echo "$$ $!" > "$1"; wait';
    expect(await runOnHost(["sh", "-c", script, "sh", pidFile], makeTempDir(), env, 500)).toEqual({
      ok: false,
      code: "timeout",
      reason: "timed out",
    });
    const [, background] = await waitForPids(pidFile);
    expect(await waitDead(background as number)).toBe(true);
  });

  it("kills a background child left behind by a command that exited", async () => {
    const pidFile = join(makeTempDir(), "pids");
    const script = 'sleep 20 & echo "$$ $!" > "$1"; echo 4';
    expect(await runOnHost(["sh", "-c", script, "sh", pidFile], makeTempDir(), env, 5000)).toEqual({
      ok: true,
      value: 4,
    });
    const [, background] = await waitForPids(pidFile);
    expect(await waitDead(background as number)).toBe(true);
  });

  it("fails, instead of crashing, on output over the limit", async () => {
    const outcome = await runOnHost(["yes", "x"], makeTempDir(), env, 10_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/^output exceeded \d+ bytes$/);
  });

  it("fails on a program that does not exist", async () => {
    const outcome = await runOnHost(["omf-no-such-program-xyz"], makeTempDir(), env);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/^could not run: .*ENOENT/);
  });

  it("reports a command that prints nothing and exits zero as empty output, not zero", async () => {
    expect(await runOnHost(["sh", "-c", "true"], makeTempDir(), env)).toMatchObject({
      ok: false,
      code: "empty_output",
    });
    expect(await runOnHost(["sh", "-c", "echo; echo '  '"], makeTempDir(), env)).toMatchObject({
      ok: false,
      code: "empty_output",
    });
  });

  it("reports text that is not a number as unparsable, whatever the exit status", async () => {
    expect(await runOnHost(["sh", "-c", "echo ok"], makeTempDir(), env)).toMatchObject({
      ok: false,
      code: "unparsable_output",
    });
  });

  it("does not read a failing command's printed 0 as a measurement", async () => {
    expect(await runOnHost(["sh", "-c", "echo 0; exit 1"], makeTempDir(), env)).toMatchObject({
      ok: false,
      code: "nonzero_exit",
    });
  });

  it("reports a command killed by a signal", async () => {
    expect(await runOnHost(["sh", "-c", "kill -9 $$"], makeTempDir(), env)).toMatchObject({
      ok: false,
      code: "killed_by_signal",
    });
  });

  it("reports a command the shell may not execute as a permission failure", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "denied.sh"), "echo 0\n", { mode: 0o644 });
    expect(await runOnHost(["sh", "-c", "./denied.sh"], dir, env)).toMatchObject({
      ok: false,
      code: "permission_denied",
    });
    expect(await runOnHost([join(dir, "denied.sh")], dir, env)).toMatchObject({
      ok: false,
      code: "permission_denied",
    });
  });

  it("reports output over the limit with its own code", async () => {
    expect(await runOnHost(["yes", "0"], makeTempDir(), env, 10_000)).toMatchObject({
      ok: false,
      code: "output_limit",
    });
  });

  it("keeps every unmeasured code distinct", () => {
    expect(new Set(UNMEASURED_CODES).size).toBe(UNMEASURED_CODES.length);
  });

  it("fails on an empty command", async () => {
    expect(await runOnHost([], makeTempDir(), env)).toEqual({
      ok: false,
      code: "empty_command",
      reason: "empty command",
    });
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

  it("refuses an image that docker would read as an option or split into arguments", () => {
    for (const image of ["-x", "--privileged", "a b", "a\tb", ""]) {
      expect(() => dockerArgs(["sh", "bench.sh"], "/repo", image, "omf-measure-1")).toThrow(/invalid image/);
    }
    const pinned = `node@sha256:${"a".repeat(64)}`;
    expect(dockerArgs(["sh", "bench.sh"], "/repo", pinned, "omf-measure-1").slice(-3)).toEqual([
      pinned,
      "sh",
      "bench.sh",
    ]);
  });

  it("needs an image", async () => {
    const metric = { metric_id: "m-x", command: ["sh", "x.sh"], unit: "ms", watched_paths: [], image: null };
    expect(await runMeasurement(metric, makeTempDir(), "docker")).toEqual({
      ok: false,
      code: "no_image",
      reason: "metric m-x has no image; propose it with --image or measure with --runner host",
    });
  });

  it("removes the container by name when the docker client times out", async () => {
    const bin = makeTempDir();
    const log = join(makeTempDir(), "docker.log");
    const fake = join(bin, "docker");
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "rm" ]; then echo "$@" >> "$LOG"; exit 0; fi\nsleep 30\n');
    chmodSync(fake, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, LOG: log };
    expect(await runInDocker(["sh", "-c", "echo 1"], makeTempDir(), "alpine:3.20", env, 300)).toEqual({
      ok: false,
      code: "timeout",
      reason: "timed out",
    });
    expect(readFileSync(log, "utf8")).toMatch(/^rm --force omf-measure-[0-9a-f]{8}\n$/);
  });

  it.skipIf(process.env.OMF_TEST_DOCKER !== "1")("runs in Docker when OMF_TEST_DOCKER=1", async () => {
    expect(await runInDocker(["sh", "-c", "echo 9"], makeTempDir(), "alpine:3.20")).toEqual({ ok: true, value: 9 });
  });
});
