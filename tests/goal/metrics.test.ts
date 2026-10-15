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

const metric = {
  metric_id: "m-p95-latency",
  command: ["sh", "bench.sh"],
  unit: "ms",
  watched_paths: ["bench/**"],
  image: null,
};

/** A valid lock of `metric` with the given image, for the schema tests. */
const lockOf = (image: string | null) => ({
  schema_version: 1 as const,
  goal_id: "g-a",
  ...metric,
  image,
  owner: "human:dev",
  approved_by: "human:dev",
  approved_at: "2026-10-12T00:00:00.000Z",
  sha256: metricSha256({ ...metric, image }),
  regime: 1,
});

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
    expect(() => proposeMetric(ledger, dir, { ...metric, command: [] }, "human:dev")).toThrow(
      /invalid metric proposal/,
    );
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

  it("finds the last locked hash of a goal's metric in the asked regime only", () => {
    const ledger = new Ledger(makeTempDir());
    const lock = (goal: string, sha: string, regime: number): void => {
      ledger.append({
        actor: "human:dev",
        type: "metric.locked",
        payload: { goal_id: goal, metric_id: "m-x", sha256: sha, regime },
      });
    };
    lock("g-a", "a".repeat(64), 1);
    lock("g-b", "b".repeat(64), 1);
    lock("g-a", "c".repeat(64), 2);
    // A retry of an approval that crashed after writing this lock: the last event of the regime wins.
    lock("g-a", "d".repeat(64), 2);
    const events = ledger.readVerified();
    expect(lockedSha256(events, "g-a", "m-x", 1)).toBe("a".repeat(64));
    expect(lockedSha256(events, "g-a", "m-x", 2)).toBe("d".repeat(64));
    expect(lockedSha256(events, "g-a", "m-x", 3)).toBeNull();
    expect(lockedSha256(events, "g-a", "m-y", 1)).toBeNull();
    expect(lockedSha256(events, "g-b", "m-x", 1)).toBe("b".repeat(64));
  });
});

describe("image references", () => {
  // The image becomes one argv element of `docker run`, so a leading "-" is an option and whitespace is not a reference.
  it.each(["-v", "--privileged", "a b", "a\tb", ""])(
    "rejects the image %j in a proposal, in a lock and on read",
    (image) => {
      const dir = makeTempDir();
      const ledger = new Ledger(dir);
      expect(() => proposeMetric(ledger, dir, { ...metric, image }, "human:dev")).toThrow(/invalid metric proposal/);
      expect(() => writeLock(dir, lockOf(image))).toThrow(/invalid metric lock/);
      expect(readProposal(dir, metric.metric_id)).toBeNull();
      expect(readLock(dir, "g-a", metric.metric_id)).toBeNull();
      expect(ledger.readVerified()).toEqual([]);

      // A file edited by hand is refused when it is read, not only when it is written.
      const proposal = proposeMetric(ledger, dir, metric, "human:dev");
      writeFileSync(proposalFile(dir, metric.metric_id), JSON.stringify({ ...proposal, image }));
      expect(() => readProposal(dir, metric.metric_id)).toThrow(/proposal for m-p95-latency is invalid/);
      writeLock(dir, lockOf(null));
      writeFileSync(lockFile(dir, "g-a", metric.metric_id), JSON.stringify({ ...lockOf(null), image }));
      expect(() => readLock(dir, "g-a", metric.metric_id)).toThrow(/lock for m-p95-latency is invalid/);
    },
  );

  it.each(["node:22", `node@sha256:${"a".repeat(64)}`, "ghcr.io/acme/bench:1.2"])("accepts the image %s", (image) => {
    const dir = makeTempDir();
    const proposal = proposeMetric(new Ledger(dir), dir, { ...metric, image }, "human:dev");
    expect(readProposal(dir, metric.metric_id)).toEqual(proposal);
    writeLock(dir, lockOf(image));
    expect(readLock(dir, "g-a", metric.metric_id)?.image).toBe(image);
  });
});
