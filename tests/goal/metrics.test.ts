import { readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ledger, LedgerCorruptError } from "../../src/core/ledger.js";
import {
  MetricError,
  lockFile,
  lockedSha256,
  metricSha256,
  proposalFile,
  proposeMetric,
  readLock,
  readProposal,
  writeLock,
} from "../../src/goal/metrics.js";
import { makeTempDir } from "../helpers/tmp.js";

const metric = { metric_id: "m-p95-latency", command: ["sh", "bench.sh"], unit: "ms", watched_paths: ["bench/**"], image: null };

describe("metric proposals and locks", () => {
  it("records a proposal privately and in the ledger", () => {
    const dir = makeTempDir();
    const ledger = new Ledger(dir);
    const proposal = proposeMetric(ledger, dir, metric, "human:dev", new Date("2026-10-12T00:00:00Z"));
    expect(readProposal(dir, "m-p95-latency")).toEqual(proposal);
    expect((statSync(proposalFile(dir, "m-p95-latency")).mode & 0o777).toString(8)).toBe("600");
    expect(ledger.readVerified()[0]).toMatchObject({
      actor: "human:dev",
      type: "metric.proposed",
      payload: { metric_id: "m-p95-latency", sha256: metricSha256(metric) },
    });
    writeFileSync(proposalFile(dir, "m-p95-latency"), JSON.stringify({ ...proposal, owner: "agent:claude" }));
    expect(() => readProposal(dir, "m-p95-latency")).toThrow(/proposal for m-p95-latency is invalid/);
  });

  it("leaves no proposal behind when the ledger chain is broken", () => {
    const dir = makeTempDir();
    const ledger = new Ledger(dir);
    ledger.append({ actor: "human:dev", type: "metric.locked", payload: { goal_id: "g-a" } });
    writeFileSync(ledger.file, readFileSync(ledger.file, "utf8").replace('"g-a"', '"g-b"'));
    expect(() => proposeMetric(ledger, dir, metric, "human:dev")).toThrow(LedgerCorruptError);
    expect(readProposal(dir, "m-p95-latency")).toBeNull();
  });

  it("refuses agents, bad ids and invalid proposals, and writes nothing", () => {
    const dir = makeTempDir();
    const ledger = new Ledger(dir);
    expect(() => proposeMetric(ledger, dir, metric, "agent:claude")).toThrow(/only a person/);
    expect(() => proposeMetric(ledger, dir, { ...metric, metric_id: "latency" }, "human:dev")).toThrow(MetricError);
    expect(() => proposeMetric(ledger, dir, { ...metric, command: [] }, "human:dev")).toThrow(/invalid metric proposal/);
    expect(readProposal(dir, "m-p95-latency")).toBeNull();
    expect(ledger.readVerified()).toEqual([]);
  });

  it("hashes the definition only", () => {
    const base = metricSha256(metric);
    expect(metricSha256({ ...metric, owner: "human:other", proposed_at: "x" } as typeof metric)).toBe(base);
    expect(metricSha256({ ...metric, command: ["sh", "other.sh"] })).not.toBe(base);
    expect(metricSha256({ ...metric, watched_paths: [] })).not.toBe(base);
  });

  it("reads locks and rejects malformed ones", () => {
    const dir = makeTempDir();
    expect(readLock(dir, "g-a", "m-p95-latency")).toBeNull();
    const lock = {
      schema_version: 1 as const,
      goal_id: "g-a",
      ...metric,
      owner: "human:dev",
      approved_by: "human:dev",
      approved_at: "2026-10-12T00:00:00.000Z",
      sha256: metricSha256(metric),
      regime: 1,
    };
    writeLock(dir, lock);
    expect(readLock(dir, "g-a", "m-p95-latency")).toEqual(lock);
    expect((statSync(lockFile(dir, "g-a", "m-p95-latency")).mode & 0o777).toString(8)).toBe("600");
    writeFileSync(lockFile(dir, "g-a", "m-p95-latency"), "{ not json");
    expect(() => readLock(dir, "g-a", "m-p95-latency")).toThrow(/not valid JSON/);
    writeFileSync(lockFile(dir, "g-a", "m-p95-latency"), JSON.stringify({ ...lock, sha256: "abc" }));
    expect(() => readLock(dir, "g-a", "m-p95-latency")).toThrow(/lock for m-p95-latency is invalid/);
    expect(() => writeLock(dir, { ...lock, goal_id: "g-b", regime: 0 })).toThrow(/invalid metric lock/);
    expect(readLock(dir, "g-b", "m-p95-latency")).toBeNull();
  });

  it("finds the last locked hash for a goal's metric", () => {
    const ledger = new Ledger(makeTempDir());
    const lock = (goal: string, sha: string, regime: number): void => {
      ledger.append({ actor: "human:dev", type: "metric.locked", payload: { goal_id: goal, metric_id: "m-x", sha256: sha, regime } });
    };
    lock("g-a", "a".repeat(64), 1);
    lock("g-b", "b".repeat(64), 1);
    lock("g-a", "c".repeat(64), 2);
    const events = ledger.readVerified();
    expect(lockedSha256(events, "g-a", "m-x")).toBe("c".repeat(64));
    expect(lockedSha256(events, "g-a", "m-y")).toBeNull();
  });
});
