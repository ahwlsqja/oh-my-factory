declare const pinnedImageBrand: unique symbol;

/**
 * `name@sha256:<64 lowercase hex>`: no whitespace, no control character, not starting with "-" or ".", at most 255
 * characters. Only `pinnedImage` mints one, so a function that takes a `PinnedImage` cannot be handed a tag by
 * mistake. The digest is what makes the image immutable; a tag can be re-pointed after a person approved it.
 */
export type PinnedImage = string & { readonly [pinnedImageBrand]: true };

/**
 * `image_invalid`: not an image reference at all (empty, too long, whitespace or control characters, or a first
 * character docker would read as an option or a path). `image_not_pinned`: a well formed reference without a full
 * lowercase sha256 digest.
 */
export type ImageRefCode = "image_invalid" | "image_not_pinned";

/** The message is the code and nothing else: a refused reference is untrusted text and is never echoed back. */
export class ImageRefError extends Error {
  constructor(readonly code: ImageRefCode) {
    super(code);
    this.name = "ImageRefError";
  }
}

const MAX_REF_LENGTH = 255;
/** Printable ASCII without space: "!" (0x21) to "~" (0x7e). */
const PRINTABLE = /^[!-~]+$/;
/** A name of printable characters except "@" (0x40), then the digest. */
const PINNED = /^[!-?A-~]+@sha256:[0-9a-f]{64}$/;

function classify(ref: string): ImageRefCode | null {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH || !PRINTABLE.test(ref)) return "image_invalid";
  if (ref.startsWith("-") || ref.startsWith(".")) return "image_invalid";
  return PINNED.test(ref) ? null : "image_not_pinned";
}

export function isDigestPinned(ref: string): boolean {
  return classify(ref) === null;
}

/** Throws `ImageRefError` unless `ref` is `name@sha256:<64 lowercase hex>`. */
export function pinnedImage(ref: string): PinnedImage {
  const code = classify(ref);
  if (code !== null) throw new ImageRefError(code);
  return ref as PinnedImage;
}

/** `sha256:<64 hex>`: the part after the last "@". */
export function digestOf(ref: PinnedImage): string {
  return ref.slice(ref.lastIndexOf("@") + 1);
}
