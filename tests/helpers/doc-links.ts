import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LinkProblem {
  file: string;
  line: number;
  target: string;
  reason: string;
}

/** Lowercase, drop punctuation except hyphens and underscores, spaces to hyphens: how GitHub names a heading anchor. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/** Text with fenced code blocks and inline code blanked out (line structure kept), so code is never read as links or headings. */
function withoutCode(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === null && marker !== undefined) {
        fence = marker[0] as string;
        return "";
      }
      if (fence !== null) {
        if (marker !== undefined && marker[0] === fence) fence = null;
        return "";
      }
      return line.replace(/`+[^`]*`+/g, (m) => " ".repeat(m.length));
    })
    .join("\n");
}

/** Anchors a Markdown file offers: its headings (with GitHub's -1, -2 suffixes for repeats) and explicit id/name attributes. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const text = withoutCode(markdown);
  for (const line of text.split("\n")) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    // Link text and emphasis markers are not part of the slug; the link target is dropped.
    const plain = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_~]+(?=\S)|(?<=\S)[*~]+/g, "");
    const base = slugify(plain);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of markdown.matchAll(/<[a-z]+[^>]*\b(?:id|name)="([^"]+)"/gi)) anchors.add(m[1] as string);
  return anchors;
}

interface Link {
  target: string;
  line: number;
}

/** Inline links and images `[t](target)`, and reference definitions `[id]: target`. Targets with `<...>` or a title are unwrapped. */
export function linksOf(markdown: string): Link[] {
  const links: Link[] = [];
  const lines = withoutCode(markdown).split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^\s)]*(?:\([^\s)]*\)[^\s)]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      links.push({ target: (m[1] as string).replace(/^<|>$/g, ""), line: i + 1 });
    }
    const def = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line)?.[1];
    if (def !== undefined) links.push({ target: def.replace(/^<|>$/g, ""), line: i + 1 });
  });
  return links;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Checks every relative link in `files` (paths relative to `root`). A link must point at a file or directory that
 * exists inside `root` (and is in `known`, when given: files git does not track would be missing from a clone),
 * and a `#fragment` on a Markdown target must match one of its headings. External URLs are not fetched.
 */
export function checkLinks(root: string, files: readonly string[], known?: ReadonlySet<string>): LinkProblem[] {
  const problems: LinkProblem[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (rel: string): Set<string> => {
    let set = anchorCache.get(rel);
    if (set === undefined) {
      set = anchorsOf(readFileSync(join(root, rel), "utf8"));
      anchorCache.set(rel, set);
    }
    return set;
  };
  const isKnown = (rel: string): boolean => {
    if (known === undefined) return true;
    if (known.has(rel)) return true;
    const prefix = rel === "" ? "" : `${rel}/`;
    for (const k of known) if (k.startsWith(prefix)) return true;
    return false;
  };

  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const { target, line } of linksOf(text)) {
      if (target === "" || EXTERNAL.test(target)) continue;
      const hash = target.indexOf("#");
      const rawPath = (hash === -1 ? target : target.slice(0, hash)).split("?")[0] as string;
      const fragment = hash === -1 ? "" : decodeURIComponent(target.slice(hash + 1));
      const fail = (reason: string): void => void problems.push({ file, line, target, reason });

      let rel: string;
      if (rawPath === "") {
        rel = file;
      } else {
        const decoded = decodeURIComponent(rawPath);
        const abs = isAbsolute(decoded) ? join(root, decoded) : resolve(root, dirname(file), decoded);
        rel = relative(root, abs).split(sep).join("/");
        if (rel === ".." || rel.startsWith("../")) {
          fail("points outside the repository");
          continue;
        }
        if (!existsSync(abs) || !isKnown(rel)) {
          fail("target does not exist");
          continue;
        }
      }
      if (fragment !== "" && rel.endsWith(".md") && statSync(join(root, rel)).isFile()) {
        // GitHub treats line anchors like #L10 as a source view feature, not a heading.
        if (!anchorsFor(rel).has(fragment.toLowerCase())) fail(`no heading or anchor "#${fragment}" in ${rel}`);
      }
    }
  }
  return problems;
}
