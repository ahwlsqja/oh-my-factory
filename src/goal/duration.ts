const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30m`, `72h`, `7d`: the duration format of goal.md (spec §4.1). */
export function parseDuration(text: string): number {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(text);
  if (match === null) throw new Error(`invalid duration ${text}: use <n>m, <n>h or <n>d`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
