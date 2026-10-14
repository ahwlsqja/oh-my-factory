import { GATE_NAMES, type GateName } from "../decision/types.js";

export const GATE_LINE_PREFIX = "OMF_GATES:";
export const GATE_LINE_VALUES = ["pass", "fail", "skip", "empty"] as const;
export type GateLineValue = (typeof GATE_LINE_VALUES)[number];
export type GateLineValues = Record<GateName, GateLineValue>;

/** `OMF_GATES: fast=pass full=pass deep=skip`; always the three gates in the order fast, full, deep. */
export function formatGateLine(values: GateLineValues): string {
  return `${GATE_LINE_PREFIX} ${GATE_NAMES.map((name) => `${name}=${values[name]}`).join(" ")}`;
}

export type GateLineParse =
  | { kind: "ok"; values: GateLineValues }
  | { kind: "absent" }
  | { kind: "duplicated"; count: number }
  | { kind: "malformed"; reason: "bad_syntax" | "unknown_gate" | "missing_gate" | "duplicate_gate" | "unknown_value" | "out_of_order" };

type Malformed = Extract<GateLineParse, { kind: "malformed" }>;
const malformed = (reason: Malformed["reason"]): Malformed => ({ kind: "malformed", reason });

const PAIR = /^[^\s=]+=[^\s=]+$/;

function parseCandidate(line: string): GateLineParse {
  const rest = line.slice(GATE_LINE_PREFIX.length);
  if (!rest.startsWith(" ")) return malformed("bad_syntax");
  const parts = rest.slice(1).split(" ");
  if (!parts.every((part) => PAIR.test(part))) return malformed("bad_syntax");
  const pairs = parts.map((part) => part.split("=") as [string, string]);
  const names: readonly string[] = GATE_NAMES;
  if (pairs.some(([key]) => !names.includes(key))) return malformed("unknown_gate");
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) return malformed("duplicate_gate");
  const known: readonly string[] = GATE_LINE_VALUES;
  if (pairs.some(([, value]) => !known.includes(value))) return malformed("unknown_value");
  if (pairs.length !== GATE_NAMES.length) return malformed("missing_gate");
  if (pairs.some(([key], index) => key !== GATE_NAMES[index])) return malformed("out_of_order");
  return { kind: "ok", values: Object.fromEntries(pairs) as GateLineValues };
}

/**
 * Lines that start with the prefix are candidates; exactly one is allowed; the grammar is strict (single spaces, three
 * keys in fixed order, no tab, no CR). OMF writes the line itself (M3e-D3), so a deviation is an anomaly, not a dialect.
 */
export function parseGateLine(text: string): GateLineParse {
  const candidates = text.split("\n").filter((line) => line.startsWith(GATE_LINE_PREFIX));
  if (candidates.length === 0) return { kind: "absent" };
  if (candidates.length > 1) return { kind: "duplicated", count: candidates.length };
  return parseCandidate(candidates[0] as string);
}

export type GateLineStatus = "GREEN" | "RED" | "MISCONFIGURED";
export const MISCONFIGURED_REASONS = ["line_absent", "line_duplicated", "line_malformed", "required_skipped", "required_empty", "no_required_gates"] as const;
export type MisconfiguredReason = (typeof MISCONFIGURED_REASONS)[number];
export interface GateLineVerdict {
  status: GateLineStatus;
  line: string | null;
  failing: GateName[];
  misconfigured: GateName[];
  reasons: MisconfiguredReason[];
}

/**
 * MISCONFIGURED wins over RED (gates.sh:221-227). A required gate that is skip or empty is misconfigured; any gate that fails
 * is failing (required or not); `required = []` is `no_required_gates`. A line that is absent, duplicated or malformed names
 * every required gate as unevidenced. `reasons` come in the order of MISCONFIGURED_REASONS.
 */
export function evaluateGateLine(parse: GateLineParse, required: readonly GateName[]): GateLineVerdict {
  const needed = GATE_NAMES.filter((name) => required.includes(name));
  const reasons = new Set<MisconfiguredReason>();
  if (needed.length === 0) reasons.add("no_required_gates");
  const ordered = (): MisconfiguredReason[] => MISCONFIGURED_REASONS.filter((reason) => reasons.has(reason));

  if (parse.kind !== "ok") {
    reasons.add(parse.kind === "absent" ? "line_absent" : parse.kind === "duplicated" ? "line_duplicated" : "line_malformed");
    return { status: "MISCONFIGURED", line: null, failing: [], misconfigured: needed, reasons: ordered() };
  }
  const { values } = parse;
  const misconfigured = needed.filter((name) => values[name] === "skip" || values[name] === "empty");
  if (needed.some((name) => values[name] === "skip")) reasons.add("required_skipped");
  if (needed.some((name) => values[name] === "empty")) reasons.add("required_empty");
  const failing = GATE_NAMES.filter((name) => values[name] === "fail");
  const status: GateLineStatus = misconfigured.length > 0 || reasons.has("no_required_gates") ? "MISCONFIGURED" : failing.length > 0 ? "RED" : "GREEN";
  return { status, line: formatGateLine(values), failing, misconfigured, reasons: ordered() };
}

/** True for GREEN only. */
export function gateVerdictPasses(verdict: GateLineVerdict): boolean {
  return verdict.status === "GREEN";
}
