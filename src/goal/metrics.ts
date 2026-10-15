import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import type { Ledger, LedgerEvent } from "../core/ledger.js";
import { writePrivateFile } from "../core/private-fs.js";
import { validate } from "../core/schema.js";
import { METRIC_ID_PATTERN } from "./goal-file.js";

/** What is measured. The lock hash covers exactly these fields (spec §4.2). */
export interface MetricDefinition {
  metric_id: string;
  command: string[];
  unit: string;
  watched_paths: string[];
  image: string | null;
}

export interface MetricProposal extends MetricDefinition {
  schema_version: 1;
  owner: string;
  proposed_at: string;
}

export interface MetricLock extends MetricDefinition {
  schema_version: 1;
  goal_id: string;
  owner: string;
  approved_by: string;
  approved_at: string;
  sha256: string;
  regime: number;
}

export class MetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricError";
  }
}

export function proposalFile(projectDir: string, metricId: string): string {
  return join(projectDir, "vault", "metrics", "proposed", `${metricId}.json`);
}

export function lockFile(projectDir: string, goalId: string, metricId: string): string {
  return join(projectDir, "vault", "metrics", goalId, `${metricId}.lock.json`);
}

export function definitionOf(metric: MetricDefinition): MetricDefinition {
  const { metric_id, command, unit, watched_paths, image } = metric;
  return { metric_id, command, unit, watched_paths, image };
}

/** Hash of what is measured, not of who proposed or approved it, or when. */
export function metricSha256(metric: MetricDefinition): string {
  return sha256Hex(canonicalize(definitionOf(metric)));
}

function readJson<T>(path: string, schema: string, what: string): T | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MetricError(`${what} is not valid JSON: ${path}`);
  }
  const check = validate(schema, data);
  if (!check.ok) throw new MetricError(`${what} is invalid (${check.errors}): ${path}`);
  return data as T;
}

export function readProposal(projectDir: string, metricId: string): MetricProposal | null {
  return readJson<MetricProposal>(
    proposalFile(projectDir, metricId),
    "metric-proposal.schema.json",
    `proposal for ${metricId}`,
  );
}

export function readLock(projectDir: string, goalId: string, metricId: string): MetricLock | null {
  return readJson<MetricLock>(
    lockFile(projectDir, goalId, metricId),
    "metric-lock.schema.json",
    `lock for ${metricId}`,
  );
}

export function writeLock(projectDir: string, lock: MetricLock): void {
  const check = validate("metric-lock.schema.json", lock);
  if (!check.ok) throw new MetricError(`invalid metric lock: ${check.errors}`);
  writePrivateFile(lockFile(projectDir, lock.goal_id, lock.metric_id), `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * A person proposes a metric (agent-drafted metrics come later, spec §4.2). It stays a proposal until a
 * goal that uses it is approved (J1). The file is written inside the ledger lock after the chain verifies,
 * so a broken chain leaves no proposal behind. It is written before the event is prepared; the event is built
 * from the validated proposal, so the ledger does not reject it. If the append itself fails, the file stays
 * without its event, and proposing again overwrites it.
 */
export function proposeMetric(
  ledger: Ledger,
  projectDir: string,
  metric: MetricDefinition,
  owner: string,
  now: Date = new Date(),
): MetricProposal {
  if (!METRIC_ID_PATTERN.test(metric.metric_id)) {
    throw new MetricError(`invalid metric id ${metric.metric_id}: use m-<lowercase-words>`);
  }
  if (!owner.startsWith("human:")) throw new MetricError(`only a person proposes a metric in v0.1; actor was ${owner}`);
  const proposal: MetricProposal = {
    schema_version: 1,
    ...definitionOf(metric),
    owner,
    proposed_at: now.toISOString(),
  };
  const check = validate("metric-proposal.schema.json", proposal);
  if (!check.ok) throw new MetricError(`invalid metric proposal: ${check.errors}`);
  ledger.appendWith(() => {
    writePrivateFile(proposalFile(projectDir, metric.metric_id), `${JSON.stringify(proposal, null, 2)}\n`);
    return {
      actor: owner,
      type: "metric.proposed",
      payload: { metric_id: metric.metric_id, sha256: metricSha256(proposal) },
    };
  });
  return proposal;
}

/**
 * The sha256 the ledger last recorded for this goal's metric lock in `regime`, or null. Only events of that
 * regime count: an event of a regime that was never approved (a crashed re-approval) must not vouch for
 * or against the approved lock, and an older regime's hash must not vouch for a newer lock (spec §4.2).
 * Within one regime the last event wins, because a retried approval writes the same regime again.
 */
export function lockedSha256(
  events: readonly LedgerEvent[],
  goalId: string,
  metricId: string,
  regime: number,
): string | null {
  let sha: string | null = null;
  for (const event of events) {
    if (event.type !== "metric.locked" || event.payload.goal_id !== goalId || event.payload.metric_id !== metricId)
      continue;
    if (event.payload.regime !== regime) continue;
    if (typeof event.payload.sha256 === "string") sha = event.payload.sha256;
  }
  return sha;
}
