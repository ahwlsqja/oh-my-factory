import { type Token, enclosed, isIdent, isPunct, splitArgs, tokenize } from "./code-tokens.js";

// Source lints for the gated suites that can hold a real model key. They read tokens, not text, so a comment or a string cannot
// satisfy or evade a rule. Each returns the violations it found, as short fixed strings that never quote the source.

const PRINT_NAMES = new Set(["console", "writeSync", "reveal"]);
const PRINT_STRINGS = new Set(["console", "writeSync", "reveal", "stdout", "stderr", "stdin"]);
const PROCESS_PROPS = new Set(["env", "pid"]);
const ASSERTS = new Set(["assertTrue", "assertFalse"]);

/** Names of the credential readers a suite calls (not defines) when it holds a real key. */
const KEY_READERS = new Set(["gatedCredential", "authorCredential"]);

/** Whether the file reads a real model key: a call of a key reader, or a read of a key variable from the process environment. */
export function holdsRealKey(src: string): boolean {
  const t = tokenize(src);
  return t.some((tok, i) => {
    if (isIdent(tok) && KEY_READERS.has(tok.text) && isPunct(t[i + 1], "(") && !isIdent(t[i - 1], "function"))
      return true;
    if (!isIdent(tok, "process") || !isPunct(t[i + 1], ".") || !isIdent(t[i + 2], "env")) return false;
    const next = t[i + 3];
    const key = isPunct(next, ".") ? t[i + 4] : isPunct(next, "[") ? t[i + 4] : undefined;
    return key !== undefined && (key.kind === "ident" || key.kind === "string") && /API_KEY|_TOKEN/.test(key.text);
  });
}

/** Which of describeGated and describeGatedModel the file calls (a declaration or an import is not a call). */
export function describeCalls(src: string): { gated: number; model: number } {
  const t = tokenize(src);
  const count = (name: string): number =>
    t.filter((tok, i) => isIdent(tok, name) && isPunct(t[i + 1], "(") && !isIdent(t[i - 1], "function")).length;
  return { gated: count("describeGated"), model: count("describeGatedModel") };
}

/** Printing and key-reading in any gated file: console, process.stdout/stderr, fs.writeSync, .reveal, and process used as a value. */
export function printViolations(src: string): string[] {
  const t = tokenize(src);
  const out = new Set<string>();
  t.forEach((tok, i) => {
    if (isIdent(tok) && PRINT_NAMES.has(tok.text)) out.add(`uses ${tok.text}`);
    if (tok.kind === "string" && PRINT_STRINGS.has(tok.text)) out.add(`names "${tok.text}" as a string`);
    if (isIdent(tok, "process")) {
      const sep = t[i + 1];
      const prop = isPunct(sep, ".") || sep?.text === "?." ? t[i + 2] : undefined;
      if (prop === undefined || !isIdent(prop) || !PROCESS_PROPS.has(prop.text))
        out.add("uses process other than env or pid");
    }
  });
  return [...out];
}

/** expect in a model suite or a support file: any `expect` identifier that is not an object key. */
export function expectViolations(src: string): string[] {
  const t = tokenize(src);
  const hit = t.some((tok, i) => isIdent(tok, "expect") && !isPunct(t[i + 1], ":") && !isPunct(t[i - 1], "."));
  const member = t.some((tok, i) => isIdent(tok, "expect") && isPunct(t[i - 1], "."));
  return [...(hit ? ["uses expect"] : []), ...(member ? ["reads a member named expect"] : [])];
}

/** assertTrue and assertFalse: only called, never aliased, and the last argument is one plain string literal. */
export function assertViolations(src: string): string[] {
  const t = tokenize(src);
  const out = new Set<string>();
  let inImport = false;
  t.forEach((tok, i) => {
    if (isIdent(tok, "import")) inImport = true;
    if (inImport && tok.kind === "string") inImport = false;
    if (!isIdent(tok) || !ASSERTS.has(tok.text)) return;
    if (inImport || isIdent(t[i - 1], "function")) return;
    if (!isPunct(t[i + 1], "(")) {
      out.add(`${tok.text} is not called directly`);
      return;
    }
    const args = splitArgs(enclosed(t, i + 1).inner);
    const last: Token[] = args[args.length - 1] ?? [];
    const only = last.length === 1 ? last[0] : undefined;
    const literal =
      only !== undefined && (only.kind === "string" || (only.kind === "template" && only.dynamic !== true));
    if (args.length !== 2 || !literal) out.add(`${tok.text} message is not a string literal`);
  });
  return [...out];
}

/** The text of the argument list of `describe.skipIf(...)` inside the exported function `name`, tokens joined without spaces. */
export function skipIfArgument(src: string, name: string): string | null {
  const t = tokenize(src);
  const decl = t.findIndex((tok, i) => isIdent(tok, name) && isIdent(t[i - 1], "function"));
  if (decl < 0) return null;
  let open = decl;
  while (!isPunct(t[open], "{")) open++;
  const body = enclosed(t, open).inner;
  const at = body.findIndex(
    (tok, i) =>
      isIdent(tok, "describe") &&
      isPunct(body[i + 1], ".") &&
      isIdent(body[i + 2], "skipIf") &&
      isPunct(body[i + 3], "("),
  );
  if (at < 0) return null;
  return enclosed(body, at + 3)
    .inner.map((x) => x.text)
    .join("");
}
