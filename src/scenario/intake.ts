import { createHash, randomBytes } from "node:crypto";
import { parseAllDocuments } from "yaml";
import type { Document } from "yaml";
import { canonicalize } from "../core/canonical-json.js";
import { validateDef } from "../core/schema.js";
import { compileJsonPath, compilePattern } from "./matcher.js";
import { MAX_AUTHOR_OUTPUT_BYTES, MAX_SCENARIO_BYTES, MAX_SCENARIOS_PER_SET } from "./types.js";
import type {
  AuthorStamp,
  JsonScalar,
  ScenarioKind,
  ScenarioSplit,
  ScenarioStep,
  StdoutMatch,
  StoredKind,
  StoredScenario,
} from "./types.js";

/** Identity comes from OMF, never from the author; tests inject fixed ids. */
export interface Ids {
  scenarioId(): string;
  canary(): string;
  sealId(): string;
}

/** `s-<32 hex>`, `omf-canary-<32 hex>` and `seal-<16 hex>` from the system's random source: unguessable by an author session. */
export function randomIds(): Ids {
  const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
  return {
    scenarioId: () => `s-${hex(16)}`,
    canary: () => `omf-canary-${hex(16)}`,
    sealId: () => `seal-${hex(8)}`,
  };
}

export const INTAKE_REJECTION_CODES = [
  "yaml_invalid",
  "schema_invalid",
  "too_large",
  "too_many",
  "http_not_supported",
  "nfr_not_supported",
  "pattern_unsupported",
  "json_path_unsupported",
  "expect_empty",
  "duplicate_document",
] as const;
export type IntakeRejectionCode = (typeof INTAKE_REJECTION_CODES)[number];

/** Keys the author may write but OMF owns: dropped and counted in `ignored_fields`. */
export const OMF_OWNED_KEYS = [
  "schema_version",
  "scenario_id",
  "work_id",
  "author",
  "canary",
  "exposure",
  "status",
] as const;

export interface IntakeContext {
  workId: string;
  author: AuthorStamp;
  ids: Ids;
}

export interface IntakeResult {
  stored: StoredScenario[];
  /** Counts only; no text of a rejected document is kept. */
  rejected: Record<IntakeRejectionCode, number>;
  /** Documents seen. */
  authored: number;
  ignored_fields: number;
}

interface AuthoredExpect {
  exit_code?: number | null;
  stdout_matches?: StdoutMatch | null;
  json_path?: Record<string, JsonScalar> | null;
  note?: string;
}
type AuthoredInvoke = { argv: string[]; stdin?: string } | { method: string; path: string; body?: string };
/** What `authored_scenario` in scenario.schema.json lets through; the OMF-owned keys are read only to be counted. */
interface AuthoredScenario {
  decision_refs?: string[];
  kind: ScenarioKind;
  split: ScenarioSplit;
  interface: "cli" | "http";
  steps: { invoke: AuthoredInvoke; expect: AuthoredExpect }[];
  nfr_probe?: unknown;
}
/** A validated scenario before stamping: the author's content with defaults filled in, notes still unprefixed. */
interface Body {
  decision_refs: string[];
  kind: StoredKind;
  split: ScenarioSplit;
  steps: ScenarioStep[];
}

/** Core schema (no timestamps or binary), duplicate keys are errors, and no alias is ever resolved (no entity expansion). */
const YAML_OPTIONS = { schema: "core", uniqueKeys: true, maxAliasCount: 0 } as const;

function plainValue(doc: Document.Parsed): { ok: true; value: unknown } | { ok: false } {
  if (doc.errors.length > 0) return { ok: false };
  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: 0 }) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * The refusals of v0.1, in a fixed order so one document always gets one code: nfr (M3-D17), http, an expectation that
 * checks nothing, a pattern or json_path our own matcher cannot compile. Returns the code, or the normalized body.
 */
