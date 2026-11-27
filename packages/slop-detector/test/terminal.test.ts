import { describe, it, expect } from "vitest";
import { sanitizeForTerminal } from "../src/util/terminal.js";

describe("util/terminal sanitizeForTerminal", () => {
  it("escapes an OSC 52 clipboard sequence", () => {
    expect(sanitizeForTerminal("\x1b]52;c;aGk=\x07")).toBe(
      "\\x1b]52;c;aGk=\\x07",
    );
  });

  it("escapes a CSI clear-screen sequence", () => {
    expect(sanitizeForTerminal("a\x1b[2Jb")).toBe("a\\x1b[2Jb");
  });

  it("escapes a lone ESC", () => {
    expect(sanitizeForTerminal("\x1b")).toBe("\\x1b");
  });

  it("escapes C0 controls including BEL, BS, CR, VT and FF", () => {
    expect(sanitizeForTerminal("\x00\x07\x08\r\x0b\x0c\x1f")).toBe(
      "\\x00\\x07\\x08\\x0d\\x0b\\x0c\\x1f",
    );
  });

  it("escapes DEL", () => {
    expect(sanitizeForTerminal("a\x7fb")).toBe("a\\x7fb");
  });

  it("escapes every C1 control, including the single-byte CSI", () => {
    expect(sanitizeForTerminal("\x9b2J")).toBe("\\u009b2J");
    expect(sanitizeForTerminal("\x80\x9f")).toBe("\\u0080\\u009f");
  });

  it("escapes the Unicode line and paragraph separators", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    expect(sanitizeForTerminal(`a${ls}b${ps}c`)).toBe("a\\u2028b\\u2029c");
  });

  it("keeps newline and tab", () => {
    expect(sanitizeForTerminal("a\nb\tc")).toBe("a\nb\tc");
  });

  it("returns ordinary text, punctuation and non-ASCII unchanged", () => {
    const text = 'plain `code` <invoke name="x"> äöü 日本語 🤖    ';
    expect(sanitizeForTerminal(text)).toBe(text);
  });
});
