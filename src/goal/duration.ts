const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30m`, `72h`, `7d`: the duration format of goal.md (spec §4.1). */
export function parseDuration(text: string): number {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(text);
  if (match === null) throw new Error(`invalid duration ${text}: use <n>m, <n>h or <n>d`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** The inverse of `parseDuration`: days from a week up (`7d`), hours below that (`72h`), else whole minutes. */
export function formatDuration(ms: number): string {
  if (ms >= 7 * UNIT_MS.d && ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`;
  if (ms >= UNIT_MS.h && ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
  return `${Math.max(1, Math.round(ms / UNIT_MS.m))}m`;
}
