// A small TypeScript tokenizer for source lints that must not be fooled by a comment or a string. It drops comments and
// keeps strings and templates as single tokens, so a rule such as "no `expect` identifier" cannot be satisfied or evaded by
// text inside either. It is not a parser: it is exact enough for the lints in tests/scripts and no more.

export type TokenKind = "ident" | "string" | "template" | "number" | "regex" | "punct";

export interface Token {
  kind: TokenKind;
  /** Identifier name, string contents without quotes, template source without backticks, or the punctuator. */
  text: string;
  /** True for a template that holds a `${` substitution. */
  dynamic?: boolean;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Index just past the closing backtick of the template that starts at `start` (a backtick), nested templates included. */
function templateEnd(src: string, start: number): { end: number; dynamic: boolean } {
  let i = start + 1;
  let dynamic = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === "`") return { end: i + 1, dynamic };
    else if (c === "$" && src[i + 1] === "{") {
      dynamic = true;
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const d = src[i];
        if (d === "`") i = templateEnd(src, i).end;
        else if (d === '"' || d === "'") i = quotedEnd(src, i);
        else {
          if (d === "{") depth++;
          else if (d === "}") depth--;
          i++;
        }
      }
    } else i++;
  }
  throw new Error("unterminated template literal");
}

function quotedEnd(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === quote) return i + 1;
    else i++;
  }
  throw new Error("unterminated string literal");
}

/** A `/` starts a regular expression unless the previous token ends an expression. */
function startsRegex(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "ident")
    return ["return", "typeof", "case", "in", "of", "void", "delete", "throw"].includes(prev.text);
  if (prev.kind === "string" || prev.kind === "template" || prev.kind === "number" || prev.kind === "regex")
    return false;
  return ![")", "]", "}"].includes(prev.text);
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (/\s/.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) throw new Error("unterminated block comment");
      i = close + 2;
    } else if (c === '"' || c === "'") {
      const end = quotedEnd(src, i);
      out.push({ kind: "string", text: src.slice(i + 1, end - 1) });
      i = end;
    } else if (c === "`") {
      const { end, dynamic } = templateEnd(src, i);
      out.push({ kind: "template", text: src.slice(i + 1, end - 1), dynamic });
      i = end;
    } else if (c === "/" && startsRegex(out[out.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") j += 2;
        else if (d === "[") (inClass = true), j++;
        else if (d === "]") (inClass = false), j++;
        else if (d === "/" && !inClass) break;
        else j++;
      }
      j++;
      while (j < src.length && IDENT_PART.test(src[j] ?? "")) j++;
      out.push({ kind: "regex", text: src.slice(i, j) });
      i = j;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j] ?? "")) j++;
      out.push({ kind: "ident", text: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j] ?? "")) j++;
      out.push({ kind: "number", text: src.slice(i, j) });
      i = j;
    } else if (c === "?" && src[i + 1] === ".") {
      out.push({ kind: "punct", text: "?." });
      i += 2;
    } else {
      out.push({ kind: "punct", text: c });
      i++;
    }
  }
  return out;
}

export const isIdent = (t: Token | undefined, name?: string): boolean =>
  t?.kind === "ident" && (name === undefined || t.text === name);
export const isPunct = (t: Token | undefined, text: string): boolean => t?.kind === "punct" && t.text === text;

/** The tokens between the bracket at `open` and its match (exclusive), and the index of the closer. */
export function enclosed(tokens: readonly Token[], open: number): { inner: Token[]; close: number } {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const opener = tokens[open]?.text ?? "";
  const closer = pairs[opener];
  if (closer === undefined) throw new Error("not a bracket");
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t?.kind !== "punct") continue;
    if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
    else if (t.text === ")" || t.text === "]" || t.text === "}") {
      depth--;
      if (depth === 0) return { inner: tokens.slice(open + 1, i), close: i };
    }
  }
  throw new Error("unbalanced brackets");
}

/** Splits a call's inner tokens at top-level commas. A trailing comma yields no empty last argument. */
export function splitArgs(inner: readonly Token[]): Token[][] {
  const args: Token[][] = [[]];
  let depth = 0;
  for (const t of inner) {
    if (t.kind === "punct" && "([{".includes(t.text)) depth++;
    if (t.kind === "punct" && ")]}".includes(t.text)) depth--;
    if (depth === 0 && t.kind === "punct" && t.text === ",") args.push([]);
    else args[args.length - 1]?.push(t);
  }
  if (args.length > 1 && args[args.length - 1]?.length === 0) args.pop();
  return args;
}
