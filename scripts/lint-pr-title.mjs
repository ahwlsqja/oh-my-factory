#!/usr/bin/env node
// Validates a pull request title against Conventional Commits:
//   type(scope)!: subject
// Dependency-free on purpose. The CLI reads the title from the PR_TITLE
// environment variable (never from an interpolated command line) and exits 1
// with a message on stderr when the title is not valid.

import { pathToFileURL } from "node:url";

export const ALLOWED_TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "ci",
  "chore",
  "build",
  "style",
  "revert",
];

const MAX_TITLE_LENGTH = 100;
const TITLE_PATTERN = /^([a-z]+)(?:\(([a-z0-9][a-z0-9._/-]*)\))?(!)?: (.+)$/;

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function lintPrTitle(title) {
  if (typeof title !== "string" || title.trim() === "") {
    return { ok: false, reason: "The title is empty." };
  }
  if (title !== title.trim()) {
    return { ok: false, reason: "The title has leading or trailing whitespace." };
  }
  if (title.includes("\n") || title.includes("\r")) {
    return { ok: false, reason: "The title must be a single line." };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, reason: `The title is longer than ${MAX_TITLE_LENGTH} characters.` };
  }
  const match = TITLE_PATTERN.exec(title);
  if (!match) {
    return { ok: false, reason: "Expected the form `type(scope): subject` or `type: subject`." };
  }
  const [, type, , , subject] = match;
  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, reason: `Unknown type "${type}". Allowed: ${ALLOWED_TYPES.join(", ")}.` };
  }
  if (subject.trim() !== subject) {
    return { ok: false, reason: "The subject has leading or trailing whitespace." };
  }
  if (subject.endsWith(".")) {
    return { ok: false, reason: "The subject must not end with a period." };
  }
  return { ok: true };
}

function main() {
  const title = process.env.PR_TITLE ?? "";
  const result = lintPrTitle(title);
  if (result.ok) {
    process.stdout.write("PR title is a valid Conventional Commit.\n");
    return 0;
  }
  process.stderr.write(`Invalid PR title: ${JSON.stringify(title)}\n${result.reason}\n`);
  process.stderr.write("Example: feat(cli): add a status command\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
