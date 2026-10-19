import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertViolations,
  describeCalls,
  expectViolations,
  holdsRealKey,
  printViolations,
  skipIfArgument,
} from "../helpers/gated-lint.js";

// The suites that hold a real key may not hand anything to `expect`: a failing `expect` prints its argument, and the owner's
// command output enters the agent conversation. They assert through assertTrue and assertFalse, whose messages are fixed
// strings. The driver's redactor is the second line of defence, not the first. The scan covers every file in tests/gated, finds
// the model suites by what they do (they call a key reader) rather than by a list, and pins how many there are.
const GATED = new URL("../gated/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, GATED), "utf8");
const FILES = readdirSync(GATED)
  .filter((name) => name.endsWith(".ts"))
  .sort();
const SUITES = FILES.filter((name) => name.endsWith(".test.ts") && name !== "helpers.test.ts");
const SUPPORT = FILES.filter((name) => !name.endsWith(".test.ts"));
const MODEL = SUITES.filter((name) => holdsRealKey(read(name)));
// A suite is added to or removed from this list only on purpose: the lints below depend on it.
const MODEL_SUITES = [
  "author-canary.test.ts",
  "e6-l2-leak-redteam.test.ts",
  "implementer-real-run.test.ts",
  "skeleton-real.test.ts",
];
const ALL_SUITES = [
  "author-boundary-real.test.ts",
  "author-canary.test.ts",
  "e6-l2-leak-redteam.test.ts",
  "implementer-boundary-real.test.ts",
  "implementer-real-run.test.ts",
  "inspect-real.test.ts",
  "isolation-probe.test.ts",
  "skeleton-real.test.ts",
  "two-container-roundtrip.test.ts",
  "work-copy-real.test.ts",
];

describe("gated suites that hold a real key: what is scanned", () => {
  it("scans exactly the known suites, and the ones that call a key reader are exactly the four model suites", () => {
    expect(SUITES).toEqual(ALL_SUITES);
    expect(MODEL).toEqual(MODEL_SUITES);
  });

  it("every support file next to the suites is scanned too", () => {
    expect(SUPPORT).toEqual([
      "author-support.ts",
      "helpers.ts",
      "implementer-support.ts",
      "lifecycle-support.ts",
      "skeleton-kit.ts",
    ]);
  });
});

describe("gated suites that hold a real key: the lints", () => {
  it.each([...SUITES, ...SUPPORT])(
    "%s prints nothing, reads no key value and uses process only for env and pid",
    (name) => {
      expect(printViolations(read(name))).toEqual([]);
    },
  );

  it.each([...MODEL_SUITES, ...SUPPORT])("%s calls no expect", (name) => {
    expect(expectViolations(read(name))).toEqual([]);
  });

  it.each([...SUITES, ...SUPPORT])(
    "%s gives every assertTrue and assertFalse one fixed literal message and never aliases them",
    (name) => {
      expect(assertViolations(read(name))).toEqual([]);
    },
  );

  it("every model suite is a describeGatedModel suite and no other suite is", () => {
    for (const name of SUITES) {
      const calls = describeCalls(read(name));
      const model = MODEL_SUITES.includes(name);
      expect(calls.model > 0, name).toBe(model);
      expect(calls.gated > 0, name).toBe(!model);
    }
  });

  it("describeGated is skipped without the docker switch and describeGatedModel without the model switch", () => {
    const src = read("helpers.ts");
    expect(skipIfArgument(src, "describeGated")).toBe("!gatedEnabled()");
    expect(skipIfArgument(src, "describeGatedModel")).toBe("!gatedModelEnabled()");
  });
});

describe("gated suites that hold a real key: the lints catch what they claim to (positive controls)", () => {
  it.each([
    ["console.log(x)", "uses console"],
    ['console["log"](x)', "uses console"],
    ['process["stdout"].write(x)', "uses process other than env or pid"],
    ["process.stdout.write(x)", "uses process other than env or pid"],
    ["const { stdout } = process;", "uses process other than env or pid"],
    ["const p = process; p.stderr.write(x)", "uses process other than env or pid"],
    ["fs.writeSync(1, x)", "uses writeSync"],
    ["credential.reveal()", "uses reveal"],
    ['credential["reveal"]()', 'names "reveal" as a string'],
    ["const { reveal } = credential;", "uses reveal"],
  ])("printing: %s", (src, violation) => {
    expect(printViolations(src)).toContain(violation);
  });

  it("printing: comments, strings that are not a banned word, process.env and process.pid are fine", () => {
    expect(
      printViolations("// console.log(x)\n/* process.stdout */ const a = process.env.X + process.pid + 'ok';"),
    ).toEqual([]);
  });

  it.each([
    'import { expect as check } from "vitest"; check(1);',
    "expect(x).toBe(1)",
    "expect.soft(x).toBe(1)",
    "expect.poll(() => x)",
    "const e = expect; e(x)",
  ])("expect: %s", (src) => {
    expect(expectViolations(src)).not.toEqual([]);
  });

  it("expect: an object key named expect and a comment are fine", () => {
    expect(expectViolations("const a = { expect: 1 }; // expect(x)")).toEqual([]);
  });

  it.each([
    ["assertTrue(xs.some((v) => { return v; }), secret);", "assertTrue message is not a string literal"],
    ["assertTrue(ok, `a ${secret}`);", "assertTrue message is not a string literal"],
    ["assertFalse(ok, secret);", "assertFalse message is not a string literal"],
    ['assertFalse(ok, "a" + secret);', "assertFalse message is not a string literal"],
    ['assertTrue(ok, ok ? "a" : secret);', "assertTrue message is not a string literal"],
    ["assertTrue(ok);", "assertTrue message is not a string literal"],
    ["const t = assertTrue; t(ok, secret);", "assertTrue is not called directly"],
    ["[1].forEach(assertFalse);", "assertFalse is not called directly"],
  ])("assert: %s", (src, violation) => {
    expect(assertViolations(src)).toContain(violation);
  });

  it("assert: a plain literal, a template without substitution, a trailing comma, the declaration and the import are fine", () => {
    const src = [
      'import { assertFalse, assertTrue } from "./implementer-support.js";',
      "export function assertTrue(flag: boolean, message: string): void {}",
      'assertTrue(xs.some((v) => { return v; }), "fixed",);',
      "assertFalse(a, `fixed`);",
    ].join("\n");
    expect(assertViolations(src)).toEqual([]);
  });

  it("classification: a call of a key reader or a read of a key variable makes a suite a model suite; a definition or a comment does not", () => {
    expect(holdsRealKey("const c = gatedCredential();")).toBe(true);
    expect(holdsRealKey("const c = authorCredential();")).toBe(true);
    expect(holdsRealKey("const k = process.env.OMF_AUTHOR_API_KEY;")).toBe(true);
    expect(holdsRealKey('const k = process.env["OMF_IMPLEMENTER_API_KEY"];')).toBe(true);
    expect(holdsRealKey("export function gatedCredential() {}\n// gatedCredential()")).toBe(false);
    expect(holdsRealKey("const k = process.env.OMF_GATED;")).toBe(false);
  });

  it("describe calls: a mention in a comment or a string is not a call; a call is", () => {
    expect(
      describeCalls('// describeGatedModel("x", f)\nconst s = "describeGatedModel(";\ndescribeGated("a", f);'),
    ).toEqual({
      gated: 1,
      model: 0,
    });
    expect(describeCalls('describeGatedModel("a", f);')).toEqual({ gated: 0, model: 1 });
  });

  it("skipIf argument: reads the condition of the named function only", () => {
    const src =
      "export function describeGated(n, b) { describe.skipIf(!gatedEnabled())(n, () => {}); }\nexport function describeGatedModel(n, b) { describe.skipIf(!gatedEnabled())(n, () => {}); }";
    expect(skipIfArgument(src, "describeGatedModel")).toBe("!gatedEnabled()");
    expect(skipIfArgument(src, "missing")).toBeNull();
  });
});
