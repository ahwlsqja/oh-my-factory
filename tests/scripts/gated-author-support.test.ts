import { mkdirSync, readFileSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCredential } from "../../src/implementer/credential.js";
import {
  documentHoldsCredential,
  filesHoldingCredential,
  holdsCredentialText,
  tempFilesHoldingCredential,
} from "../gated/author-support.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { tokenize } from "../helpers/code-tokens.js";
import { realTempDir } from "../helpers/ops-fixture.js";

// The scans behind G-author-canary are run on planted keys here, because the suite itself needs a daemon and a real key. A scan
// that has never found anything is not evidence that nothing leaked, so each one is shown to find a planted key first.

const PLAIN = "sk-codex-plain-0123456789";
// A printable key with a quote and a backslash: JSON writes it as sk-q\"b\\c-0123456789.
const AWKWARD = 'sk-q"b\\c-0123456789';
const credential = (value: string) => {
  const c = readCredential("codex", { OMF_AUTHOR_API_KEY: value });
  if (c === null) throw new Error("the test key must be readable");
  return c;
};

describe("holdsCredentialText", () => {
  it("finds the key as given, in a string and in bytes, and finds nothing in clean text", () => {
    expect(holdsCredentialText(`a ${PLAIN} b`, credential(PLAIN))).toBe(true);
    expect(holdsCredentialText(Buffer.from(`a ${PLAIN} b`), credential(PLAIN))).toBe(true);
    expect(holdsCredentialText("nothing here", credential(PLAIN))).toBe(false);
  });

  it("finds a key with a quote or a backslash in the form JSON writes it", () => {
    const written = JSON.stringify({ k: AWKWARD });
    expect(written).not.toContain(AWKWARD);
    expect(holdsCredentialText(written, credential(AWKWARD))).toBe(true);
    expect(holdsCredentialText(Buffer.from(written), credential(AWKWARD))).toBe(true);
    expect(holdsCredentialText(`raw ${AWKWARD}`, credential(AWKWARD))).toBe(true);
  });
});

describe("documentHoldsCredential", () => {
  it("walks nested objects, arrays and object keys", () => {
    const key = credential(AWKWARD);
    expect(documentHoldsCredential({ a: [{ b: { c: `x ${AWKWARD}` } }] }, key)).toBe(true);
    expect(documentHoldsCredential([[`${AWKWARD}`]], key)).toBe(true);
    expect(documentHoldsCredential({ [AWKWARD]: 1 }, key)).toBe(true);
    expect(documentHoldsCredential({ a: [1, null, true, { b: "clean" }] }, key)).toBe(false);
    expect(documentHoldsCredential(null, key)).toBe(false);
    expect(documentHoldsCredential(JSON.parse(JSON.stringify([{ Env: [`K=${AWKWARD}`] }])), key)).toBe(true);
  });
});

describe("filesHoldingCredential", () => {
  it("finds a planted key in a nested file, also when the file is JSON, and returns relative sorted paths", () => {
    const root = realTempDir("omf-scan-");
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/b/leak.txt"), `x ${PLAIN} y`);
    writeFileSync(join(root, "ledger.jsonl"), `${JSON.stringify({ k: AWKWARD })}\n`);
    writeFileSync(join(root, "clean.txt"), "nothing");
    expect(filesHoldingCredential(root, credential(PLAIN))).toEqual(["a/b/leak.txt"]);
    expect(filesHoldingCredential(root, credential(AWKWARD))).toEqual(["ledger.jsonl"]);
  });

  it("follows a symlink to a file and to a directory outside the root, and survives a link loop", () => {
    const root = realTempDir("omf-scan-");
    const outside = realTempDir("omf-scan-out-");
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir/leak.txt"), PLAIN);
    writeFileSync(join(outside, "file.txt"), PLAIN);
    symlinkSync(join(outside, "file.txt"), join(root, "link-file"));
    symlinkSync(join(outside, "dir"), join(root, "link-dir"));
    symlinkSync(root, join(root, "loop"));
    writeFileSync(join(root, "own.txt"), PLAIN);
    // Exactly once each: the loop leads back to a real path already visited, so it adds no second copy of own.txt.
    expect(filesHoldingCredential(root, credential(PLAIN))).toEqual(["link-dir/leak.txt", "link-file", "own.txt"]);
  });

  it("does not read a file above the size limit (a sparse 65 MiB file), and still reads a small one", () => {
    const root = realTempDir("omf-scan-");
    writeFileSync(join(root, "big.bin"), PLAIN);
    truncateSync(join(root, "big.bin"), 65 * 1024 * 1024);
    writeFileSync(join(root, "small.txt"), PLAIN);
    expect(filesHoldingCredential(root, credential(PLAIN))).toEqual(["small.txt"]);
  });

  it("returns nothing for a clean tree and for a root that does not exist", () => {
    const root = realTempDir("omf-scan-");
    writeFileSync(join(root, "a.txt"), "clean");
    expect(filesHoldingCredential(root, credential(PLAIN))).toEqual([]);
    expect(filesHoldingCredential(join(root, "missing"), credential(PLAIN))).toEqual([]);
  });
});

