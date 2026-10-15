import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** `from "./x.js"`, `import "./x.js"` and `import("./x.js")`: every relative specifier that loads code. */
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;

/**
 * A quoted event type of a host-only family. The quote must come right before the family name, so prose such as
 * "a person's decision. Re-approval" and a bare "decision" do not match.
 */
export const HOST_ONLY_EVENT_LITERAL = /["'`](decision|feedback)\.[a-z_]+/;

/** Code that only the W side may reach (M3-D1). */
export const HOST_ONLY_DIRS = ["src/decision/", "src/feedback/"] as const;

/** The goal loop's entry points: every `src/goal/*.ts` and `src/cli/goal.ts`. */
export function entryFiles(root: string): string[] {
  const goal = join(root, "src", "goal");
  const files = readdirSync(goal)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(goal, name));
  return [...files, join(root, "src", "cli", "goal.ts")];
}

/**
 * Every module reachable from `entries` through relative `.js` specifiers (each resolved to the `.ts` next to it),
 * entries included, sorted. It throws on a specifier that does not resolve to a file, so a broken walk cannot pass
 * by seeing less than the build sees.
 */
export function reachableModules(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (!specifier.endsWith(".js")) throw new Error(`${file}: unsupported relative specifier ${specifier}`);
      const target = resolve(dirname(file), `${specifier.slice(0, -3)}.ts`);
      if (!existsSync(target)) throw new Error(`${file}: ${specifier} does not resolve to ${target}`);
      pending.push(target);
    }
  }
  return [...seen].sort();
}

/**
 * One line per problem, without the matched text: a module under a host-only directory, and each line that quotes a
 * `decision.*` or `feedback.*` event type. Paths are relative to `root` with `/` separators.
 */
export function hostOnlyViolations(root: string, modules: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of modules) {
    const name = relative(root, file).split(sep).join("/");
    if (HOST_ONLY_DIRS.some((dir) => name.startsWith(dir))) found.push(`${name}: reachable host-only module`);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (HOST_ONLY_EVENT_LITERAL.test(line)) found.push(`${name}:${index + 1}: quoted host-only event type`);
      });
  }
  return found;
}
