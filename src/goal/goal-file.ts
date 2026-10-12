import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { writePrivateFile } from "../core/private-fs.js";
import { validate } from "../core/schema.js";

export const GOAL_ID_PATTERN = /^g-[a-z0-9]+(-[a-z0-9]+)*$/;
export const METRIC_ID_PATTERN = /^m-[a-z0-9]+(-[a-z0-9]+)*$/;

export type Operator = "<=" | ">=" | "==";

export interface GoalTarget {
  metric_id: string;
  operator: Operator;
  value: number;
  unit: string;
}

/** The front matter of goal.md (spec §4.1), as validated by schemas/goal.schema.json. */
export interface GoalFront {
  schema_version: 1;
  goal_id: string;
  title: string;
  mode: "build" | "watch";
  kind: "default" | "migration";
  objective: string;
  target: GoalTarget;
  leading: string[];
  lagging: string[];
  link_hypothesis: string;
  guardrails: string[];
  prereg: { min_observation: string; decision_rule: string; metrics_judged: number };
  budget: { rounds: number; wall_time: string; max_open_work_items: number };
  state_source: "markdown";
}

export interface GoalDoc {
  front: GoalFront;
  body: string;
}

/** The fields J1 locks (spec §4.1). Title, objective and the approach text are not locked. */
export const SEMANTIC_FIELDS = [
  "target",
  "leading",
  "lagging",
  "link_hypothesis",
  "guardrails",
  "prereg",
  "mode",
  "budget",
] as const;

export type GoalSemantic = Pick<GoalFront, (typeof SEMANTIC_FIELDS)[number]>;

export class GoalFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalFileError";
  }
}

export function goalDir(projectDir: string, goalId: string): string {
  return join(projectDir, "goals", goalId);
}

export function goalFile(projectDir: string, goalId: string): string {
  return join(goalDir(projectDir, goalId), "goal.md");
}

export function assertGoalId(goalId: string): void {
  if (!GOAL_ID_PATTERN.test(goalId)) throw new GoalFileError(`invalid goal id ${goalId}: use g-<lowercase-words>`);
}

/** Splits `---\n<yaml>\n---\n<body>` and validates the front matter against goal.schema.json. */
export function parseGoal(text: string): GoalDoc {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (match === null) throw new GoalFileError("goal.md must start with a --- front matter block");
  let front: unknown;
  try {
    front = parse(match[1] ?? "");
  } catch (err) {
    throw new GoalFileError(`goal.md front matter is not valid YAML: ${(err as Error).message}`);
  }
  const check = validate("goal.schema.json", front);
  if (!check.ok) throw new GoalFileError(`goal.md front matter is invalid: ${check.errors}`);
  return { front: front as GoalFront, body: match[2] ?? "" };
}

export function readGoal(projectDir: string, goalId: string): GoalDoc {
  assertGoalId(goalId);
  const file = goalFile(projectDir, goalId);
  if (!existsSync(file)) throw new GoalFileError(`goal ${goalId} not found; run omf goal new ${goalId}`);
  const doc = parseGoal(readFileSync(file, "utf8"));
  if (doc.front.goal_id !== goalId) {
    throw new GoalFileError(`goal.md declares goal_id ${doc.front.goal_id}, expected ${goalId}`);
  }
  return doc;
}

export function semanticOf(source: GoalSemantic): GoalSemantic {
  const { target, leading, lagging, link_hypothesis, guardrails, prereg, mode, budget } = source;
  return { target, leading, lagging, link_hypothesis, guardrails, prereg, mode, budget };
}

/** The hash J1 locks: canonical JSON of the semantic fields only. */
export function semanticHash(source: GoalSemantic): string {
  return sha256Hex(canonicalize(semanticOf(source)));
}

/** Every metric the goal refers to, target first, without duplicates. */
export function referencedMetrics(source: GoalSemantic): string[] {
  return [...new Set([source.target.metric_id, ...source.leading, ...source.lagging, ...source.guardrails])];
}

export function goalTemplate(goalId: string): string {
  return `---
schema_version: 1
goal_id: ${goalId}
title: "Say what this goal is in a few words"
mode: build
kind: default
objective: "The outcome you want, in plain words"
target:
  metric_id: m-replace-me
  operator: "<="
  value: 0
  unit: ms
leading: []
lagging: [m-replace-me]
link_hypothesis: "Why moving the leading metrics should move the lagging ones"
guardrails: []
prereg:
  min_observation: 7d
  decision_rule: "target met for 2 consecutive measurements and no guardrail breach"
  metrics_judged: 1
budget:
  rounds: 10
  wall_time: 72h
  max_open_work_items: 2
state_source: markdown
---
## Approach

How the work should move the metric, and what is out of scope.
`;
}

/** Writes a new goal.md in host state (v0.1 keeps goals out of the repository). Refuses to overwrite. */
export function createGoal(projectDir: string, goalId: string): string {
  assertGoalId(goalId);
  const file = goalFile(projectDir, goalId);
  if (existsSync(file)) throw new GoalFileError(`goal ${goalId} already exists: ${file}`);
  writePrivateFile(file, goalTemplate(goalId), "wx");
  return file;
}
