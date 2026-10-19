import { normalizePath } from "./fingerprint.js";
import { isTestPath } from "./risk.js";

/**
 * A deterministic, line-based test-weakening check over a unified diff (`git diff`). It lists the test or coverage-config
 * paths where the change makes the tests weaker: the file is deleted, it loses more assertion lines than it gains, it gains
 * more skip/only/todo/x-prefixed markers than it loses, a numeric threshold goes down, or a runner or coverage config under
 * a test path is added or edited in any way other than raising a number. Comment lines count as neither assertions nor
 * markers. Touching a test file, or adding one, is not weakening by itself.
 *
 * Returns the sorted paths, or `null` when the diff cannot be read in full: a file section that does not parse, or, when
 * `auditedPaths` is given, a test or coverage-config path of that list with no section, or a flagged path that is not in
 * it. A caller treats `null` like a missing diff: it stays conservative and keeps every test change high.
 */
export function findTestWeakening(
  diff: string,
  explicitTestPaths: readonly string[],
  auditedPaths?: readonly string[],
): string[] | null {
  const found = new Set<string>();
  const seen = new Set<string>();
  for (const section of splitSections(diff)) {
    const parsed = parseSection(section);
    if (parsed === null) return null;
    const { path, deleted, removed, added } = parsed;
    seen.add(normalizePath(path));
    const isTest = isTestPath(path, explicitTestPaths);
    if (!isTest && !isCoverageConfig(path)) continue;
    if (isTest && (deleted || assertionsLost(removed, added) || markersGained(removed, added))) found.add(path);
    else if (isTest && isRunnerConfig(path) && !onlyRaisesThresholds(removed, added)) found.add(path);
    else if (thresholdLowered(removed, added)) found.add(path);
  }
  if (auditedPaths !== undefined) {
    const audited = new Set(auditedPaths.map((path) => normalizePath(path)));
    for (const path of audited)
      if ((isTestPath(path, explicitTestPaths) || isCoverageConfig(path)) && !seen.has(path)) return null;
    for (const path of found) if (!audited.has(normalizePath(path))) return null;
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const RUNNER_CONFIG =
  /^(vitest|vite|jest|karma|playwright)\.config\.[^/]+$|^vitest\.workspace\.[^/]+$|^\.mocharc(\.[^/]+)?$|^\.?(nycrc|c8rc)(\.[^/]+)?$|^(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py)$/i;
const COVERAGE_CONFIG = /^\.?(coveragerc|codecov)(\.[^/]+)?$|^(codecov\.ya?ml|package\.json)$/i;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A test runner or coverage tool config: the file that decides which tests run and how much coverage is required. */
function isRunnerConfig(path: string): boolean {
  return RUNNER_CONFIG.test(basename(path));
}

function isCoverageConfig(path: string): boolean {
  return isRunnerConfig(path) || COVERAGE_CONFIG.test(basename(path));
}

function splitSections(diff: string): string[][] {
  const sections: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return sections;
}

interface Section {
  path: string;
  deleted: boolean;
  removed: string[];
  added: string[];
}

const SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };

/** Decodes a git C-quoted name (`"..."` with octal and single-character escapes); an unquoted name is returned as is. */
function unquote(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const [token] of raw.slice(1, -1).matchAll(/\\[0-7]{1,3}|\\[\s\S]|[^\\]+/g)) {
    if (!token.startsWith("\\")) bytes.push(...encoder.encode(token));
    else if (/^\\[0-7]/.test(token)) bytes.push(Number.parseInt(token.slice(1), 8) & 0xff);
    else bytes.push(SIMPLE_ESCAPES[token[1] ?? ""] ?? token.codePointAt(1) ?? 0);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** Git ends a `---`/`+++` name with a tab when the name contains a space. */
const stripTab = (name: string): string => (name.endsWith("\t") ? name.slice(0, -1) : name);

function parseSection(lines: string[]): Section | null {
  let path: string | null = null;
  let deleted = false;
  const removed: string[] = [];
  const added: string[] = [];
  let inHunk = false;
  for (const line of lines.slice(1)) {
    if (!inHunk) {
      if (line.startsWith("deleted file mode")) deleted = true;
      else if (line.startsWith("--- ") && line !== "--- /dev/null") {
        const name = unquote(stripTab(line.slice(4)));
        if (name.startsWith("a/")) path = name.slice(2);
      } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        const name = unquote(stripTab(line.slice(4)));
        if (name.startsWith("b/")) path = name.slice(2);
      }
      if (line.startsWith("@@")) inHunk = true;
    } else if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  if (path === null) return lines.length > 1 && inHunk ? null : binaryOrModeOnly(lines);
  return { path, deleted, removed, added };
}

/** A section with no `---`/`+++` lines (a mode change or a binary file) has no text lines to weaken anything. */
function binaryOrModeOnly(lines: string[]): Section | null {
  const header = /^diff --git ("(?:[^"\\]|\\.)*"|a\/\S.*?) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(lines[0] ?? "");
  const from = unquote(header?.[1] ?? "");
  const to = unquote(header?.[2] ?? "");
  if (header === null || !from.startsWith("a/") || !to.startsWith("b/") || from.slice(2) !== to.slice(2)) return null;
  const deleted = lines.some((line) => line.startsWith("deleted file mode"));
  return { path: to.slice(2), deleted, removed: [], added: [] };
}

const ASSERTION =
  /\b(expect|assert\w*|should|verify|require\.\w+)\s*[.(!]|\.should\b|\bt\.(is|not|true|false|ok|equal|deepEqual|throws|rejects)\w*\(|\bself\.assert\w*\(|\bassert_\w+!?\(|\bassert!?\(|^\s*assert\b|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\(|\bassert_\w+\b|\bexpect\w*\s*\(/;

const COMMENT_START = /^\s*(\/\/|#(?!\[)|\/\*|\*|<!--)/;

/** The code part of a line, or null for a comment line. A trailing `// ...` comment (after whitespace) is cut off. */
function codeOf(line: string): string | null {
  if (COMMENT_START.test(line)) return null;
  return line.replace(/\s\/\/.*$/, "");
}

function count(lines: readonly string[], pattern: RegExp): number {
  return lines.filter((line) => {
    const code = codeOf(line);
    return code !== null && pattern.test(code);
  }).length;
}

function assertionsLost(removed: readonly string[], added: readonly string[]): boolean {
  return count(removed, ASSERTION) > count(added, ASSERTION);
}

const MARKER =
  /\b(it|test|describe|suite|context|bench)(\.\w+)*\.(skip|only|todo|fixme|fails|skipIf|runIf)\b|\{[^}]*\b(skip|todo|only)\s*:\s*true|\b(ctx|context|t)\.(skip|todo)\(|(?<![\w.$])(xit|xtest|xdescribe|fit|ftest|fdescribe)\s*\(|\bpytest\.mark\.(skip|xfail)|\bpytest\.(skip|xfail)\(|@unittest\.skip|\bt\.Skip(f|Now)?\(|\bself\.skipTest\(|\.failing\b|expectedFailure|^\s*pytestmark\s*=|\bthis\.skip\s*\(|\bfunc\s+TestMain\s*\(|@Disabled\b|@Ignore\b|#\[ignore\b/;

function markersGained(removed: readonly string[], added: readonly string[]): boolean {
  return count(added, MARKER) > count(removed, MARKER);
}

const PAIR = /([A-Za-z_][\w-]*)["']?\s*[:=]\s*(\d+(?:\.\d+)?)\b/g;
const THRESHOLD_KEYS =
  /^(threshold|thresholds|lines|branches|functions|statements|min|minimum|min_coverage|coverage|fail[_-]under|cov-fail-under|target|percent|\w*threshold\w*)$/i;

/** Every `key: number` or `key = number` pair of a line, in order (a one-line `{ lines: 80, branches: 90 }` has two). */
function pairsOf(line: string): Array<[string, number]> {
  return [...line.matchAll(PAIR)].map((match) => [(match[1] ?? "").toLowerCase(), Number(match[2])]);
}

function thresholds(lines: readonly string[]): Array<[string, number]> {
  return lines.flatMap((line) => pairsOf(line).filter(([key]) => THRESHOLD_KEYS.test(key)));
}

/**
 * True when the change to a config is numbers going up, nothing else: the same number of changed lines, every line holding a
 * threshold key, and every `key: number` pair of the removed lines found again, in order, with a value that did not go down.
 * Anything it cannot pair is undecidable and counts as weakening.
 */
function onlyRaisesThresholds(removed: readonly string[], added: readonly string[]): boolean {
  if (removed.length === 0 || removed.length !== added.length) return false;
  const holdsThreshold = (line: string): boolean => pairsOf(line).some(([key]) => THRESHOLD_KEYS.test(key));
  if (!removed.every(holdsThreshold) || !added.every(holdsThreshold)) return false;
  const before = removed.flatMap(pairsOf);
  const after = added.flatMap(pairsOf);
  if (before.length !== after.length) return false;
  return before.every(([key, value], index) => after[index]?.[0] === key && (after[index]?.[1] ?? -1) >= value);
}

function thresholdLowered(removed: readonly string[], added: readonly string[]): boolean {
  const after = thresholds(added);
  // A threshold key that disappears (the line or the whole config file is removed) counts as lowered.
  return thresholds(removed).some(([key, before]) => {
    const same = after.filter(([name]) => name === key);
    return same.length === 0 || same.some(([, now]) => now < before);
  });
}
