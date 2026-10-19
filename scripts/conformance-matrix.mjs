#!/usr/bin/env node
// Folds docs/requirements.json, the tests it names and docs/evidence/gated-runs.json into one state per
// requirement and keeps the documents that report those states honest (spec section 11: "enforced by
// tests/enforcement").
//
//   node scripts/conformance-matrix.mjs --write   regenerate docs/conformance-matrix.md and the generated block
//                                                 in tests/enforcement/README.md
//   node scripts/conformance-matrix.mjs --check   fail on a problem or on a stale generated file
//
// States: covered / unproven / missing, plus the listing state deferred. Only `missing` and a document that
// disagrees with a state fail the check; `unproven` and `deferred` are honest and pass. Dependency-free but for
// ajv, which the package already ships. `--root <dir>` points the script at another tree (the tests use it).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REQUIREMENTS = "docs/requirements.json";
const GATED_RUNS = "docs/evidence/gated-runs.json";
const MATRIX_DOC = "docs/conformance-matrix.md";
const ENFORCEMENT_README = "tests/enforcement/README.md";
const BLOCK_START = "<!-- requirements:start -->";
const BLOCK_END = "<!-- requirements:end -->";
export const STATES = ["covered", "unproven", "deferred", "missing"];

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateDocument = ajv.compile(
  JSON.parse(readFileSync(new URL("../schemas/requirements.schema.json", import.meta.url), "utf8")),
);

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** A test claims an id with a line comment `// covers: <id>` of its own; a mention in prose does not count. */
function hasMarker(text, id) {
  return text.split("\n").some((line) => line.trim() === `// covers: ${id}`);
}

/** The latest passing record per gated suite name, as an ISO timestamp. */
function latestRecords(root, problems) {
  const path = join(root, GATED_RUNS);
  const latest = new Map();
  if (!existsSync(path)) return latest;
  const parsed = readJson(path);
  if (parsed.error !== undefined) {
    problems.push(`${GATED_RUNS} cannot be read: ${parsed.error}`);
    return latest;
  }
  for (const run of parsed.value.runs ?? []) {
    if (run.result !== "pass" || typeof run.test !== "string" || typeof run.at !== "string") continue;
    const earlier = latest.get(run.test);
    if (earlier === undefined || run.at > earlier) latest.set(run.test, run.at);
  }
  return latest;
}

