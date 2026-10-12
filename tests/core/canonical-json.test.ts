import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../src/core/canonical-json.js";

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });

  it("omits object fields whose value is undefined", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
  });

  it("rejects undefined at the top level and inside arrays", () => {
    expect(() => canonicalize(undefined)).toThrow(TypeError);
    expect(() => canonicalize([1, undefined])).toThrow(TypeError);
  });
});

describe("sha256Hex", () => {
  it("returns the lowercase hex digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
