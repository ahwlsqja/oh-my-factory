import { describe, expect, it } from "vitest";
import {
  ImageRefError,
  type ImageRefCode,
  digestOf,
  isDigestPinned,
  pinnedImage,
} from "../../src/container/image-ref.js";

const D = "a".repeat(64);

function refuse(ref: string): ImageRefError {
  try {
    pinnedImage(ref);
  } catch (err) {
    if (err instanceof ImageRefError) return err;
    throw err;
  }
  throw new Error(`pinnedImage accepted ${JSON.stringify(ref)}`);
}

describe("pinnedImage", () => {
  it.each([
    `alpine@sha256:${D}`,
    `registry.example.com:5000/team/app@sha256:${D}`,
    `node@sha256:${"0123456789abcdef".repeat(4)}`,
    // 255 characters is the limit for the whole reference: 183 name characters plus "@sha256:" plus 64 digits.
    `${"a".repeat(183)}@sha256:${D}`,
  ])("accepts %s", (ref) => {
    expect(pinnedImage(ref)).toBe(ref);
    expect(isDigestPinned(ref)).toBe(true);
    expect(digestOf(pinnedImage(ref))).toBe(`sha256:${ref.slice(-64)}`);
  });

  const refused: [string, string, ImageRefCode][] = [
    ["a tag", "alpine:3.20", "image_not_pinned"],
    ["no tag and no digest", "alpine", "image_not_pinned"],
    ["a short digest", `alpine@sha256:${"a".repeat(63)}`, "image_not_pinned"],
    ["an uppercase digest", `alpine@sha256:${"A".repeat(64)}`, "image_not_pinned"],
    ["another algorithm", `alpine@sha512:${D}`, "image_not_pinned"],
    ["a leading dash", `-v@sha256:${D}`, "image_invalid"],
    ["a leading dot", `.hidden@sha256:${D}`, "image_invalid"],
    ["whitespace", `al pine@sha256:${D}`, "image_invalid"],
    ["a trailing newline", `alpine@sha256:${D}\n`, "image_invalid"],
    ["an empty string", "", "image_invalid"],
    ["a 256 character name", `${"a".repeat(256)}@sha256:${D}`, "image_invalid"],
    ["a reference one character over 255", `${"a".repeat(184)}@sha256:${D}`, "image_invalid"],
  ];

  it.each(refused)("refuses %s with a message that is only the code", (_name, ref, code) => {
    const err = refuse(ref);
    expect(err.code).toBe(code);
    expect(err.message).toBe(code);
    expect(isDigestPinned(ref)).toBe(false);
  });
});

describe("PinnedImage as a parameter type", () => {
  it("is not satisfied by a plain string (tsc checks this; the function is never called)", () => {
    const never = (): string =>
      // @ts-expect-error a plain string is not a PinnedImage; only pinnedImage can mint one
      digestOf(`alpine@sha256:${D}`);
    expect(typeof never).toBe("function");
  });
});
