// Index of `key` in the sorted array `list`, or -1. `probe` is called once for every comparison, which is
// what bench/steps.mjs counts: the cost is a count of comparisons, so it does not depend on the machine.
export function search(list, key, probe = () => {}) {
  for (let i = 0; i < list.length; i += 1) {
    probe();
    if (list[i] === key) return i;
  }
  return -1;
}
