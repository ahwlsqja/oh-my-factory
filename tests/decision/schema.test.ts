import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaUrl, validateDef } from "../../src/core/schema.js";
import {
  DECISION_CLASSES,
  DECISION_ID_PATTERN,
  INTERFACE_DECISION_ID,
  QUANTITATIVE_CLASSES,
  isQuantitative,
  judgeConfigSha256,
} from "../../src/decision/types.js";
import type { InterfaceContract } from "../../src/decision/types.js";

const FILE = "decision.schema.json";

interface Def {
  required?: string[];
  pattern?: string;
}
const schema = JSON.parse(readFileSync(schemaUrl(FILE), "utf8")) as { $defs: Record<string, Def> };

const scope = { goal_id: "g-hello", work_id: "w-0123456789ab" };
const argv = ["node", "dist/cli.js"];
const qas = {
  source: "a user",
  stimulus: "runs the command",
  environment: "normal load",
  artifact: "the command line tool",
  response: "prints a greeting",
};
const measure = { metric: "request latency", op: "<=", threshold: 250, unit: "ms", percentile: 95, window: "7d" };
const contract: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/cli.js"],
  io_contract: "reads stdin, writes stdout",
  gates: { fast: ["npm", "run", "lint"], full: ["npm", "test"], deep: null, required: ["fast", "full"] },
  test_command: ["npm", "test"],
};
const resolution = {
  choice: "Use a queue",
  rationale: "Bursts must not drop work",
  rejected: ["Drop on overflow"],
  by: "human:dev@example.com",
  at: "2026-10-12T00:00:00.000Z",
};
const deferral = {
  owner: "dev@example.com",
  reason: "Needs a load test first",
  revisit_trigger: "after the load test",
  default: "Use a bounded queue of 100",
  signed_by: "human:dev@example.com",
  expires_at: "2026-11-12T00:00:00Z",
};
const reason = { code: "required_open", decision_id: "d-latency" };

/** One valid document per definition under test. */
const fixtures: Record<string, Record<string, unknown>> = {
  qas,
  response_measure: measure,
  interface_contract: contract as unknown as Record<string, unknown>,
  add_input: { id: "d-latency", class: "latency", question: "How fast must it answer?", qas, response_measure: measure },
  resolve_input: {
    choice: "Use a queue",
    rationale: "Bursts must not drop work",
    rejected: ["Drop on overflow"],
    response_measure: measure,
    interface: contract,
  },
  defer_input: {
    owner: "dev@example.com",
    reason: "Needs a load test first",
    revisit_trigger: "after the load test",
    default: "Use a bounded queue of 100",
    expires_at: "2026-11-12T00:00:00Z",
  },
  na_input: { rationale: "This tool has no network surface" },
  ev_added: { ...scope, decision_id: "d-latency", class: "latency", question: "How fast?", qas, response_measure: measure },
  ev_resolved: { ...scope, decision_id: "d-latency", resolution, response_measure: measure, interface: contract },
  ev_deferred: { ...scope, decision_id: "d-latency", deferral },
  ev_marked_na: {
    ...scope,
    decision_id: "d-security",
    rationale: "No network surface",
    by: "human:dev@example.com",
    at: "2026-10-12T00:00:00.000Z",
  },
  ev_rejected: { ...scope, decision_id: "d-latency", op: "add", findings: [{ rule: "metric-name", field: "question" }] },
  needs_human: {
    schema_version: 1,
    id: "nh-0123456789ab",
    j: "J2",
    ...scope,
    question: "2 design decisions need a person.",
    options: ["omf decide resolve w-0123456789ab d-latency --file <resolution.json>"],
    default: null,
    resume_token: "0123456789abcdef0123456789abcdef",
    reasons: [reason],
    created_at: "2026-10-12T00:00:00.000Z",
  },
};

const check = (def: string, data: unknown) => validateDef(FILE, def, data);

