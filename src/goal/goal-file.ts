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
  return Object.fromEntries(SEMANTIC_FIELDS.map((field) => [field, source[field]])) as GoalSemantic;
}

/** The hash J1 locks: canonical JSON of the semantic fields only. */
export function semanticHash(source: GoalSemantic): string {
  return sha256Hex(canonicalize(semanticOf(source)));
}

/** Every metric the goal refers to, target first, without duplicates. */
export function referencedMetrics(source: GoalSemantic): string[] {
  return [...new Set([source.target.metric_id, ...source.leading, ...source.lagging, ...source.guardrails])];
}

/** The placeholder text `omf goal new` writes. `placeholdersIn` looks for exactly these, so keep them in step with the template. */
export const PLACEHOLDER_METRIC_ID = "m-replace-me";
export const PLACEHOLDER_TITLE = "Say what this goal is in a few words";
export const PLACEHOLDER_OBJECTIVE = "The outcome you want, in plain words";
export const PLACEHOLDER_LINK_HYPOTHESIS = "Why moving the leading metrics should move the lagging ones";
export const PLACEHOLDER_APPROACH_MARKER = "Replace this line";

export function goalTemplate(goalId: string): string {
  return `---
# The fields between the two --- lines are what you approve (J1) and OMF locks, except title and objective.
# A model sees only objective and the text under "## Approach" below, so write those in words:
# no numbers, no thresholds and no metric ids, or the goal cannot be used.
# Lines starting with # are notes for you and are not read.
schema_version: 1
goal_id: ${goalId}
# Free text, not locked, not shown to a model.
title: "${PLACEHOLDER_TITLE}"
# The mode line: build works toward the target; watch keeps an already-good metric from slipping.
mode: build
# The kind line: default is an ordinary goal; migration is a goal that moves from one implementation to another.
kind: default
objective: "${PLACEHOLDER_OBJECTIVE}"
target:
  # Placeholder: replace with the id of your own metric (m-<lowercase-words>), here and in lagging below.
  # You then define how it is measured with omf metric propose.
  metric_id: ${PLACEHOLDER_METRIC_ID}
  operator: "<="
  # Placeholder: 0 is only a default. Set the number you want to reach.
  value: 0
  # Placeholder: must match the unit you give omf metric propose (for example ms, warnings, tests).
  unit: ms
# leading, lagging, guardrails are lists of metric ids: leading moves first, lagging shows the result, guardrails must not get worse.
leading: []
lagging: [${PLACEHOLDER_METRIC_ID}]
link_hypothesis: "${PLACEHOLDER_LINK_HYPOTHESIS}"
guardrails: []
prereg:
  # How long to keep observing before the goal can be judged (for example 7d).
  min_observation: 7d
  decision_rule: "target met for 2 consecutive measurements and no guardrail breach"
  # metrics_judged: how many metrics the decision rule judges (1 is right for a single target).
  metrics_judged: 1
budget:
  rounds: 10
  wall_time: 72h
  max_open_work_items: 2
# state_source: where work items are kept. markdown is the only choice today; leave it.
state_source: markdown
---
## Approach

### Why

${PLACEHOLDER_APPROACH_MARKER} with the reason this goal matters.

### Constraints

${PLACEHOLDER_APPROACH_MARKER} with what must not change and what is out of scope.

### Done when

${PLACEHOLDER_APPROACH_MARKER} with what you could observe in the product when the goal is reached.
`;
}

/**
 * Template placeholders still present in a goal. Each entry says what to replace. Advisory: this only reads
 * text and never decides whether a goal may be approved.
 */
export function placeholdersIn(doc: GoalDoc): string[] {
  const found: string[] = [];
  const { front, body } = doc;
  if (referencedMetrics(front).includes(PLACEHOLDER_METRIC_ID)) {
    found.push(
      `metric id ${PLACEHOLDER_METRIC_ID} is a placeholder: use your own metric id in target and lagging, and set target.unit to its unit`,
    );
  }
  if (front.target.unit === "ms" && front.target.value === 0) {
    found.push(
      "target unit ms and value 0 are template defaults: set the value you want to reach and the unit your metric uses",
    );
  }
  if (front.title === PLACEHOLDER_TITLE) found.push("title is still the template text: say what the goal is");
  if (front.objective === PLACEHOLDER_OBJECTIVE) {
    found.push("objective is still the template text: describe the outcome in plain words");
  }
  if (front.link_hypothesis === PLACEHOLDER_LINK_HYPOTHESIS) {
    found.push("link_hypothesis is still the template text: say why the leading metrics move the lagging ones");
  }
  if (body.includes(PLACEHOLDER_APPROACH_MARKER)) {
    found.push("## Approach still has template lines: fill in Why, Constraints and Done when");
  }
  return found;
}

/** Writes a new goal.md in host state (v0.1 keeps goals out of the repository). Refuses to overwrite. */
export function createGoal(projectDir: string, goalId: string): string {
  assertGoalId(goalId);
  const file = goalFile(projectDir, goalId);
  if (existsSync(file)) throw new GoalFileError(`goal ${goalId} already exists: ${file}`);
  writePrivateFile(file, goalTemplate(goalId), "wx");
  return file;
}
