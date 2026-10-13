import type { Trigger } from "../work/types.js";
import type { GapReport } from "./measure.js";

/** What the reconciler may learn about a build-mode gap: which way to move and a coarse size, never a number (spec §4.6). */
export interface GapDisclosure {
  direction: "decrease" | "increase";
  size: "small" | "medium" | "large";
}

/** What the reconciler may learn about a band breach: how strong, not which metric or which way. */
export interface BreachDisclosure {
  severity: "elevated" | "severe";
}

export interface GapSummary {
  trigger: Trigger | "both";
  gap: GapDisclosure | null;
  breach: BreachDisclosure | null;
}

export type NoTrigger = { reason: "target_met" | "idle" };

/** Build mode only: a watch goal has no target to be short of. Throws when a failed target carries no direction or size. */
function gapOf(report: GapReport, mode: "build" | "watch"): GapDisclosure | null {
  if (mode !== "build") return null;
  const result = report.target.result;
  if (result === null || result.met) return null;
  if (result.direction === "none" || result.size === "none") {
    throw new Error("target result is not met but has no direction or size");
  }
  return { direction: result.direction, size: result.size };
}

/**
 * A breach reaches the reconciler only when the band's tier action is `propose`; `diagnose` and `log` are
 * recorded elsewhere (D15). Beyond 3 sigma is severe. Anything weaker is elevated, and the worst tier wins.
 */
function breachOf(report: GapReport): BreachDisclosure | null {
  let found = false;
  let severe = false;
  for (const metric of report.metrics) {
    const band = metric.band;
    if (metric.band_action !== "propose" || band === null || band.status !== "breach") continue;
    found = true;
    if (band.tier === "3sigma") severe = true;
  }
  return found ? { severity: severe ? "severe" : "elevated" } : null;
}

/**
 * The gap summary (spec §4.4 step 4, D6, D16). `summary` is null when nothing triggers a work item, and
 * `none` then says why: the target is met, or there is simply nothing to do. A breach is a trigger even
 * when the target is met. A report measured under a pending regime change is never a trigger, because it
 * is not a verdict on the approved goal (the tick stops for re-approval before it gets here).
 */
export function summarizeGap(
  report: GapReport,
  mode: "build" | "watch",
): { summary: GapSummary | null; none: NoTrigger | null } {
  if (report.needs_reapproval) return { summary: null, none: { reason: "idle" } };
  const gap = gapOf(report, mode);
  const breach = breachOf(report);
  if (gap === null && breach === null) {
    const met = mode === "build" && report.target.result?.met === true;
    return { summary: null, none: { reason: met ? "target_met" : "idle" } };
  }
  const trigger = gap !== null && breach !== null ? "both" : gap !== null ? "gap" : "breach";
  return { summary: { trigger, gap, breach }, none: null };
}
