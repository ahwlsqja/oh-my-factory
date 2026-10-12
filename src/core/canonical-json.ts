import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, undefined fields dropped.
 * The ledger hashes this form, so the same event always has the same hash.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("undefined is not representable in canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number in canonical JSON: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
