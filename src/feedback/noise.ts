import { FeedbackError } from "./types.js";

/** `flaky_test` is null while the test split has not run. */
export interface NoiseCheckInput {
  k: number;
  flaky_train: number;
  flaky_test: number | null;
}

export interface NoiseCheck {
  /** v0.1 never claims a variance estimate: there is no value that could read as "within variance, passed". */
  status: "not_evaluated";
  k: number;
  flaky_train: number;
  flaky_test: number | null;
  force_not_recommended: boolean;
  reason: "k_below_2" | "flaky_scenarios" | "none";
}

function requireInteger(value: number, min: number, what: string): void {
  if (!Number.isInteger(value) || value < min)
    throw new FeedbackError("invalid_input", `${what} must be an integer of at least ${min}`);
}

/**
 * The pure noise rule of the evidence report. Fail closed: k < 2 repetitions cannot tell a flaky
 * scenario from a stable one, so a clean-looking run proves nothing and the report must say not recommended. Otherwise any
 * flaky scenario in either split forces the same. Only a run with k >= 2 and no flaky scenario is left unforced, and even
 * then the status stays `not_evaluated`.
 */
export function noiseCheck(input: NoiseCheckInput): NoiseCheck {
  requireInteger(input.k, 1, "k");
  requireInteger(input.flaky_train, 0, "flaky_train");
  if (input.flaky_test !== null) requireInteger(input.flaky_test, 0, "flaky_test");
  const flaky = input.flaky_train > 0 || (input.flaky_test ?? 0) > 0;
  const reason = input.k < 2 ? "k_below_2" : flaky ? "flaky_scenarios" : "none";
  return {
    status: "not_evaluated",
    k: input.k,
    flaky_train: input.flaky_train,
    flaky_test: input.flaky_test,
    force_not_recommended: reason !== "none",
    reason,
  };
}

export type NoiseReasonCode = "flaky_scenario" | "noise_unverified";

/**
 * The reason code that names why the check forces not_recommended. Advisory and recorded only: the outcome classifier\n * classifier is the only producer of outcome reason codes (cross-plan X-15). A flaky scenario maps to `flaky_scenario`
 * (J4); k < 2 maps to `noise_unverified`, which is reserved and has no producer in v0.1. This module only returns the
 * string and imports nothing from src/work. One downgrade never has two codes. Null when nothing is forced.
 */
export function noiseReasonCode(check: NoiseCheck): NoiseReasonCode | null {
  if (check.reason === "k_below_2") return "noise_unverified";
  if (check.reason === "flaky_scenarios") return "flaky_scenario";
  return null;
}
