// Prints how many keys the search answers differently from Array#indexOf. The guardrail: faster must not mean wrong.
import { search } from "../app/search.mjs";
import { KEYS, LIST } from "./inputs.mjs";

console.log(KEYS.filter((key) => search(LIST, key) !== LIST.indexOf(key)).length);
