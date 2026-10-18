// Prints the p95 number of comparisons one search needs over the fixed key set (nearest rank).
import { search } from "../app/search.mjs";
import { KEYS, LIST } from "./inputs.mjs";

const costs = KEYS.map((key) => {
  let comparisons = 0;
  search(LIST, key, () => {
    comparisons += 1;
  });
  return comparisons;
}).sort((a, b) => a - b);
console.log(costs[Math.ceil(0.95 * costs.length) - 1]);
