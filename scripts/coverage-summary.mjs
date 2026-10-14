// Prints coverage/coverage-summary.json as a Markdown table (for the CI job summary).
import { existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? "coverage/coverage-summary.json";
if (!existsSync(file)) {
  console.log(`No coverage summary at ${file}.`);
  process.exit(0);
}
const { total } = JSON.parse(readFileSync(file, "utf8"));
const rows = ["statements", "branches", "functions", "lines"].map(
  (key) => `| ${key} | ${total[key].pct}% | ${total[key].covered}/${total[key].total} |`,
);
console.log(["### Coverage (report only)", "", "| metric | pct | covered |", "|---|---|---|", ...rows].join("\n"));
