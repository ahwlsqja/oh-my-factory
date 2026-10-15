import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorsOf, checkLinks, linksOf, slugify } from "../helpers/doc-links.js";
import { makeTempDir } from "../helpers/tmp.js";

// Every relative link in every Markdown file git tracks must resolve to a file in this repository and, when it
// carries a #fragment, to a heading of that file. External URLs are not fetched. docs/plans is gitignored
// (local only), so it is neither checked nor a valid link target.
const ROOT = new URL("../../", import.meta.url).pathname;

function repoFiles(): string[] {
  // Tracked files, plus new files that are not ignored, so a link to a file added in the same change passes.
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter((f) => f !== "");
}

describe("repository Markdown links", () => {
  it("resolve to existing files and headings", () => {
    const files = repoFiles();
    const docs = files.filter((f) => f.endsWith(".md") && !f.startsWith("docs/plans/"));
    expect(docs).toContain("README.md");
    const problems = checkLinks(ROOT, docs, new Set(files));
    expect(problems.map((p) => `${p.file}:${p.line} (${p.target}) ${p.reason}`)).toEqual([]);
  });
});

describe("link checker", () => {
  function fixture(files: Record<string, string>): { root: string; names: string[] } {
    const root = makeTempDir("omf-docs-");
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), body);
    }
    return { root, names: Object.keys(files).filter((n) => n.endsWith(".md")) };
  }

  it("accepts good links, anchors, directories and external URLs", () => {
    const { root, names } = fixture({
      "a.md": "# A\n\nSee [b](docs/b.md#second-part), [dir](docs/), [self](#a), [web](https://example.invalid/x#y).\n",
      "docs/b.md": "# B\n\n## Second part\n\n[up](../a.md)\n",
    });
    expect(checkLinks(root, names)).toEqual([]);
  });

  it("fails a link to a missing file", () => {
    const { root, names } = fixture({ "a.md": "[gone](nope.md)\n" });
    expect(checkLinks(root, names)).toMatchObject([
      { file: "a.md", line: 1, target: "nope.md", reason: "target does not exist" },
    ]);
  });

  it("fails a link to a missing heading, and one that leaves the repository", () => {
    const { root, names } = fixture({
      "a.md": "[x](b.md#absent)\n[y](../outside.md)\n[z](#nothing-here)\n",
      "b.md": "# Present\n",
    });
    const reasons = checkLinks(root, names).map((p) => p.reason);
    expect(reasons).toEqual([
      expect.stringContaining('no heading or anchor "#absent"'),
      "points outside the repository",
      expect.stringContaining('no heading or anchor "#nothing-here"'),
    ]);
  });

  it("ignores links inside code and counts repeated headings like GitHub does", () => {
    const { root, names } = fixture({
      "a.md": "`[x](nope.md)`\n\n```\n[y](nope2.md)\n```\n\n[ok](b.md#same-1)\n",
      "b.md": "# Same\n\n# Same\n",
    });
    expect(checkLinks(root, names)).toEqual([]);
  });

  it("rejects a target that exists on disk but is not in the known set", () => {
    const { root, names } = fixture({ "a.md": "[p](docs/plans/x.md)\n", "docs/plans/x.md": "# X\n" });
    expect(checkLinks(root, names, new Set(["a.md"]))).toHaveLength(1);
  });

  it("slugifies headings the way GitHub does", () => {
    expect(slugify("Run the goal loop")).toBe("run-the-goal-loop");
    expect(slugify("What's `omf doctor`?")).toBe("whats-omf-doctor");
    expect([...anchorsOf("## 1. Setup & run\n## 한국어 제목\n")]).toEqual(["1-setup--run", "한국어-제목"]);
    expect(linksOf('[a](<x y.md>) ![i](img.png "t")').map((l) => l.target)).toEqual(["x y.md", "img.png"]);
  });
});
