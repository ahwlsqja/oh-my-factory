import { isTestPath } from "./risk.js";

/**
 * A deterministic test-weakening check over a unified diff (`git diff`). It lists the test or coverage-config paths where
 * the change makes the tests weaker: the file is deleted, it loses more assertion lines than it gains, it gains more
 * skip/only/todo/x-prefixed markers than it loses, or a numeric threshold goes down. Touching a test file, or adding one, is
 * not weakening by itself.
 *
 * Returns the sorted paths, or `null` when a file section of the diff cannot be read. A caller treats `null` like a missing
 * diff: it stays conservative and keeps every test change high.
 */
export function findTestWeakening(diff: string, explicitTestPaths: readonly string[]): string[] | null {
  const found = new Set<string>();
  for (const section of splitSections(diff)) {
    const parsed = parseSection(section);
    if (parsed === null) return null;
    const { path, deleted, removed, added } = parsed;
    const isTest = isTestPath(path, explicitTestPaths);
    if (!isTest && !isCoverageConfig(path)) continue;
    if (isTest && (deleted || assertionsLost(removed, added) || markersGained(removed, added))) found.add(path);
    else if (thresholdLowered(removed, added)) found.add(path);
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const COVERAGE_CONFIG =
  /^(vitest|vite|jest|karma)\.config\.[^/]+$|^\.?(nycrc|c8rc|coveragerc|codecov)(\.[^/]+)?$|^(codecov\.ya?ml|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|package\.json)$/i;

function isCoverageConfig(path: string): boolean {
  return COVERAGE_CONFIG.test(path.slice(path.lastIndexOf("/") + 1));
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

function unquote(raw: string): string {
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

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
        const name = unquote(line.slice(4));
        if (name.startsWith("a/")) path = name.slice(2);
      } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        const name = unquote(line.slice(4));
        if (name.startsWith("b/")) path = name.slice(2);
      }
      if (line.startsWith("@@")) inHunk = true;
    } else if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  if (path === null) return lines.length > 1 && (deleted || inHunk) ? null : binaryOrModeOnly(lines);
  return { path, deleted, removed, added };
}

/** A section with no `---`/`+++` lines (a mode change or a binary file) has no text lines to weaken anything. */
function binaryOrModeOnly(lines: string[]): Section | null {
  const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? "");
  if (header === null || header[1] !== header[2]) return null;
  const deleted = lines.some((line) => line.startsWith("deleted file mode"));
  return { path: header[1] ?? "", deleted, removed: [], added: [] };
}

const ASSERTION =
  /\b(expect|assert\w*|should|verify|require\.\w+)\s*[.(!]|\.should\b|\bt\.(is|not|true|false|ok|equal|deepEqual|throws|rejects)\w*\(|\bself\.assert\w*\(|\bassert_\w+!?\(|\bassert!?\(/;

function count(lines: readonly string[], pattern: RegExp): number {
  return lines.filter((line) => pattern.test(line)).length;
}

function assertionsLost(removed: readonly string[], added: readonly string[]): boolean {
  return count(removed, ASSERTION) > count(added, ASSERTION);
}

const MARKER =
  /\b(it|test|describe|suite|context)\.(skip|only|todo|fixme|fails)\b|\b(xit|xtest|xdescribe|fit|ftest|fdescribe)\s*\(|@pytest\.mark\.(skip|xfail)|\bpytest\.(skip|xfail)\(|@unittest\.skip|\bt\.Skip(Now)?\(|@Disabled\b|@Ignore\b|#\[ignore\]/;

function markersGained(removed: readonly string[], added: readonly string[]): boolean {
  return count(added, MARKER) > count(removed, MARKER);
}

const THRESHOLD = /([A-Za-z_][\w-]*)["']?\s*[:=]\s*(\d+(?:\.\d+)?)\b/;
const THRESHOLD_KEYS =
  /^(threshold|thresholds|lines|branches|functions|statements|min|minimum|min_coverage|coverage|fail[_-]under|cov-fail-under|target|percent|\w*threshold\w*)$/i;

function thresholds(lines: readonly string[]): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const line of lines) {
    const match = THRESHOLD.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined && THRESHOLD_KEYS.test(key))
      out.push([key.toLowerCase(), Number(value)]);
  }
  return out;
}

function thresholdLowered(removed: readonly string[], added: readonly string[]): boolean {
  const after = thresholds(added);
  return thresholds(removed).some(([key, before]) => after.some(([name, now]) => name === key && now < before));
}
