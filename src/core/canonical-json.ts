import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, undefined fields dropped.
 *
 * Only plain JSON data is accepted: null, booleans, finite numbers, strings,
 * arrays, and plain objects (prototype Object.prototype or null). Anything else
 * throws a TypeError, so a hash never differs from what is written to disk
 * (e.g. a Date would serialize as an ISO string, not as `{}`).
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("undefined is not representable in canonical JSON");
  }
  const kind = typeof value;
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    throw new TypeError(`${kind} is not representable in canonical JSON`);
  }
  if (value === null || kind !== "object") {
    if (kind === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number in canonical JSON: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new TypeError("sparse arrays are not representable in canonical JSON");
      }
      items.push(canonicalize(value[i]));
    }
    return `[${items.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("only plain objects are representable in canonical JSON");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/** Hex SHA-256. Strings are hashed as UTF-8; byte arrays are hashed as-is. */
export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  return typeof data === "string" ? hash.update(data, "utf8").digest("hex") : hash.update(data).digest("hex");
}
