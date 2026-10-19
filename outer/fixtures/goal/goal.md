---
schema_version: 1
goal_id: g-hello
title: "Make the sorted lookup cheap"
mode: build
kind: default
objective: "Finding a name in the sorted list should take far less work than reading the list from the start"
target:
  metric_id: m-search-cost
  operator: "<="
  value: 12
  unit: compares
leading: []
lagging: [m-search-cost]
link_hypothesis: "Fewer comparisons per search is what makes the lookup cheap, so the p95 comparison count is the number to move"
guardrails: [m-bad-results]
prereg:
  min_observation: 1m
  decision_rule: "target met for 2 consecutive measurements and no guardrail breach"
  metrics_judged: 2
budget:
  rounds: 10
  wall_time: 72h
  max_open_work_items: 2
state_source: markdown
---
## Approach

Look at the middle of the sorted list first and keep halving the range, instead of walking the list from the start. The answers must stay exactly the same. Only the code under app/ changes.