describe("tempFilesHoldingCredential", () => {
  it("finds a key written to a fresh temp entry (a temporary CODEX_HOME) and ignores older entries", () => {
    const tmp = realTempDir("omf-tmp-scan-");
    mkdirSync(join(tmp, "codex-home-new/.codex"), { recursive: true });
    writeFileSync(join(tmp, "codex-home-new/.codex/auth.json"), JSON.stringify({ key: PLAIN }));
    writeFileSync(join(tmp, "stray.txt"), PLAIN);
    mkdirSync(join(tmp, "old-home"));
    writeFileSync(join(tmp, "old-home/auth.json"), PLAIN);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(tmp, "old-home"), past, past);
    const since = Date.now() - 60_000;
    expect(tempFilesHoldingCredential(tmp, since, credential(PLAIN))).toEqual([
      "codex-home-new/.codex/auth.json",
      "stray.txt",
    ]);
  });
});

describe("the canary needles", () => {
  it.each([
    CANARY.reading,
    CANARY.nextReading,
    CANARY.target,
    CANARY.metricId,
    ...CANARY.metricWords,
    CANARY.watchedPath,
    CANARY.watchedStem,
  ])("canaryHits finds %s inside surrounding text", (value) => {
    expect(canaryHits(`prefix ${value} suffix`)).not.toEqual([]);
  });

  it("canaryHits finds the integer stem as a whole token and not inside a hex id", () => {
    expect(canaryHits("value 4817 here")).not.toEqual([]);
    expect(canaryHits("deadbeef4817cafe")).toEqual([]);
  });
});

describe("G-author-canary uses these scans", () => {
  const src = readFileSync(new URL("../gated/author-canary.test.ts", import.meta.url), "utf8");
  const tokens = tokenize(src);
  const calls = (name: string): number =>
    tokens.filter((t, i) => t.kind === "ident" && t.text === name && tokens[i + 1]?.text === "(").length;
  const scanned = (rootName: string): boolean =>
    tokens.some(
      (t, i) =>
        t.text === "filesHoldingCredential" &&
        tokens[i + 1]?.text === "(" &&
        tokens[i + 2]?.text === rootName &&
        tokens[i + 3]?.text === ",",
    );

  it("searches the answer, the inspect documents and the ledger with the escape-aware scans, never with a plain search", () => {
    expect(tokens.some((t) => t.kind === "ident" && t.text === "containsCredential")).toBe(false);
    expect(calls("holdsCredentialText")).toBe(1);
    expect(calls("documentHoldsCredential")).toBe(2);
  });

  it("scans OMF state, the repository, the home and the temp directory", () => {
    for (const root of ["location", "repo", "home"]) {
      if (root === "location") {
        expect(
          tokens.some(
            (t, i) =>
              t.text === "filesHoldingCredential" &&
              tokens[i + 2]?.text === "location" &&
              tokens[i + 4]?.text === "dir",
          ),
        ).toBe(true);
      } else expect(scanned(root), root).toBe(true);
    }
    expect(calls("tempFilesHoldingCredential")).toBe(1);
  });
});
