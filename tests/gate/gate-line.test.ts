import { describe, expect, it } from "vitest";
import { GATE_NAMES, type GateName } from "../../src/decision/types.js";
import {
  GATE_LINE_VALUES,
  type GateLineValues,
  MISCONFIGURED_REASONS,
  evaluateGateLine,
  formatGateLine,
  gateVerdictPasses,
  parseGateLine,
} from "../../src/gate/gate-line.js";

const LINE = "OMF_GATES: fast=pass full=pass deep=skip";

describe("formatGateLine and parseGateLine", () => {
  it("writes the three gates in the order fast, full, deep whatever the key order of the input", () => {
    expect(formatGateLine({ deep: "skip", full: "pass", fast: "fail" })).toBe("OMF_GATES: fast=fail full=pass deep=skip");
  });

  it("round-trips every one of the 64 value combinations", () => {
    for (const fast of GATE_LINE_VALUES) {
      for (const full of GATE_LINE_VALUES) {
        for (const deep of GATE_LINE_VALUES) {
          const values: GateLineValues = { fast, full, deep };
          expect(parseGateLine(formatGateLine(values))).toEqual({ kind: "ok", values });
        }
      }
    }
  });

  it("finds the line among other output", () => {
    expect(parseGateLine(`build ok\n${LINE}\ndone\n`)).toEqual({ kind: "ok", values: { fast: "pass", full: "pass", deep: "skip" } });
  });

  it("reads text without a candidate line as absent", () => {
    for (const text of ["", "nothing here\n", "OMF_GATE: fast=pass full=pass deep=skip", ` ${LINE}`, "omf_gates: fast=pass full=pass deep=skip"]) {
      expect(parseGateLine(text), JSON.stringify(text)).toEqual({ kind: "absent" });
    }
  });

  it("counts a repeated line as duplicated, even when the copies are identical", () => {
    expect(parseGateLine(`${LINE}\n${LINE}`)).toEqual({ kind: "duplicated", count: 2 });
    expect(parseGateLine(`${LINE}\nx\n${LINE}\n${LINE}`)).toEqual({ kind: "duplicated", count: 3 });
  });

  const MALFORMED: Array<[string, string]> = [
    ["OMF_GATES:", "bad_syntax"],
    ["OMF_GATES:fast=pass full=pass deep=skip", "bad_syntax"],
    ["OMF_GATES:  fast=pass full=pass deep=skip", "bad_syntax"],
    ["OMF_GATES: fast=pass  full=pass deep=skip", "bad_syntax"],
    ["OMF_GATES: fast=pass full=pass deep=skip ", "bad_syntax"],
    ["OMF_GATES: fast=pass full=pass deep=skip\r", "bad_syntax"],
    ["OMF_GATES: fast=pass\tfull=pass deep=skip", "bad_syntax"],
    ["OMF_GATES: fast pass full=pass deep=skip", "bad_syntax"],
    ["OMF_GATES: fast=pass=x full=pass deep=skip", "bad_syntax"],
    ["OMF_GATES: fast=pass full=pass dep=skip", "unknown_gate"],
    ["OMF_GATES: FAST=pass full=pass deep=skip", "unknown_gate"],
    ["OMF_GATES: fast=pass full=pass deep=skip extra=pass", "unknown_gate"],
    ["OMF_GATES: fast=pass full=pass fast=pass", "duplicate_gate"],
    ["OMF_GATES: fast=pass full=pass deep=maybe", "unknown_value"],
    ["OMF_GATES: fast=PASS full=pass deep=skip", "unknown_value"],
    ["OMF_GATES: fast=pass full=pass", "missing_gate"],
    ["OMF_GATES: fast=pass", "missing_gate"],
    ["OMF_GATES: full=pass fast=pass deep=skip", "out_of_order"],
    ["OMF_GATES: deep=skip full=pass fast=pass", "out_of_order"],
  ];
  it.each(MALFORMED)("rejects %j as %s", (line, reason) => {
    expect(parseGateLine(line)).toEqual({ kind: "malformed", reason });
  });
});

const v = (fast: string, full: string, deep: string): GateLineValues => ({ fast, full, deep }) as GateLineValues;
const BOTH: GateName[] = ["fast", "full"];

