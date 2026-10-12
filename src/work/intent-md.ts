import { parse, stringify } from "yaml";
import type { IntentCandidate, IntentDoc } from "./types.js";
import { WorkItemError } from "./work-item.js";

export type { IntentDoc } from "./types.js";

/** The five Stage 1 sections of an intent document, in order (spec §5.1). */
export const INTENT_SECTIONS = [
  "Problem",
  "Proposed outcome",
  "Affected users and systems",
  "Constraints",
  "Open questions",
] as const;

/**
 * Model text must not be able to forge structure: a line that starts with `#` could open a section, a line that
 * equals `---` could end the front matter, and a line that starts with `\\` would be read as an escape.
 * Each such line gets one leading backslash. Every rendered line that starts with a backslash was escaped this way,
 * so removing exactly one backslash from it restores the text (render then parse is the identity).
 */
function escapeLine(line: string): string {
  return line.startsWith("\\") || line.startsWith("#") || line === "---" ? `\\${line}` : line;
}

function unescapeLine(line: string): string {
  return line.startsWith("\\") ? line.slice(1) : line;
}

function section(name: (typeof INTENT_SECTIONS)[number], bodyLines: string[]): string[] {
  return [`## ${name}`, "", ...bodyLines, ""];
}

/**
 * Renders `intent.md`: yaml front matter (`goal_id`, `work_id`, `fingerprint`, `title`, `rationale`, `affected_paths`),
 * a title line, `Status: draft`, and the five sections. Open questions are one-line list items, so the candidate
 * schema forbids a line break inside one; this function refuses it too.
 */
export function renderIntent(doc: IntentDoc): string {
  const { candidate } = doc;
  for (const question of candidate.open_questions) {
    if (/[\r\n]/.test(question)) throw new WorkItemError("an open question must be a single line");
  }
  if (/[\r\n]/.test(candidate.title)) throw new WorkItemError("a title must be a single line");
  const prose = (text: string): string[] => text.split("\n").map(escapeLine);
  const meta = {
    goal_id: doc.goal_id,
    work_id: doc.work_id,
    fingerprint: doc.fingerprint,
    title: candidate.title,
    rationale: candidate.rationale,
    affected_paths: candidate.affected_paths,
  };
  const lines = [
    `# Intent: ${candidate.title}`,
    "",
    "Status: draft",
    "",
    ...section("Problem", prose(candidate.problem)),
    ...section("Proposed outcome", prose(candidate.proposed_outcome)),
    ...section("Affected users and systems", prose(candidate.affected_users_systems)),
    ...section("Constraints", prose(candidate.constraints)),
    ...section(
      "Open questions",
      candidate.open_questions.map((question) => `- ${question}`),
    ),
  ];
  return `---\n${stringify(meta)}---\n${lines.join("\n")}\n`;
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkItemError(`intent.md front matter has no valid ${what}`);
  }
  return value as string[];
}

function stringField(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  if (typeof value !== "string") throw new WorkItemError(`intent.md front matter has no valid ${key}`);
  return value;
}

/**
 * Inverse of `renderIntent`. Line endings are kept as written, so text with `\r\n` round-trips.
 * Throws `WorkItemError` on a missing section, a missing title line or bad front matter.
 */
export function parseIntent(text: string): IntentDoc {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new WorkItemError("intent.md must start with a --- front matter block");
  let meta: unknown;
  try {
    meta = parse(match[1] ?? "");
  } catch {
    throw new WorkItemError("intent.md front matter is not valid YAML");
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new WorkItemError("intent.md front matter must be a mapping");
  }
  const front = meta as Record<string, unknown>;
  const title = stringField(front, "title");
  const body = (match[2] ?? "").replace(/\n$/, "").split("\n");
  if (body[0] !== `# Intent: ${title}`) throw new WorkItemError("intent.md title line does not match its front matter");

  // Every unescaped line that starts with "## " is a heading, because escapeLine hid all other "#" lines.
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.slice(1)) {
    if (line.startsWith("## ")) {
      current = [];
      sections.set(line.slice(3), current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  const lines = (name: (typeof INTENT_SECTIONS)[number]): string[] => {
    const raw = sections.get(name);
    if (raw === undefined) throw new WorkItemError(`intent.md has no "${name}" section`);
    // Drop the blank line after the heading and the blank line before the next one.
    return raw.slice(1, raw.length - 1);
  };
  const prose = (name: (typeof INTENT_SECTIONS)[number]): string => lines(name).map(unescapeLine).join("\n");
  const open_questions = lines("Open questions").map((line) => {
    if (!line.startsWith("- ")) throw new WorkItemError("intent.md open questions must be list items");
    return line.slice(2);
  });
  const candidate: IntentCandidate = {
    title,
    problem: prose("Problem"),
    proposed_outcome: prose("Proposed outcome"),
    affected_users_systems: prose("Affected users and systems"),
    constraints: prose("Constraints"),
    open_questions,
    rationale: stringField(front, "rationale"),
    affected_paths: stringList(front["affected_paths"], "affected_paths"),
  };
  return {
    goal_id: stringField(front, "goal_id"),
    work_id: stringField(front, "work_id"),
    fingerprint: stringField(front, "fingerprint"),
    candidate,
  };
}
