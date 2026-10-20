/**
 * Rows of `[title, status]` for an `it.each` over exit statuses. A status in `guards` also passes on the source before the rule
 * under test existed, so its title says it is a negative guard and not evidence for the rule.
 */
export function statusRows(statuses: readonly number[], guards: readonly number[] = []): [string, number][] {
  return statuses.map((status) => [`${guards.includes(status) ? "negative guard: " : ""}status ${status}`, status]);
}
