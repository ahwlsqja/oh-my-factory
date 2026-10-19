# Command usage

The exact `--help` text of every leaf command of the built `omf`, one block per command. This file is generated:
run `npm run build && node scripts/cli-usage.mjs --write` after changing a command. `npm test` fails when this file
and the CLI disagree, and names the command.

## omf init

```text
Usage: omf init [options]

create OMF host state for this repository (writes nothing to the repository)

Options:
  -h, --help  display help for command
```

## omf doctor

```text
Usage: omf doctor [options]

check tools, repository, ledger and isolation; writes preflight.json

Options:
  --json      print the full report as JSON
  --strict    treat the tool warnings (Docker missing or not running, an agent
              CLI missing) as problems
  -h, --help  display help for command
```

## omf ledger verify

```text
Usage: omf ledger verify [options]

verify the ledger hash chain

Options:
  --json      print the result as JSON
  -h, --help  display help for command
```

## omf goal new

```text
Usage: omf goal new [options] <goal_id>

create goal.md in host state from a template

Arguments:
  goal_id     id of the form g-<words>

Options:
  -h, --help  display help for command
```

## omf goal audit

```text
Usage: omf goal audit [options] <goal_id>

check the goal, its locks and the ledger; report regime changes (writes nothing)

Options:
  --json      print the audit report as JSON
  -h, --help  display help for command
```

## omf goal approve

```text
Usage: omf goal approve [options] <goal_id>

J1: approve the goal and lock its metrics (needs an interactive terminal)

Options:
  -h, --help  display help for command
```

## omf goal measure

```text
Usage: omf goal measure [options] <goal_id>

audit the goal, run its locked metrics, and write a gap report to host state

Options:
  --runner <runner>  docker (isolated) or host (no isolation) (default:
                     "docker")
  --json             print the gap report as JSON
  -h, --help         display help for command
```

## omf goal status

```text
Usage: omf goal status [options] <goal_id>

show the run state, budgets, open escalation and work items of a goal (writes
nothing)

Options:
  --json      print the status as JSON
  -h, --help  display help for command
```

## omf goal resume

```text
Usage: omf goal resume [options] <goal_id>

J6 continue: let a blocked or failed goal tick again (needs an interactive
terminal)

Options:
  -h, --help  display help for command
```

## omf goal cancel

```text
Usage: omf goal cancel [options] <goal_id>

J6 stop: end the goal and cancel its open work items (needs an interactive
terminal)

Options:
  -h, --help  display help for command
```

## omf goal tick

```text
Usage: omf goal tick [options] <goal_id>

run one pass of the goal loop: audit, measure, reconcile, dispatch, refresh
(non-interactive)

Options:
  --runner <runner>  docker (isolated) or host (no isolation) (default:
                     "docker")
  --json             print the tick result as JSON
  -h, --help         display help for command
```

## omf metric propose

```text
Usage: omf metric propose [options] <metric_id> <command...>

propose a metric; it is measured only after J1 approves a goal that uses it

Arguments:
  metric_id       id of the form m-<words>
  command         argv that prints the value on its last stdout line; put it
                  after --

Options:
  --unit <unit>   unit of the value, for example ms
  --watch <glob>  a path whose change is a regime change (repeatable) (default:
                  [])
  --image <ref>   container image for --runner docker
  -h, --help      display help for command
```

## omf work list

```text
Usage: omf work list [options] <goal_id>

list a goal's work items; items the ledger does not account for are reported as
malformed (exit 1)

Options:
  --state <state>  only items in this state (repeatable) (default: [])
  --json           print the items as JSON
  -h, --help       display help for command
```

## omf work show

```text
Usage: omf work show [options] <work_id>

print a work item's item.md, claim and intent.md

Options:
  -h, --help  display help for command
```

## omf work approve

```text
Usage: omf work approve [options] <work_id>

approve a high-risk work item so it can be dispatched (needs an interactive
terminal)

Options:
  -h, --help  display help for command
```

## omf veto

```text
Usage: omf veto [options] <work_id>

veto a work item from any open state; no terminal needed, because a veto only
restricts

Options:
  --reason <text>  why, at most 500 characters (default: "vetoed")
  -h, --help       display help for command
```

