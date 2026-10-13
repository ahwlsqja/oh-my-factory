# hello-goal

The goal loop end to end, offline. A search function reads a sorted list from the front. The goal is to bring the
p95 number of comparisons per search down to 12 or fewer, and a guardrail checks that every answer stays the same.
A small script stands in for the model, so nothing leaves your machine and no API key is needed.

The metrics count comparisons instead of timing them. A count is exact and the same on every machine, so the
example gives the same numbers every time (256 before the fix, 8 after it).

This example runs the goal loop (`omf goal tick`). The part that would carry out a work item, the verification
line, is not built yet, so you apply the change yourself in step 6. In the full factory that is its job.

## Files

| Path | What it is |
|---|---|
| `goal.md` | The goal: target `m-search-cost <= 12 compares`, guardrail `m-bad-results`, a one-minute observation window |
| `bands/m-bad-results.yaml` | Control bands for the guardrail: a point beyond 3 sigma proposes work |
| `app/search.mjs` | The code being improved: a linear scan |
| `fix/search.mjs` | The change that closes the gap: binary search |
| `bench/` | The metrics and their fixed inputs. Watched: editing it needs a new approval |
| `reconciler.mjs` | The stand-in for the model: reads the prompt, always proposes the same change |
| `setup.sh`, `seed-baseline.sh` | The steps below, as scripts |

## Run it

You need `omf` on your `PATH` (see the main README), `node` and `git`.

1. Copy the example into a new repository and commit it. It must be committed: J1 refuses to approve while a
   watched path has uncommitted changes.

   ```sh
   cp -R examples/hello-goal /tmp/hello-goal && cd /tmp/hello-goal
   git init -b main && git add -A && git commit -m "hello-goal"
   ```

2. Set up the goal. This writes host state under `~/.omf` only.

   ```sh
   sh setup.sh
   ```

3. Approve it (J1). You will see the target, the budget, both metric commands and the bands. Type `g-hello`.

   ```sh
   omf goal approve g-hello
   ```

4. Record the baseline the guardrail needs. Without it the guardrail stays `unevaluated` and the goal can never
   succeed (spec F7).

   ```sh
   sh seed-baseline.sh
   ```

5. Turn 1. The target is not met, so the tick asks the stand-in model for work. One item appears, risk `normal`,
   state `ready`. Look at it, and note that you could `omf veto` it.

   ```sh
   omf goal tick g-hello --runner host
   omf work list g-hello
   ```

6. Do the work. This is what the verification line will do later.

   ```sh
   cp fix/search.mjs app/search.mjs && git commit -am "halve the range at every look"
   ```

   `app/` is not watched, so this is not a regime change and needs no new approval.

7. Turn 2. The first tick after the change measures the target as met: the goal is `observing`, because
   success needs two consecutive measurements spanning the observation window. Wait a minute and tick again.

   ```sh
   omf goal tick g-hello --runner host
   sleep 60
   omf goal tick g-hello --runner host
   omf goal status g-hello
   ```

   The second tick records a success candidate and the goal is `finish`. Sign-off (J5) is not built yet.

Only turn 1 called the model, so only turn 1 spent one of the goal's ten rounds (`omf budget show g-hello`).
Waiting ticks spend nothing.
