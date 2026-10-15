import { contextPaths, omfDir } from "./context-files.js";

/**
 * The closed set of things the implementer is told: the work id (for paths), the round, and the masked feedback already
 * released to it. No scenario, no vault path, no target and no key is ever a field here, and a widened object that reaches
 * this function through a cast is refused, as the seal prompt does.
 */
const INPUT_KEYS: readonly string[] = ["workId", "round", "feedback"];

/**
 * The fixed prompt of the implementer session (spec §5.4). It goes on stdin. Everything except the work id in the paths, the
 * round number and the feedback texts is constant text. Feedback appears only from round 2: rounds restart from the base
 * (the previous head is not carried over), so the implementer is told what the judge released and starts again.
 * `feedback` texts are the masked ones from `FeedbackSlot.released()`, copied verbatim.
 */
export function buildImplementerPrompt(input: { workId: string; round: number; feedback: readonly string[] }): string {
  for (const key of Object.keys(input)) if (!INPUT_KEYS.includes(key)) throw new Error("forbidden_prompt_input");
  if (!Number.isInteger(input.round) || input.round < 1) throw new Error("invalid_round");
  const { spec, intent } = contextPaths(input.workId);
  const dir = omfDir(input.workId);

  const lines = [
    "You are the implementer for one work item. You work in the current directory, a git repository that holds the project.",
    ...(input.round >= 2
      ? [
          `This is round ${input.round}. Your work starts again from the original project files: earlier rounds are not present.`,
        ]
      : []),
    "",
    `1. Read ${intent} and ${spec} first. They say what to build and which interface contract applies.`,
    `2. Your first commit must add only ${dir}/plan.md: a short plan of the change. Commit it before you change anything else. A first commit that touches any other file counts as a missing plan.`,
    "3. Then implement the change in further commits. Anything you leave uncommitted is committed for you at the end.",
    "4. Do not edit, move or delete an existing test file. Add new tests when you need them. If an existing test contradicts the spec, do not change the test: raise the conflict as described below.",
    `5. To raise a conflict you cannot settle yourself, commit ${dir}/request.json and stop. Its shape is:`,
    '   {"kind": "test_conflict" | "spec_conflict", "paths": ["<up to 10 tracked file paths>"], "note": "<a short explanation, optional>"}',
    "6. Do not run anything that needs a network other than the model service you are already using.",
  ];

  if (input.round >= 2 && input.feedback.length > 0) {
    lines.push("", "Feedback released so far, verbatim and in order. It describes what is still wrong; fix the cause.");
    input.feedback.forEach((text, index) => {
      lines.push("", `--- feedback ${index + 1} of ${input.feedback.length} ---`, text);
    });
  }
  return lines.join("\n");
}
