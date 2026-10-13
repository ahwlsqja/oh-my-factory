#!/bin/sh
# Records the baseline the guardrail needs (spec §4.3, §4.5). A control band compares a new value
# with the earlier measurements of the same regime, and a guardrail that was never evaluated can
# never let the goal succeed. Six runs give the sixth five earlier points to compare with: the
# minimum the bands need (MIN_BASELINE_POINTS in src/goal/bands.ts, plus the current run).
#
# Run it after omf goal approve g-hello. A re-approval starts a new regime, so run it again then.
set -eu

count=${SEED_COUNT:-6}
i=0
while [ "$i" -lt "$count" ]; do
  omf goal measure g-hello --runner host > /dev/null
  i=$((i + 1))
done
echo "measured $count times; next: omf goal tick g-hello --runner host"
