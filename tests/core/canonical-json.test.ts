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

  it("rejects Date, Map and class instances", () => {
    class Point {
      constructor(public x: number) {}
    }
    expect(() => canonicalize(new Date(0))).toThrow(TypeError);
    expect(() => canonicalize(new Map([["a", 1]]))).toThrow(TypeError);
    expect(() => canonicalize(new Point(1))).toThrow(TypeError);
  });

  it("rejects function, symbol and bigint values inside an object", () => {
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalize({ s: Symbol("x") })).toThrow(TypeError);
    expect(() => canonicalize({ n: BigInt(1) })).toThrow(TypeError);
  });

  it("rejects a sparse array", () => {
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(() => canonicalize(sparse)).toThrow(TypeError);
  });

  it("canonicalizes -0 as 0", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it("sorts non-ASCII keys by UTF-16 code unit", () => {
    expect(canonicalize({ "é": 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"é":1}');
  });

  it("round-trips through JSON.parse(JSON.stringify(...))", () => {
    const x = { b: [1, { d: "ü", c: null }], a: true };
    expect(canonicalize(JSON.parse(JSON.stringify(x)))).toBe(canonicalize(x));
  });

  it("accepts objects without a prototype", () => {
    expect(canonicalize(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });
});

describe("sha256Hex", () => {
  it("returns the lowercase hex digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
