import { basename } from "node:path";
import picomatch from "picomatch";
import { normalizePath } from "../work/fingerprint.js";

const NODE_RUNNER_CONFIGS = ["package.json", "tsconfig.json", "vitest.config.*", "vitest.workspace.*", "vite.config.*", "jest.config.*", ".mocharc.*", "babel.config.*"];
const PYTEST_CONFIGS = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg", "**/conftest.py"];

/**
 * The closed list of tool configs, looked up for EVERY argv token (basename, leading `./` and a trailing `@version` removed), so
 * `npm test` and `npx vitest` both resolve. The globs are relative to the repository root, matched case-insensitively against every
 * path of the diff including added files: a candidate that ADDS `vitest.config.ts`, `conftest.py`, `pytest.ini` or `.mocharc.*`
 * to exclude tests is flagged. A config in a subdirectory is not covered (a recorded limit), except `conftest.py`.
 */
export const TOOL_CONFIG_FILES: Readonly<Record<string, readonly string[]>> = {
  npm: NODE_RUNNER_CONFIGS,
  pnpm: NODE_RUNNER_CONFIGS,
  yarn: NODE_RUNNER_CONFIGS,
  npx: NODE_RUNNER_CONFIGS,
  vitest: ["vitest.config.*", "vitest.workspace.*", "vite.config.*", "tsconfig.json", "package.json"],
  jest: ["jest.config.*", "babel.config.*", "tsconfig.json", "package.json"],
  mocha: [".mocharc.*", "package.json"],
  make: ["Makefile", "GNUmakefile"],
  cargo: ["Cargo.toml"],
  go: ["go.mod"],
  python: PYTEST_CONFIGS,
  python3: PYTEST_CONFIGS,
  pytest: PYTEST_CONFIGS,
};

export interface JudgeFiles {
  /** Exact files of the base tree (or added by the diff) that an argv token names. */
  tracked: string[];
  /** The tool-config globs that apply. */
  config_globs: string[];
}

function toolOf(token: string): string {
  return basename(token.replace(/^\.\//, "")).replace(/@[^@/]*$/, "");
}

/**
 * Judge files = (a) EXACT file tokens: an argv token (leading `./` removed) that equals a path of the base tree or of the diff;
 * directory tokens (`src`, `.`) are NOT expanded (expanding made `eslint src` flag every change and stop every run at GATE-3; a
 * gate script reached only through a directory token is not covered, a recorded limit); plus (b) the closed `TOOL_CONFIG_FILES`.
 * `argvs` are the declared gate commands and the test command, from the ledger, never from the tree.
 * `judge_files_checked` is `tracked.length + config_globs.length`; zero means the commands name no file and no known tool, and the
 * caller reports `judge_config: not_run`, never a vacuous `unchanged`.
 */
export function resolveJudgeFiles(argvs: ReadonlyArray<readonly string[]>, baseTree: readonly string[], diffPaths: readonly string[]): JudgeFiles {
  const known = new Set([...baseTree, ...diffPaths]);
  const tracked = new Set<string>();
  const globs = new Set<string>();
  for (const argv of argvs) {
    for (const token of argv) {
      const exact = normalizePath(token);
      if (exact !== "" && known.has(exact)) tracked.add(exact);
      const tool = toolOf(token);
      if (Object.hasOwn(TOOL_CONFIG_FILES, tool)) for (const glob of TOOL_CONFIG_FILES[tool] ?? []) globs.add(glob);
    }
  }
  return { tracked: [...tracked].sort(), config_globs: [...globs].sort() };
}

/**
 * True when any path of the diff (A, M, D or T) equals a tracked judge file or matches a config glob. A test-glob path stays in
 * both `tests_edited` and the judge files: an edited gate script under `tests/` is a GATE-3 stop, not only `flawed`.
 */
export function judgeConfigTouched(judge: JudgeFiles, diffPaths: readonly string[]): boolean {
  const tracked = new Set(judge.tracked);
  const matchesConfig = judge.config_globs.length > 0 ? picomatch([...judge.config_globs], { dot: true, nocase: true }) : () => false;
  return diffPaths.some((path) => {
    const normalized = normalizePath(path);
    return tracked.has(normalized) || matchesConfig(normalized);
  });
}