## omf budget show

```text
Usage: omf budget show [options] <goal_id>

print rounds, disclosure and wall time: declared, raised, consumed and remaining

Options:
  --json      print the budgets as JSON
  -h, --help  display help for command
```

## omf budget declare

```text
Usage: omf budget declare [options] <goal_id> <kind> <amount>

J8: declare a rounds or disclosure budget (needs an interactive terminal)

Arguments:
  goal_id
  kind        rounds, disclosure or wall_time (wall_time can only be raised)
  amount      a positive integer, or a duration such as 2h for wall_time

Options:
  -h, --help  display help for command
```

## omf budget raise

```text
Usage: omf budget raise [options] <id> [kind] [amount]

J8: raise a goal's rounds, disclosure or wall_time cap, or a work item's
--rounds or --usd limit (needs an interactive terminal)

Arguments:
  id              a goal id, or a work id with --rounds or --usd
  kind            goal form: rounds, disclosure or wall_time
  amount          goal form: a positive integer, or a duration such as 2h for
                  wall_time

Options:
  --rounds <n>    work item form: raise the item's round limit by <n>
  --usd <amount>  work item form: raise the item's model spend limit by <amount>
                  dollars
  -h, --help      display help for command
```

## omf decide add

```text
Usage: omf decide add [options] <work_id>

record a design question as an open decision and rewrite spec.md

Options:
  --file <entry.json>  the question to record: id, class, question, optional qas
                       and response_measure
  -h, --help           display help for command
```

## omf decide lint

```text
Usage: omf decide lint [options] <work_id>

lint the decisions and evaluate GATE-1; exit 0 clean, 1 problems, 3 blocked on a
person (J2)

Options:
  --json      print the report as JSON
  --render    rewrite spec.md from the ledger first
  -h, --help  display help for command
```

## omf decide show

```text
Usage: omf decide show [options] <work_id>

print the decisions by status, the GATE-1 verdict and whether spec.md matches
the ledger; writes nothing

Options:
  --json      print the report as JSON
  -h, --help  display help for command
```

## omf decide resolve

```text
Usage: omf decide resolve [options] <work_id> <decision_id>

resolve a design decision as a person (needs an interactive terminal; retype
<work_id>/<decision_id>)

Options:
  --file <resolution.json>  the resolution: choice, rationale, rejected, and a
                            measure or interface where the class needs one
  --na                      mark the decision not applicable instead; the file
                            holds {"rationale": "..."} only
  -h, --help                display help for command
```

## omf decide defer

```text
Usage: omf decide defer [options] <work_id> <decision_id>

defer a design decision with a signed default and an expiry (needs an
interactive terminal; retype <work_id>/<decision_id>)

Options:
  --file <deferral.json>  the deferral: owner, reason, revisit_trigger, default,
                          expires_at (OMF sets signed_by)
  -h, --help              display help for command
```

## omf seal

```text
Usage: omf seal [options] <work_id>

run the sealing author in a measured container and check GATE-2; exit 0 sealed,
1 author failure or unmeasured, 2 refused, 3 blocked on a person

Options:
  --json      print the result as JSON (closed codes only)
  -h, --help  display help for command
```

## omf run

```text
Usage: omf run [options] <work_id>

run the verification line on one sealed work item and write its evidence (seal
it first: omf seal)

Arguments:
  work_id     the work item to run the verification line on

Options:
  --json      print the result as JSON
  -h, --help  display help for command

Exit codes: 0 success, 1 flawed, 2 refused or could not run (no passing seal, the environment, an aborted line), 3 blocked on a person (open decisions, a handoff to read). An item that already ran prints 'already ran' and exits 0.
```

## omf report

```text
Usage: omf report [options] <work_id>

print the evidence of the item's last run, re-rendered from evidence.json;
writes nothing

Arguments:
  work_id     the work item whose last run to report

Options:
  --json      print the validated evidence document as JSON
  -h, --help  display help for command
```

## omf ui

```text
Usage: omf ui [options]

open a local read-only dashboard for this repository

Options:
  --port <port>  loopback port (0 chooses an available port) (default: 0)
  --no-open      print the URL without opening a browser
  -h, --help     display help for command
```
