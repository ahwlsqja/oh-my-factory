import { describe, expect, it } from "vitest";
import { enclosed, splitArgs, tokenize } from "../helpers/code-tokens.js";

const texts = (src: string): string[] => tokenize(src).map((t) => `${t.kind}:${t.text}`);

describe("code tokenizer (the base of the gated-suite lints)", () => {
  it("drops line and block comments but keeps code around them", () => {
    expect(texts("a // expect(\n/* console.log(x) */ b")).toEqual(["ident:a", "ident:b"]);
  });

  it("keeps a string or a template as one token, so its text is never an identifier", () => {
    expect(texts(`x("expect(", 'console', \`a\${b}c\`)`)).toEqual([
      "ident:x",
      "punct:(",
      "string:expect(",
      "punct:,",
      "string:console",
      "punct:,",
      "template:a${b}c",
      "punct:)",
    ]);
    expect(tokenize("`a${b}`")[0]?.dynamic).toBe(true);
    expect(tokenize("`ab`")[0]?.dynamic).toBe(false);
  });

  it("reads escapes, nested templates and regexes with quotes without losing the rest", () => {
    const tick = "`";
    const src = `a("q\\"x"); y = /["']/.test(b); ${tick}o\${${tick}i\${c}${tick}}${tick} d`;
    expect(texts(src).slice(-2)).toEqual(["template:o${`i${c}`}", "ident:d"]);
    expect(texts("a / b / c")).toEqual(["ident:a", "punct:/", "ident:b", "punct:/", "ident:c"]);
  });

  it("splits call arguments at top-level commas only, and drops a trailing comma", () => {
    const tokens = tokenize('f(g(1, 2), [3, 4], "m",)');
    const { inner } = enclosed(tokens, 1);
    const args = splitArgs(inner);
    expect(args.map((a) => a.map((t) => t.text).join(""))).toEqual(["g(1,2)", "[3,4]", "m"]);
  });

  it("refuses unterminated input instead of guessing", () => {
    expect(() => tokenize('"abc')).toThrow();
    expect(() => tokenize("/* abc")).toThrow();
    expect(() => tokenize("`abc")).toThrow();
    expect(() => enclosed(tokenize("f(a"), 1)).toThrow();
  });
});