function judge(req, root, records, problems) {
  const fail = (message) => problems.push(`${req.id}: ${message}`);
  const tests = (req.tests ?? []).map((entry) => {
    const proves = entry.proves ?? "behavior";
    const file = join(root, entry.path);
    let broken = false;
    if (!existsSync(file)) {
      broken = true;
      fail(`${entry.path} does not exist`);
    } else if (proves === "behavior" && !hasMarker(readFileSync(file, "utf8"), req.id)) {
      broken = true;
      fail(`${entry.path} has no "// covers: ${req.id}" marker`);
    }
    return { path: entry.path, gated: entry.gated ?? null, proves, broken, counts: !broken && proves === "behavior" };
  });
  const dates = tests
    .filter((test) => test.counts && test.gated !== null && records.has(test.gated))
    .map((test) => records.get(test.gated))
    .sort();
  const needsOffline = req.real_world !== true;
  let state;
  if (req.deferred_to !== undefined) {
    state = "deferred";
    if (tests.length > 0) fail("a deferred requirement must list no tests");
  } else if (tests.some((test) => test.broken)) {
    state = "missing";
  } else if (!tests.some((test) => test.counts && (!needsOffline || test.gated === null))) {
    state = "missing";
    fail("no test that counts (wiring_only entries never count)");
  } else {
    state = req.real_world === true && dates.length === 0 ? "unproven" : "covered";
  }

  const surfaces = req.surfaces ?? [];
  if ((state === "unproven" || state === "deferred") && surfaces.length === 0) {
    fail(`${state === "unproven" ? "an unproven" : "a deferred"} requirement lists no surface`);
  }
  const unprovenMark = `[not enforced: ${req.id}]`;
  const deferredMark = `${req.id}: not implemented (deferred to ${req.deferred_to})`;
  for (const surface of surfaces) {
    const file = join(root, surface);
    if (!existsSync(file)) {
      fail(`${surface} does not exist`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (state === "unproven" && !text.includes(unprovenMark)) fail(`${surface} lacks ${unprovenMark}`);
    if (state === "covered" && text.includes(unprovenMark)) {
      fail(`${surface} still says ${unprovenMark} but the requirement is covered`);
    }
    if (state === "deferred" && !text.includes(deferredMark)) fail(`${surface} does not say "${deferredMark}"`);
  }
  return {
    id: req.id,
    source: req.source,
    claim: req.claim,
    state,
    real_world: req.real_world === true,
    deferred_to: req.deferred_to ?? null,
    last_recorded: dates.length > 0 ? dates[dates.length - 1].slice(0, 10) : null,
    tests: tests.map(({ path, gated, proves, counts }) => ({ path, gated, proves, counts })),
  };
}

/** @returns {{ rows: object[], problems: string[] }} A broken document gives no rows and one problem. */
export function computeMatrix({ root = REPO } = {}) {
  const loaded = readJson(join(root, REQUIREMENTS));
  if (loaded.error !== undefined) return { rows: [], problems: [`${REQUIREMENTS} cannot be read: ${loaded.error}`] };
  if (!validateDocument(loaded.value)) {
    const why = ajv.errorsText(validateDocument.errors);
    return { rows: [], problems: [`${REQUIREMENTS} does not match schemas/requirements.schema.json: ${why}`] };
  }
  const problems = [];
  const records = latestRecords(root, problems);
  const rows = [];
  const seen = new Set();
  for (const req of loaded.value.requirements) {
    if (seen.has(req.id)) {
      problems.push(`${req.id} appears twice in ${REQUIREMENTS}`);
      continue;
    }
    seen.add(req.id);
    rows.push(judge(req, root, records, problems));
  }
  return { rows, problems };
}

const summary = (rows) =>
  STATES.map((state) => `${rows.filter((row) => row.state === state).length} ${state}`).join(", ");
const cell = (text) => String(text).replaceAll("|", "\\|");

function testsText(row) {
  if (row.state === "deferred") return "none";
  const count = (keep) => row.tests.filter(keep).length;
  const parts = [
    [count((test) => test.counts && test.gated === null), "offline"],
    [count((test) => test.gated !== null), "gated"],
    [count((test) => test.proves === "wiring_only"), "wiring only"],
  ];
  return (
    parts
      .filter(([n]) => n > 0)
      .map(([n, label]) => `${n} ${label}`)
      .join(", ") || "none"
  );
}

export function renderMatrixMd(rows) {
  return [
    "# Conformance matrix",
    "",
    "Generated from `docs/requirements.json` by `node scripts/conformance-matrix.mjs --write`; `--check` fails on drift. Do not edit by hand.",
    "",
    "- **covered**: a test that exists and carries its `// covers: <id>` marker passes offline, and a requirement that needs a real container or model also has a passing record in `docs/evidence/gated-runs.json`.",
    "- **unproven**: offline tests exist and the real-world run has no record yet. The documents that make the claim say `[not enforced: <id>]`.",
    "- **deferred**: the design states it and v0.1 does not implement it. It has no test, and the documents say `not implemented`.",
    "- **missing**: no test counts, or a mapped file is absent. CI fails.",
    "",
    `Totals: ${summary(rows)}.`,
    "",
    "| Id | State | Last recorded | Tests | Claim |",
    "|---|---|---|---|---|",
    ...rows.map((row) => {
      const state = row.state === "deferred" ? `deferred (${row.deferred_to})` : row.state;
      return `| \`${row.id}\` | ${state} | ${row.last_recorded ?? "-"} | ${cell(testsText(row))} | ${cell(row.claim)} |`;
    }),
    "",
  ].join("\n");
}

export function renderEnforcementBlock(rows) {
  const ids = (state) =>
    rows
      .filter((row) => row.state === state)
      .map((row) => `\`${row.id}\``)
      .join(", ") || "none";
  return [
    BLOCK_START,
    `Requirement states, generated from \`docs/requirements.json\` (${summary(rows)}). The full table is [the conformance matrix](../../docs/conformance-matrix.md).`,
    "",
    `- unproven: ${ids("unproven")}`,
    `- deferred: ${ids("deferred")}`,
    `- missing: ${ids("missing")}`,
    BLOCK_END,
  ].join("\n");
}

/** Replaces the generated block, or returns null when the markers are not both there. */
function replaceBlock(text, block) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return null;
  return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
}

function generated(root, rows) {
  const path = join(root, ENFORCEMENT_README);
  const readme = replaceBlock(existsSync(path) ? readFileSync(path, "utf8") : "", renderEnforcementBlock(rows));
  if (readme === null) return { error: `${ENFORCEMENT_README} lacks the ${BLOCK_START} and ${BLOCK_END} markers` };
  return {
    files: [
      [MATRIX_DOC, renderMatrixMd(rows)],
      [ENFORCEMENT_README, readme],
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  let mode = null;
  let root = REPO;
  let usage = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--write" || args[i] === "--check") mode = args[i];
    else if (args[i] === "--root" && args[i + 1] !== undefined) root = resolve(args[++i]);
    else usage = true;
  }
  if (usage || mode === null) {
    console.error("usage: node scripts/conformance-matrix.mjs (--write | --check) [--root <dir>]");
    process.exitCode = 2;
    return;
  }
  const { rows, problems } = computeMatrix({ root });
  const out = generated(root, rows);
  if (out.error !== undefined) problems.push(out.error);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`conformance: ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (mode === "--write") {
    for (const [path, text] of out.files) writeFileSync(join(root, path), text);
    console.log(`conformance matrix written: ${summary(rows)}`);
    return;
  }
  const stale = out.files.filter(
    ([path, text]) => !existsSync(join(root, path)) || readFileSync(join(root, path), "utf8") !== text,
  );
  for (const [path] of stale)
    console.error(`conformance: ${path} is out of date; run node scripts/conformance-matrix.mjs --write`);
  if (stale.length > 0) process.exitCode = 1;
  else console.log(`conformance matrix is current: ${summary(rows)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