describe("decision.schema.json", () => {
  it("compiles under strict ajv and accepts a valid document for every definition", () => {
    const failures = Object.entries(fixtures)
      .map(([def, doc]) => ({ def, result: check(def, doc) }))
      .filter(({ result }) => !result.ok)
      .map(({ def, result }) => `${def}: ${result.ok ? "" : result.errors}`);
    expect(failures).toEqual([]);
  });

  it("rejects control, line-separator and bidi characters in free text and argv", () => {
    const bad = ["a\u001b[8mb", "a\nb", "a\u202Eb", "a\u2066b", "a\u2028b"];
    for (const text of bad) {
      expect(check("add_input", { ...fixtures.add_input, question: text }).ok).toBe(false);
      expect(check("resolve_input", { ...fixtures.resolve_input, rationale: text }).ok).toBe(false);
      expect(check("resolve_input", { ...fixtures.resolve_input, rejected: [text] }).ok).toBe(false);
      expect(check("defer_input", { ...fixtures.defer_input, reason: text }).ok).toBe(false);
      expect(check("argv", ["npm", text]).ok).toBe(false);
      expect(check("argv", ["npm", "test"]).ok).toBe(true);
    }
  });

  it("rejects a document that lacks any required field", () => {
    const failures: string[] = [];
    for (const [def, doc] of Object.entries(fixtures)) {
      for (const key of schema.$defs[def]?.required ?? []) {
        const { [key]: _removed, ...rest } = doc;
        const result = check(def, rest);
        if (result.ok || !result.errors.includes(`must have required property '${key}'`)) failures.push(`${def}.${key}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("rejects an extra key in every definition", () => {
    const failures = Object.entries(fixtures)
      .filter(([def, doc]) => check(def, { ...doc, extra: 1 }).ok)
      .map(([def]) => def);
    expect(failures).toEqual([]);
  });

  it("writes every nullable field as anyOf with null, and accepts null only where declared", () => {
    const walk = (node: unknown, hits: string[]): string[] => {
      if (Array.isArray(node)) node.forEach((item) => walk(item, hits));
      else if (typeof node === "object" && node !== null) {
        const record = node as Record<string, unknown>;
        if (Array.isArray(record.type)) hits.push(JSON.stringify(record.type));
        Object.values(record).forEach((value) => walk(value, hits));
      }
      return hits;
    };
    expect(walk(schema, [])).toEqual([]);

    expect(check("response_measure", { ...measure, percentile: null, window: null }).ok).toBe(true);
    expect(check("response_measure", { ...measure, percentile: undefined }).ok).toBe(false);
    expect(check("response_measure", { ...measure, window: 7 }).ok).toBe(false);
    const nullGates = { ...contract.gates, fast: null, full: null, deep: null };
    expect(check("interface_contract", { ...contract, gates: nullGates }).ok).toBe(true);
    expect(check("interface_contract", { ...contract, run: null }).ok).toBe(false);
  });

  it("requires a finite numeric threshold, a known operator and a percentile in 0..100", () => {
    for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, "250", null]) {
      expect(check("response_measure", { ...measure, threshold }).ok).toBe(false);
    }
    expect(check("response_measure", { ...measure, op: "!=" }).ok).toBe(false);
    expect(check("response_measure", { ...measure, percentile: 101 }).ok).toBe(false);
    expect(check("response_measure", { ...measure, percentile: 0 }).ok).toBe(true);
  });

  it("accepts only d-<slug> decision ids, and the constants agree with the schema", () => {
    expect(schema.$defs.decision_id?.pattern).toBe(DECISION_ID_PATTERN.source);
    const add = (id: string) => check("add_input", { id, class: "other", question: "q" }).ok;
    for (const id of [INTERFACE_DECISION_ID, "d-intent-q1", "d-a-b", "d-1"]) expect(add(id)).toBe(true);
    for (const id of ["D-x", "d-", "d--a", "x-1", "d-a_b", `d-${"a".repeat(79)}`]) expect(add(id)).toBe(false);
  });

  it("keeps the class enum in step with DECISION_CLASSES", () => {
    const add = (cls: string) => check("add_input", { id: "d-x", class: cls, question: "q" }).ok;
    expect(DECISION_CLASSES.filter((cls) => !add(cls))).toEqual([]);
    expect(add("bogus")).toBe(false);
  });

  it("rejects empty argv, an empty argv element, a NUL byte, and an unusable required list", () => {
    const withContract = (patch: object) => check("interface_contract", { ...contract, ...patch }).ok;
    expect(withContract({ build: [] })).toBe(false);
    expect(withContract({ run: ["node", ""] })).toBe(false);
    expect(withContract({ test_command: ["npm\u0000", "test"] })).toBe(false);
    const withGates = (patch: object) => withContract({ gates: { ...contract.gates, ...patch } });
    expect(withGates({ required: [] })).toBe(false);
    expect(withGates({ required: ["fast", "fast"] })).toBe(false);
    expect(withGates({ required: ["slow"] })).toBe(false);
    expect(withGates({ fast: [] })).toBe(false);
  });

  it("pins needs_human.default to null", () => {
    const base = fixtures.needs_human as Record<string, unknown>;
    expect(check("needs_human", { ...base, default: "Use a queue" }).ok).toBe(false);
    expect(check("needs_human", { ...base, default: false }).ok).toBe(false);
    const { default: _removed, ...without } = base;
    expect(check("needs_human", without).ok).toBe(false);
  });

  it("makes decision.rejected carry exactly one of decision_id and decision_id_sha12", () => {
    const base = fixtures.ev_rejected as Record<string, unknown>;
    const { decision_id: _id, ...noId } = base;
    expect(check("ev_rejected", { ...noId, decision_id_sha12: "0123456789ab" }).ok).toBe(true);
    expect(check("ev_rejected", noId).ok).toBe(false);
    expect(check("ev_rejected", { ...base, decision_id_sha12: "0123456789ab" }).ok).toBe(false);
    expect(check("ev_rejected", { ...base, findings: [{ rule: "metric-name", field: "q", text: "leak" }] }).ok).toBe(false);
  });
});

describe("decision types", () => {
  it("partitions the classes into quantitative and not", () => {
    expect(DECISION_CLASSES.filter(isQuantitative)).toEqual([...QUANTITATIVE_CLASSES]);
    expect(DECISION_CLASSES.filter((cls) => !isQuantitative(cls))).toEqual([
      "interface",
      "compatibility",
      "data_model",
      "error_semantics",
      "security",
      "other",
    ]);
  });

  it("hashes the judge config the same regardless of key order or required order", () => {
    const reordered = JSON.parse(
      `{"test_command":["npm","test"],"gates":{"required":["full","fast"],"deep":null,"full":["npm","test"],"fast":["npm","run","lint"]},` +
        `"io_contract":"x","run":["a"],"build":["b"],"kind":"http"}`,
    ) as InterfaceContract;
    expect(judgeConfigSha256(reordered)).toBe(judgeConfigSha256(contract));
    expect(judgeConfigSha256(contract)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the digest when a gate, a requirement or test_command changes", () => {
    const base = judgeConfigSha256(contract);
    const variants: InterfaceContract[] = [
      { ...contract, gates: { ...contract.gates, fast: ["npm", "run", "lint:strict"] } },
      { ...contract, gates: { ...contract.gates, deep: ["npm", "run", "e2e"] } },
      { ...contract, gates: { ...contract.gates, required: ["fast"] } },
      { ...contract, test_command: ["npm", "run", "test:all"] },
    ];
    expect(variants.filter((variant) => judgeConfigSha256(variant) === base)).toEqual([]);
  });

  it("ignores build, run, kind and io_contract, which are not part of the judge config", () => {
    const other = { ...contract, kind: "http", build: ["make"], run: ["./app"], io_contract: "changed" } as InterfaceContract;
    expect(judgeConfigSha256(other)).toBe(judgeConfigSha256(contract));
  });
});
