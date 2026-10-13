#!/bin/sh
# Sets up the hello-goal example (spec §13) in the git repository you are standing in:
# initializes OMF host state, creates the goal from goal.md, installs its bands, proposes both
# metrics and points the reconciler at reconciler.mjs. Nothing is written to the repository.
#
# Run it from the root of a copy of examples/hello-goal that you have committed. It needs `omf`
# and `node` on PATH. J1 (omf goal approve g-hello) stays yours: it needs a person at a terminal.
set -eu
umask 077

if [ ! -f goal.md ] || [ ! -d bench ]; then
  echo "run this from the root of a committed copy of examples/hello-goal" >&2
  exit 2
fi

init_out=$(omf init)
project_dir=${init_out#*initialized }

created=$(omf goal new g-hello)
goal_file=$(printf '%s\n' "$created" | sed -n '1s/^created //p')
goal_dir=$(dirname "$goal_file")
cp goal.md "$goal_file"
mkdir -p "$goal_dir/bands"
cp bands/m-bad-results.yaml "$goal_dir/bands/m-bad-results.yaml"

# Both metrics watch bench/ only. Editing app/ is the work being measured, not a regime change.
omf metric propose m-search-cost --unit compares --watch 'bench/**' -- node bench/steps.mjs
omf metric propose m-bad-results --unit results --watch 'bench/**' -- node bench/check.mjs

# config.toml is yours: omf never rewrites it, so this appends the reconciler section once.
if ! grep -q '^\[reconciler\]' "$project_dir/config.toml"; then
  printf '\n[reconciler]\nkind = "command"\ncommand = ["node", "%s/reconciler.mjs"]\n' "$(pwd)" >> "$project_dir/config.toml"
fi

echo "next: omf goal approve g-hello (J1), then sh seed-baseline.sh"
