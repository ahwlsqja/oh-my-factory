import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";

const valid = {
  schema_version: 1,
  seq: 1,
  prev_hash: "0".repeat(64),
  ts: "2026-10-12T00:00:00.000Z",
  actor: "omf",
  type: "project.initialized",
  payload: {},
  hash: "a".repeat(64),
};

describe("ledger-event schema", () => {
  it("accepts a well-formed event", () => {
    expect(validate("ledger-event.schema.json", valid)).toEqual({ ok: true });
  });

  it("accepts human and agent actors", () => {
    expect(validate("ledger-event.schema.json", { ...valid, actor: "human:dev@example.com" }).ok).toBe(true);
    expect(validate("ledger-event.schema.json", { ...valid, actor: "agent:codex" }).ok).toBe(true);
  });

  it("rejects a missing field", () => {
    const { hash: _hash, ...missing } = valid;
    const result = validate("ledger-event.schema.json", missing);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors).toMatch(/must have required property 'hash'/);
  });

  it("rejects an unknown actor form", () => {
    expect(validate("ledger-event.schema.json", { ...valid, actor: "robot" }).ok).toBe(false);
  });

  it("rejects an extra property", () => {
    expect(validate("ledger-event.schema.json", { ...valid, extra: 1 }).ok).toBe(false);
  });

  it("rejects a malformed type", () => {
    expect(validate("ledger-event.schema.json", { ...valid, type: "Initialized" }).ok).toBe(false);
  });
});