function classify(doc: AuthoredScenario): IntakeRejectionCode | Body {
  const kind = doc.kind;
  if (kind === "nfr" || "nfr_probe" in doc) return "nfr_not_supported";
  const steps: ScenarioStep[] = [];
  for (const step of doc.steps) {
    if (doc.interface !== "cli" || !("argv" in step.invoke)) return "http_not_supported";
    const authored = step.expect;
    steps.push({
      invoke: { argv: step.invoke.argv, stdin: step.invoke.stdin ?? "" },
      expect: {
        exit_code: authored.exit_code ?? null,
        stdout_matches: authored.stdout_matches ?? null,
        json_path: authored.json_path ?? null,
        note: authored.note ?? "",
      },
    });
  }
  const expectations = steps.map((step) => step.expect);
  if (expectations.some((e) => e.exit_code === null && e.stdout_matches === null && e.json_path === null))
    return "expect_empty";
  if (expectations.some((e) => e.stdout_matches?.kind === "anchored" && !compilePattern(e.stdout_matches.pattern).ok)) {
    return "pattern_unsupported";
  }
  if (
    expectations.some((e) => e.json_path !== null && Object.keys(e.json_path).some((path) => !compileJsonPath(path).ok))
  ) {
    return "json_path_unsupported";
  }
  return { decision_refs: doc.decision_refs ?? [], kind, split: doc.split, steps };
}

/**
 * Adds everything OMF owns. The canary goes in the header and in front of every note, never in `invoke`. The result is
 * validated again: a failure here is OMF's own bug (a bad `Ids` or context), so it throws instead of dropping the scenario quietly.
 */
function stamp(body: Body, ctx: IntakeContext): StoredScenario {
  const canary = ctx.ids.canary();
  const stored: StoredScenario = {
    schema_version: 1,
    scenario_id: ctx.ids.scenarioId(),
    work_id: ctx.workId,
    author: { ...ctx.author },
    decision_refs: body.decision_refs,
    kind: body.kind,
    split: body.split,
    interface: "cli",
    steps: body.steps.map((step) => ({
      invoke: step.invoke,
      expect: { ...step.expect, note: step.expect.note === "" ? canary : `${canary} ${step.expect.note}` },
    })),
    canary,
  };
  const checked = validateDef("scenario.schema.json", "stored_scenario", stored);
  if (!checked.ok) throw new TypeError(`stamped scenario is not a stored_scenario: ${checked.errors}`);
  return stored;
}

/**
 * `output` is the author's stdout: a multi-document YAML stream of at most MAX_AUTHOR_OUTPUT_BYTES, each document at most
 * MAX_SCENARIO_BYTES, at most MAX_SCENARIOS_PER_SET kept (the rest are counted as `too_many` without being examined). Every
 * document gets exactly one outcome: stored, or one rejection code. Identity is drawn from `ctx.ids` only for scenarios that
 * survive. The input is never echoed in a count or an error.
 */
export function intakeAuthored(output: string, ctx: IntakeContext): IntakeResult {
  const result: IntakeResult = {
    stored: [],
    rejected: Object.fromEntries(INTAKE_REJECTION_CODES.map((code) => [code, 0])) as Record<
      IntakeRejectionCode,
      number
    >,
    authored: 0,
    ignored_fields: 0,
  };
  const reject = (code: IntakeRejectionCode): void => {
    result.rejected[code] += 1;
  };
  if (Buffer.byteLength(output, "utf8") > MAX_AUTHOR_OUTPUT_BYTES) {
    reject("too_large");
    return result;
  }
  let docs: Document.Parsed[];
  try {
    docs = parseAllDocuments(output, YAML_OPTIONS);
  } catch {
    reject("yaml_invalid");
    return result;
  }
  const seen = new Set<string>();
  for (const doc of docs) {
    result.authored += 1;
    if (result.stored.length >= MAX_SCENARIOS_PER_SET) {
      reject("too_many");
      continue;
    }
    if (Buffer.byteLength(output.slice(doc.range[0], doc.range[2]), "utf8") > MAX_SCENARIO_BYTES) {
      reject("too_large");
      continue;
    }
    const plain = plainValue(doc);
    if (!plain.ok) {
      reject("yaml_invalid");
      continue;
    }
    if (!validateDef("scenario.schema.json", "authored_scenario", plain.value).ok) {
      reject("schema_invalid");
      continue;
    }
    const authored = plain.value as AuthoredScenario;
    result.ignored_fields += OMF_OWNED_KEYS.filter((key) => Object.hasOwn(authored, key)).length;
    const body = classify(authored);
    if (typeof body === "string") {
      reject(body);
      continue;
    }
    const digest = createHash("sha256").update(canonicalize(body)).digest("hex");
    if (seen.has(digest)) {
      reject("duplicate_document");
      continue;
    }
    seen.add(digest);
    result.stored.push(stamp(body, ctx));
  }
  return result;
}
