/**
 * The command line of the sealing author (spec §5.3, §7): Codex as one ephemeral `exec` inside the author container.
 * The prompt arrives on stdin, the answer leaves through one file, and the key is never part of an argv (it is a
 * `SecretHandle` on the exec). Nothing is interactive: no terminal, no resume, no login.
 *
 * Whether this Codex version starts its own sandbox under `cap-drop ALL`, and accepts the schema, is unverified until
 * the gated run `G-author-canary` is recorded.
 */

/** tmpfs, owned by the sandbox user, written once by `tar -x`: `intent.md`, `spec.md` and `contract.json`. */
export const AUTHOR_IN = "/in";
export const AUTHOR_OUT = "/out";
/** The only place the author's answer leaves from. */
export const ANSWER_FILE = "/out/answer.json";
/** An OMF constant written into `/agent` before the run, never an input from the item. */
export const SCHEMA_FILE = "/agent/answer.schema.json";

/**
 * The envelope `--output-schema` forces: one string holding the YAML stream the seal prompt describes, so the existing
 * intake, its digest and its counts stay unchanged. No `minLength` and no `$schema`: strict structured-output validators
 * accept a small subset of JSON Schema, and the host refuses an empty string anyway (`parseAnswer`).
 */
export const ANSWER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["scenarios_yaml"],
  properties: { scenarios_yaml: { type: "string" } },
});

export const ANSWER_SCHEMA_TEXT = `${JSON.stringify(ANSWER_SCHEMA)}\n`;

/**
 * Appended to the prompt AFTER it is hashed into `seal.requested.input_sha256`, so the seal prompt and its digest stand.
 * It names the JSON field and says it takes the place of the prompt's "Print nothing else" sentence, so the model is not
 * given two contradicting output rules. `author.session_completed.input_sha256` hashes prompt plus suffix.
 */
export const OUTPUT_SUFFIX =
  '\n## Answer envelope\n\nThe sentence "Print nothing else: no prose and no code fence" above is replaced by this rule. ' +
  "Your whole final message is one JSON object with exactly one field, scenarios_yaml, whose value is the YAML stream " +
  "described above as a single string. Do not wrap the object in a code fence and do not add any other field.\n";

/** The message is the code only, so no caller-supplied text reaches a log through an error. */
export class CodexArgvError extends Error {
  constructor(readonly code: "invalid_model") {
    super(code);
    this.name = "CodexArgvError";
  }
}

/** Letters, digits and `._:-`, at most 80 characters, never a leading `-`: argv has no `--` guard before the model. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export function codexArgv(input: { model: string | null }): string[] {
  if (input.model !== null && !MODEL_PATTERN.test(input.model)) throw new CodexArgvError("invalid_model");
  return [
    "codex",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-s",
    "read-only",
    "--output-schema",
    SCHEMA_FILE,
    "-o",
    ANSWER_FILE,
    "-C",
    AUTHOR_IN,
    ...(input.model === null ? [] : ["-m", input.model]),
    "-",
  ];
}

/**
 * Refuses any argv that is not the pinned one-shot ephemeral `codex exec`, with only the model value free. The comparison is
 * against `codexArgv` itself, so a terminal, a resume, a login, `--full-auto`, a wider `-s`/`--sandbox` and any `-c`
 * override of the sandbox or the approval policy are refused at run time without a list of bad spellings to keep up to date.
 */
export function refuseInteractive(argv: readonly string[]): "interactive" | null {
  const modelAt = argv.length - 3;
  const model = argv[modelAt] === "-m" ? (argv[modelAt + 1] ?? null) : null;
  let pinned: string[];
  try {
    pinned = codexArgv({ model });
  } catch {
    return "interactive";
  }
  return pinned.length === argv.length && pinned.every((part, index) => part === argv[index]) ? null : "interactive";
}
