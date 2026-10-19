import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Completeness checks for registries that are kept by hand. Each function compares a directory with the list
 * that is supposed to name everything in it and returns one message per unregistered entry. The message names
 * the entry and the registry, so a failing CI run says what to add and where.
 */

/**
 * Top-level repository entries that do not ship in the package. Everything a new top-level entry could be
 * must be here or in package.json "files"; otherwise `checkTopLevel` fails. Adding an entry is a decision that
 * it stays out of the tarball.
 */
export const DEV_ONLY_TOP_LEVEL: readonly string[] = [
  ".editorconfig",
  ".git-blame-ignore-revs",
  ".gitattributes",
  ".github",
  ".gitignore",
  ".release-please-manifest.json",
  "AGENTS.md",
  "biome.json",
  "CHANGELOG.md",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "docs",
  "examples",
  "outer",
  "package-lock.json",
  "README.ko.md",
  "release-please-config.json",
  "scripts",
  "SECURITY.md",
  "src",
  "tests",
  "tsconfig.json",
  "tsconfig.test.json",
  "vitest.config.ts",
];

/** Entries npm adds to the tarball whatever "files" says. */
const ALWAYS_SHIPPED = ["package.json"];

/** The top-level names that ship: package.json "files" plus what npm always packs. One source, no second list. */
export function shippedTopLevel(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  return [...(pkg.files ?? []), ...ALWAYS_SHIPPED];
}

/** Tracked files plus new files that are not ignored, so a file added in the same change is seen. */
export function repoFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\0").filter((f) => f !== "");
}

/** Every top-level entry must ship (package.json "files") or be listed as dev only. */
export function checkTopLevel(
  entries: readonly string[],
  shipped: readonly string[],
  devOnly: readonly string[] = DEV_ONLY_TOP_LEVEL,
): string[] {
  const known = new Set([...shipped, ...devOnly]);
  return [...new Set(entries)]
    .filter((entry) => !known.has(entry))
    .map(
      (entry) =>
        `top-level entry "${entry}" is in no registry: add it to package.json "files" (ships) or to DEV_ONLY_TOP_LEVEL in tests/helpers/registries.ts (does not ship)`,
    );
}

/** Every package.json "files" entry that is not a build output must exist in the repository. */
export function checkShippedExist(shipped: readonly string[], entries: readonly string[], built = ["dist"]): string[] {
  const have = new Set(entries);
  return shipped
    .filter((name) => !built.includes(name) && !have.has(name))
    .map((name) => `package.json "files" names "${name}", which is not in the repository`);
}

/**
 * Every test file in the enforcement directory has a row in its README table, and every row names a file that
 * exists. A cell lists backticked paths; a bare file name means the enforcement directory.
 */
export function checkEnforcementReadme(root: string): string[] {
  const dir = join(root, "tests/enforcement");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const problems: string[] = [];
  const named = new Set<string>();
  for (const line of readme.split("\n")) {
    const cell = /^\|\s*([^|]*?)\s*\|/.exec(line)?.[1];
    if (cell === undefined || !cell.includes("`")) continue;
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      const ref = m[1] as string;
      if (!ref.endsWith(".test.ts")) continue;
      const inDir = !ref.includes("/");
      named.add(inDir ? ref : ref.replace(/^tests\/enforcement\//, ""));
      if (!existsSync(inDir ? join(dir, ref) : join(root, ref))) {
        problems.push(`tests/enforcement/README.md names "${ref}", which does not exist`);
      }
    }
  }
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
    if (!named.has(file)) {
      problems.push(`tests/enforcement/${file} has no row in tests/enforcement/README.md (the enforcement table)`);
    }
  }
  return problems;
}

/** Text files under `dirs` (relative to root), skipping node_modules, for a reference search. */
function textFiles(root: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) if (name !== "node_modules") walk(join(path, name));
    } else if (/\.(ts|mjs|json|md)$/.test(path)) out.push(path);
  };
  for (const dir of dirs) if (existsSync(join(root, dir))) walk(join(root, dir));
  return out;
}

/**
 * Every file in schemas/ is named somewhere outside schemas/ (code, a script, a test or a document), so a schema
 * nobody loads or checks is reported instead of shipping unnoticed.
 */
export function checkSchemasReferenced(root: string, searchDirs = ["src", "scripts", "tests", "docs"]): string[] {
  const corpus = textFiles(root, searchDirs)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  return readdirSync(join(root, "schemas"))
    .filter((name) => !corpus.includes(name))
    .map(
      (name) => `schemas/${name} is named in none of ${searchDirs.join(", ")} (the schema registry is its use sites)`,
    );
}
