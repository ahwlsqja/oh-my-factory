import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `dir` (recursively) as relative path -> text. Empty when `dir` does not exist. */
export function readTree(dir: string): Map<string, string> {
  const tree = new Map<string, string>();
  if (!existsSync(dir)) return tree;
  for (const entry of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isFile()) tree.set(entry, readFileSync(full, "utf8"));
  }
  return tree;
}

/** The texts of a tree in path order, one after the other, for a single search. */
export function joinTree(tree: ReadonlyMap<string, string>): string {
  return [...tree.values()].join("\n");
}
