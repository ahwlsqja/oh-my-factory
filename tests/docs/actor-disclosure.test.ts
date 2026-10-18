import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A first-time reader must be told, next to the first command that records a person, that the configured Git email
// is shown in output and stored in local host state, and how to redact it before sharing.
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/** The text between the "Define and measure a goal" heading and the first "omf metric propose" console line. */
function beforeFirstProposal(readme: string, heading: string): string {
  const start = readme.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const end = readme.indexOf("$ omf metric propose", start);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
}

describe("actor identity disclosure", () => {
  it("English README explains source, storage, boundary and redaction before the first proposal", () => {
    const section = beforeFirstProposal(read("README.md"), "## Define and measure a goal");
    expect(section).toContain("git config user.email");
    expect(section).toContain("human:<email>");
    expect(section).toContain("ledger.jsonl");
    expect(section).toContain("~/.omf");
    expect(section).toMatch(/never sends it anywhere/i);
    expect(section).toMatch(/telemetry/i);
    expect(section).toMatch(/redact/i);
    expect(section).toContain("human:you@example.com");
  });

  it("Korean README says the same before the first proposal", () => {
    const section = beforeFirstProposal(read("README.ko.md"), "## 목표를 정하고 재기");
    expect(section).toContain("git config user.email");
    expect(section).toContain("human:<email>");
    expect(section).toContain("ledger.jsonl");
    expect(section).toContain("~/.omf");
    expect(section).toContain("텔레메트리");
    expect(section).toContain("가린");
    expect(section).toContain("human:you@example.com");
  });

  it("both READMEs name the stored places in the state layout", () => {
    for (const [path, marker] of [
      ["README.md", "## Where state lives"],
      ["README.ko.md", "## 상태가 저장되는 곳"],
    ] as const) {
      const text = read(path);
      const layout = text.slice(text.indexOf(marker));
      expect(layout, path).toContain("human:<email>");
    }
  });

  it("the documented source is what the code does: git config user.email, GIT_* ignored", async () => {
    const { humanActor } = await import("../../src/core/actor.js");
    const { makeTempDir } = await import("../helpers/tmp.js");
    const repo = makeTempDir("omf-actor-doc-");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "dev@example.com"]);
    expect(humanActor(repo, { PATH: process.env.PATH, GIT_AUTHOR_EMAIL: "other@example.com" })).toBe(
      "human:dev@example.com",
    );
  });

  it("tracked text files carry only fictional email addresses", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: new URL(ROOT).pathname,
      encoding: "utf8",
    })
      .split("\0")
      .filter((f) => f.length > 0);
    const email = /[A-Za-z0-9._+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+/g;
    const fictionalDomain = /^example\.(?:com|org|net|invalid)$/i;
    // name@1.2.3 or name@1.2.3-beta.1: a package version, never a mailbox.
    const packageVersion = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
    const found: string[] = [];
    for (const file of files) {
      const buffer = readFileSync(new URL(file, ROOT));
      if (buffer.includes(0)) continue; // binary
      const text = buffer.toString("utf8");
      for (const match of text.matchAll(email)) {
        const address = match[0];
        const domain = address.slice(address.indexOf("@") + 1);
        if (fictionalDomain.test(domain) || packageVersion.test(domain)) continue;
        found.push(`${file}: ${address}`);
      }
    }
    expect(found).toEqual([]);
  });
});
