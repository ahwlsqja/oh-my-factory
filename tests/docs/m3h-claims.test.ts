import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The author container adds a real-model path, a trust boundary the measurement cannot close and a cost OMF does not meter.
// The shipped text states all three in fixed sentences, and says "not enforced" for each gated suite until
// docs/evidence/gated-runs.json holds a passing record of it. The claims about the gated tests join this file with those suites.
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const AUTHOR = "docs/author.md";
const ISOLATION = "docs/isolation-and-gates.md";
const MARKER = "[not enforced: S7.docker-client-trusted]";
const TRUST = "trusts the `docker` client found on PATH and the configured docker context";
const SPEND = "neither records nor bounds the spend of an author call";
const SUITES = ["G-author-boundary-real", "G-author-canary", "G-skeleton-real"] as const;

const recorded = (): string[] =>
  (JSON.parse(read("docs/evidence/gated-runs.json")) as { runs: { test: string }[] }).runs.map((run) => run.test);
const CLAIM = /measured:\s*"?L[123]\b|\bsealed\b|\bproven\b|\bis enforced\b/i;
const QUALIFIER = /not enforced|unproven|not proven/i;

describe("docs/author.md", () => {
  it("states the exposure, the trust boundary, the unmetered spend and the limits", () => {
    const page = read(AUTHOR);
    const required = [
      "`OMF_AUTHOR_API_KEY`",
      "can read and use the key",
      "dedicated, spend-limited",
      "no bind mount",
      "open egress",
      "default bridge",
      "same vendor",
      TRUST,
      MARKER,
      SPEND,
      "not enforced",
    ];
    expect(required.filter((phrase) => !page.includes(phrase))).toEqual([]);
  });

  it("says not enforced for every author suite that is not recorded and makes no unqualified claim", () => {
    const page = read(AUTHOR);
    const lines = page.split("\n");
    const unrecorded = SUITES.filter((suite) => !recorded().includes(suite));
    expect(
      unrecorded.filter((suite) => !lines.some((l) => l.includes(`\`${suite}\``) && /not enforced/i.test(l))),
    ).toEqual([]);
    expect(lines.filter((line) => CLAIM.test(line) && !QUALIFIER.test(line))).toEqual([]);
  });

  it("names only repository paths that exist", () => {
    const named = [...read(AUTHOR).matchAll(/`((?:src|tests|schemas|docs|scripts)\/[A-Za-z0-9_./-]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(named.length).toBeGreaterThan(2);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
  });
});

describe("the other pages", () => {
  it("the isolation page states the trust boundary and the spend, and no longer says the author container is missing", () => {
    const page = read(ISOLATION);
    expect(page).toContain(TRUST);
    expect(page).toContain(SPEND);
    expect(page).toContain(MARKER);
    expect(page).not.toContain("The author container does not exist");
    expect(page).toContain("`G-author-canary`");
  });

  it("the requirement lists both pages as surfaces and both carry its marker", () => {
    const doc = JSON.parse(read("docs/requirements.json")) as { requirements: { id: string; surfaces: string[] }[] };
    const requirement = doc.requirements.find((r) => r.id === "S7.docker-client-trusted");
    expect(requirement?.surfaces).toEqual(expect.arrayContaining([AUTHOR, ISOLATION]));
    for (const page of [AUTHOR, ISOLATION]) expect(read(page), page).toContain(MARKER);
  });

  it("the implementer page says omf run runs the implementer", () => {
    expect(read("docs/implementer.md")).not.toContain("no command runs it yet");
    expect(read("docs/implementer.md")).toContain("`omf run` runs the implementer");
  });

  it("the READMEs and the documentation index link the new pages", () => {
    for (const file of ["README.md", "README.ko.md"]) {
      const text = read(file);
      for (const target of ["docs/author.md", "docs/cli-usage.md", "docs/conformance-matrix.md"]) {
        expect(text, `${file} -> ${target}`).toContain(`](${target})`);
      }
    }
    const index = read("docs/README.md");
    for (const target of ["author.md", "cli-usage.md", "conformance-matrix.md"]) {
      expect(index, `docs/README.md -> ${target}`).toContain(`](${target})`);
    }
  });
});
