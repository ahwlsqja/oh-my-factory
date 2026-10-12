import { parse, stringify } from "yaml";
import { validate } from "../core/schema.js";
import type { WorkItemFront } from "./types.js";

export class WorkItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemError";
  }
}

/**
 * Keys that would carry a measured value, a target or a query (spec §4.6, E2). The G side never sees them,
 * so no work item and no candidate may hold them at any depth. Compared case-insensitively.
 */
export const FORBIDDEN_KEYS: readonly string[] = [
  "value",
  "threshold",
  "query",
  "target",
  "metric",
  "measured",
  "baseline",
  "sigma",
];

/**
 * Walks objects and arrays and returns the path of the first key (case-insensitive) in FORBIDDEN_KEYS, or null.
 * The schema already refuses unknown keys. This scan is the second layer: it holds even if a later schema
 * change loosened `additionalProperties`. The path names keys only, never a value.
 */
export function findForbiddenKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenKey(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, child] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) return here;
    const found = findForbiddenKey(child, here);
    if (found !== null) return found;
  }
  return null;
}

/** Schema validation first, then the deep key scan. The error names rules and key paths, never values. */
export function validateWorkItem(front: unknown): WorkItemFront {
  const check = validate("work-item.schema.json", front);
  if (!check.ok) throw new WorkItemError(`work item front matter is invalid: ${check.errors}`);
  const forbidden = findForbiddenKey(front);
  if (forbidden !== null) throw new WorkItemError(`work item front matter has a forbidden key at ${forbidden}`);
  return front as WorkItemFront;
}

const PROGRESS_OPEN = "<!-- omf:progress -->";
const PROGRESS_CLOSE = "<!-- /omf:progress -->";

/**
 * `item.md`: the validated front matter, then the region that the worker (M3) writes progress into.
 * The file is a projection: the ledger stays authoritative for approval, veto and cancel (D27).
 * `progress` is stored with a trailing newline unless it is empty.
 */
export function renderWorkItem(front: WorkItemFront, progress: string): string {
  validateWorkItem(front);
  if (progress.includes(PROGRESS_OPEN) || progress.includes(PROGRESS_CLOSE)) {
    throw new WorkItemError("progress text must not contain the progress markers");
  }
  const body = progress === "" || progress.endsWith("\n") ? progress : `${progress}\n`;
  return `---\n${stringify(front)}---\n${PROGRESS_OPEN}\n${body}${PROGRESS_CLOSE}\n`;
}

/** Splits `item.md` back into validated front matter and the progress text. */
export function parseWorkItem(text: string): { front: WorkItemFront; progress: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new WorkItemError("item.md must start with a --- front matter block");
  let front: unknown;
  try {
    front = parse(match[1] ?? "");
  } catch {
    throw new WorkItemError("item.md front matter is not valid YAML");
  }
  const rest = match[2] ?? "";
  if (!rest.startsWith(`${PROGRESS_OPEN}\n`) || !rest.endsWith(`${PROGRESS_CLOSE}\n`)) {
    throw new WorkItemError("item.md has no progress region");
  }
  const progress = rest.slice(PROGRESS_OPEN.length + 1, rest.length - PROGRESS_CLOSE.length - 1);
  return { front: validateWorkItem(front), progress };
}
