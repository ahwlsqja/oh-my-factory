import { describe, expect, it } from "vitest";
import { TOOL_CONFIG_FILES, judgeConfigTouched, resolveJudgeFiles } from "../../src/audit/judge-files.js";

const BASE = ["package.json", "scripts/gates.mjs", "src/a.ts", "tests/gate.mjs", "vitest.config.ts", "README.md"];
const resolve = (argvs: string[][], diff: string[] = [], base: string[] = BASE) => resolveJudgeFiles(argvs, base, diff);
const touched = (argvs: string[][], diff: string[], base: string[] = BASE) => judgeConfigTouched(resolve(argvs, diff, base), diff);

describe("resolveJudgeFiles", () => {
  it("resolves an exact file token that is in the base tree", () => {
    expect(resolve([["node", "scripts/gates.mjs"]])).toEqual({ tracked: ["scripts/gates.mjs"], config_globs: [] });
    expect(resolve([["node", "./scripts/gates.mjs"]]).tracked).toEqual(["scripts/gates.mjs"]);
  });

  it("resolves a token that names a file added by the diff", () => {
    expect(resolve([["node", "scripts/new-gate.mjs"]], ["scripts/new-gate.mjs"]).tracked).toEqual(["scripts/new-gate.mjs"]);
  });

  it("does not expand a directory token: `eslint src`, `pytest src` and `.` resolve no file from the directory", () => {
    expect(resolve([["eslint", "src"]])).toEqual({ tracked: [], config_globs: [] });
    expect(resolve([["node", "."]])).toEqual({ tracked: [], config_globs: [] });
    expect(resolve([["pytest", "src"]]).tracked).toEqual([]);
  });

  it("looks the tool-config list up for every token, not only argv[0]", () => {
    const npm = resolve([["npm", "test"]]);
    const npx = resolve([["npx", "vitest"]]);
    for (const judge of [npm, npx]) {
      expect(judge.config_globs).toContain("package.json");
      expect(judge.config_globs).toContain("vitest.config.*");
    }
    expect(npx.config_globs).toEqual(expect.arrayContaining(["jest.config.*", ".mocharc.*", "tsconfig.json"]));
    expect(resolve([["sh", "-c", "make"]]).config_globs).toEqual(["GNUmakefile", "Makefile"]);
    expect(resolve([["env", "FOO=1", "cargo", "test"]]).config_globs).toEqual(["Cargo.toml"]);
  });

  it("strips a directory prefix and an @version from a tool token", () => {
    expect(resolve([["node_modules/.bin/vitest@1.2.3"]]).config_globs).toContain("vitest.config.*");
    expect(resolve([["./node_modules/.bin/jest"]]).config_globs).toContain("jest.config.*");
  });

  it("knows python and pytest configs, including conftest.py anywhere", () => {
    const pytest = resolve([["python", "-m", "pytest"]]).config_globs;
    expect(pytest).toEqual(expect.arrayContaining(["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg", "**/conftest.py"]));
  });

  it("an unknown tool and a prototype key resolve nothing", () => {
    expect(resolve([["my-lint", "constructor", "toString"]])).toEqual({ tracked: [], config_globs: [] });
  });

  it("the list is closed and every entry is a non-empty glob list", () => {
    for (const [tool, globs] of Object.entries(TOOL_CONFIG_FILES)) {
      expect(tool).toMatch(/^[a-z0-9]+$/);
      expect(globs.length).toBeGreaterThan(0);
    }
  });
});

describe("judgeConfigTouched", () => {
  it("is true for an edited or deleted gate script named in a gate command", () => {
    expect(touched([["node", "scripts/gates.mjs"]], ["scripts/gates.mjs"])).toBe(true);
  });

  it("is false for a normal change when the gate names a script and a directory", () => {
    expect(touched([["node", "scripts/gates.mjs"], ["eslint", "src"]], ["src/a.ts", "src/b/c.ts"])).toBe(false);
  });

  it("is true for an edited package.json when the gate is npm test", () => {
    expect(touched([["npm", "test"]], ["package.json"])).toBe(true);
    expect(touched([["npm", "test"]], ["src/a.ts"])).toBe(false);
  });

  it("is true for an ADDED runner config, which could exclude tests", () => {
    for (const path of ["vitest.config.mts", "jest.config.js", ".mocharc.json", "babel.config.cjs"]) {
      expect(touched([["npm", "test"]], [path], ["package.json"]), path).toBe(true);
    }
    expect(touched([["pytest"]], ["conftest.py"], ["setup.py"])).toBe(true);
    expect(touched([["pytest"]], ["pkg/tests/conftest.py"], ["setup.py"])).toBe(true);
    expect(touched([["pytest"]], ["pytest.ini"], ["setup.py"])).toBe(true);
  });

  it("matches configs at the repository root only, except conftest.py", () => {
    expect(touched([["npm", "test"]], ["packages/x/package.json"])).toBe(false);
    expect(touched([["npm", "test"]], ["VITEST.CONFIG.TS"])).toBe(true); // case-insensitive
  });

  it("an edited gate script under tests/ is a judge file and also a test edit", () => {
    const judge = resolve([["node", "tests/gate.mjs"]]);
    expect(judge.tracked).toEqual(["tests/gate.mjs"]);
    expect(judgeConfigTouched(judge, ["tests/gate.mjs"])).toBe(true);
  });

  it("zero resolved files means nothing was checked (judge_files_checked 0 maps to not_run, M3e-D13)", () => {
    const judge = resolve([["my-lint", "--all"]]);
    expect(judge.tracked.length + judge.config_globs.length).toBe(0);
    expect(judgeConfigTouched(judge, ["anything.ts"])).toBe(false); // false, but the caller must read the count, not this flag
  });
});
