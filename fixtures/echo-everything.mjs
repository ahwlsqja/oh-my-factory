// OMF host fixture, "echo-everything": a stub that reflects all of its input (spec §5.3).
// It prints its arguments joined by single spaces, a newline, then stdin, and exits 0. A contradiction
// canary must fail even against a program that prints everything it was given.
import { readFileSync } from "node:fs";

const stdin = readFileSync(0, "utf8");
process.stdout.write(`${process.argv.slice(1).join(" ")}\n${stdin}`);
