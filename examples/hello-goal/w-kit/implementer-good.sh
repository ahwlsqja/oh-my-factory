# The stub implementer of the offline acceptance: a script, not a model. The fake docker runs it in the container's /work when the
# session execs `claude`. It commits the plan alone first, then the fix and its test, and prints the one result line the
# Claude client prints. It never reads or prints the key.
set -eu
work=$(ls .omf | head -n 1)
mkdir -p ".omf/$work" src tests
printf '%s\n' 'Plan: make add return the sum.' > ".omf/$work/plan.md"
git add ".omf/$work/plan.md"
git commit -q -m plan
printf '%s\n' 'export const add = (a, b) => a + b;' > src/calc.mjs
cat > tests/calc.test.mjs <<'OMF_EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/calc.mjs";
test("add", () => {
  assert.equal(add(1, 2), 3);
});
OMF_EOF
git add src/calc.mjs tests/calc.test.mjs
git commit -q -m "fix add"
printf '%s\n' '{"type":"result","total_cost_usd":0.01,"result":"Implemented as planned."}'
