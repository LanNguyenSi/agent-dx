// Neutralises terminal control characters in text that came from scanned
// files (paths, matched content, config-supplied messages) before it is
// written to a terminal or returned to an MCP client.

// C0 controls except \t (0x09) and \n (0x0a), DEL, every C1 control
// (0x80-0x9f), and the Unicode line/paragraph separators.
// Built from a string so the separators stay escaped in the source.
const CONTROL_CHARS = new RegExp(
  "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029]",
  "g",
);

/**
 * Replace each control character with a visible escape: `\xNN` for C0 and
 * DEL, `\uNNNN` for C1 and the Unicode separators. Newline and tab and every
 * other character are returned unchanged.
 */
export function sanitizeForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x80
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
