# The null implementation of the offline acceptance: it writes a plan and changes no code, so no honest judge may pass it.
set -eu
work=$(ls .omf | head -n 1)
mkdir -p ".omf/$work"
printf '%s\n' 'Plan: nothing to change.' > ".omf/$work/plan.md"
git add ".omf/$work/plan.md"
git commit -q -m plan
printf '%s\n' '{"type":"result","total_cost_usd":0.01,"result":"Nothing changed."}'
