// usage: node line-author-stub.mjs <yaml-file> <prompt-log>
// Appends the prompt (stdin) to <prompt-log>, then prints <yaml-file>. The marker lets a test split the log.
import { appendFileSync, readFileSync } from "node:fs";

const [yamlFile, promptLog] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
appendFileSync(promptLog, `${Buffer.concat(chunks).toString("utf8")}\n=====PROMPT-END=====\n`);
process.stdout.write(readFileSync(yamlFile, "utf8"));