describe("evaluateGateLine", () => {
  const ROWS: Array<{ name: string; values: GateLineValues; required: GateName[]; status: string; failing: GateName[]; misconfigured: GateName[]; reasons: string[] }> = [
    { name: "all required pass", values: v("pass", "pass", "skip"), required: BOTH, status: "GREEN", failing: [], misconfigured: [], reasons: [] },
    { name: "a required skip", values: v("pass", "skip", "skip"), required: BOTH, status: "MISCONFIGURED", failing: [], misconfigured: ["full"], reasons: ["required_skipped"] },
    { name: "a required empty", values: v("pass", "empty", "skip"), required: BOTH, status: "MISCONFIGURED", failing: [], misconfigured: ["full"], reasons: ["required_empty"] },
    { name: "a required fail", values: v("fail", "pass", "skip"), required: BOTH, status: "RED", failing: ["fast"], misconfigured: [], reasons: [] },
    { name: "MISCONFIGURED beats RED", values: v("fail", "skip", "skip"), required: BOTH, status: "MISCONFIGURED", failing: ["fast"], misconfigured: ["full"], reasons: ["required_skipped"] },
    { name: "a skip and an empty together", values: v("skip", "empty", "pass"), required: BOTH, status: "MISCONFIGURED", failing: [], misconfigured: ["fast", "full"], reasons: ["required_skipped", "required_empty"] },
    { name: "no required gate", values: v("pass", "pass", "pass"), required: [], status: "MISCONFIGURED", failing: [], misconfigured: [], reasons: ["no_required_gates"] },
    { name: "no required gate and a fail", values: v("fail", "pass", "pass"), required: [], status: "MISCONFIGURED", failing: ["fast"], misconfigured: [], reasons: ["no_required_gates"] },
    { name: "a non-required skip is ignored", values: v("pass", "pass", "skip"), required: ["fast"], status: "GREEN", failing: [], misconfigured: [], reasons: [] },
    { name: "a non-required empty is ignored", values: v("pass", "pass", "empty"), required: ["fast"], status: "GREEN", failing: [], misconfigured: [], reasons: [] },
    { name: "a non-required fail is RED", values: v("pass", "pass", "fail"), required: ["fast"], status: "RED", failing: ["deep"], misconfigured: [], reasons: [] },
    { name: "required listed out of gate order", values: v("skip", "skip", "pass"), required: ["full", "fast"], status: "MISCONFIGURED", failing: [], misconfigured: ["fast", "full"], reasons: ["required_skipped"] },
  ];
  it.each(ROWS)("$name", (row) => {
    const verdict = evaluateGateLine(parseGateLine(formatGateLine(row.values)), row.required);
    expect(verdict).toEqual({ status: row.status, line: formatGateLine(row.values), failing: row.failing, misconfigured: row.misconfigured, reasons: row.reasons });
  });

  it("a line that is absent, duplicated or malformed is MISCONFIGURED and names every required gate", () => {
    expect(evaluateGateLine(parseGateLine("nothing"), BOTH)).toEqual({ status: "MISCONFIGURED", line: null, failing: [], misconfigured: BOTH, reasons: ["line_absent"] });
    expect(evaluateGateLine(parseGateLine(`${LINE}\n${LINE}`), ["fast"])).toMatchObject({ status: "MISCONFIGURED", misconfigured: ["fast"], reasons: ["line_duplicated"] });
    expect(evaluateGateLine(parseGateLine("OMF_GATES: fast=pass"), ["fast"])).toMatchObject({ status: "MISCONFIGURED", line: null, reasons: ["line_malformed"] });
    expect(evaluateGateLine(parseGateLine("nothing"), [])).toMatchObject({ reasons: ["line_absent", "no_required_gates"] });
  });

  it("only GREEN passes", () => {
    const green = evaluateGateLine(parseGateLine(LINE), BOTH);
    expect(gateVerdictPasses(green)).toBe(true);
    for (const verdict of [
      evaluateGateLine(parseGateLine(formatGateLine(v("fail", "pass", "pass"))), BOTH),
      evaluateGateLine(parseGateLine("nothing"), BOTH),
      evaluateGateLine(parseGateLine(formatGateLine(v("pass", "skip", "pass"))), BOTH),
    ]) {
      expect(gateVerdictPasses(verdict)).toBe(false);
    }
  });

  it("lists every reason in the closed order", () => {
    expect([...MISCONFIGURED_REASONS]).toEqual(["line_absent", "line_duplicated", "line_malformed", "required_skipped", "required_empty", "no_required_gates"]);
    expect(GATE_NAMES).toEqual(["fast", "full", "deep"]);
  });
});
