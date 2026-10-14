/**
 * Text from a ledger record or an agent-drafted file is data, not terminal input: control characters, line
 * breaks, format characters (bidi overrides) and line separators print as escapes, so no text can move the
 * cursor, hide itself or fake a line of the screen (spec §6.2: a person signs exactly what is shown).
 */
export function safeText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
