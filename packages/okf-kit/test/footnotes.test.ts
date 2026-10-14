import { describe, expect, it } from "vitest";
import { scanFootnotes } from "../src/footnotes.js";

describe("scanFootnotes", () => {
  it("collects references in document order, one per occurrence", () => {
    const scan = scanFootnotes("A.[^a] B.[^b] C.[^a]\n");
    expect(scan.references).toEqual(["a", "b", "a"]);
    expect(scan.definitions).toEqual([]);
  });

  it("treats a definition line as a definition, not a reference", () => {
    const scan = scanFootnotes("Claim.[^a]\n\n[^a]: Source text.\n");
    expect(scan.references).toEqual(["a"]);
    expect(scan.definitions).toEqual([{ id: "a", text: "Source text." }]);
  });

  it("joins indented continuation lines into the definition text", () => {
    const scan = scanFootnotes("[^a]: First line\n    second line\n\nProse.\n");
    expect(scan.definitions).toEqual([
      { id: "a", text: "First line second line" },
    ]);
  });

  it("finds a reference inside a definition's text", () => {
    const scan = scanFootnotes("[^a]: See also [^b].\n");
    expect(scan.references).toEqual(["b"]);
    expect(scan.definitions.map((d) => d.id)).toEqual(["a"]);
  });

  it("ignores references in fenced code (backtick and tilde) and inline code", () => {
    const body = [
      "Real.[^real]",
      "",
      "```md",
      "[^in-fence]",
      "```",
      "~~~",
      "[^in-tilde]",
      "~~~",
      "",
      "Inline `[^in-code]` and ``[^in-double]`` here.",
    ].join("\n");
    expect(scanFootnotes(body).references).toEqual(["real"]);
  });

  it("resumes scanning after a fence closes, and an unclosed fence runs to the end", () => {
    expect(scanFootnotes("```\n[^x]\n```\n[^y]\n").references).toEqual(["y"]);
    expect(scanFootnotes("```\n[^x]\n[^y]\n").references).toEqual([]);
  });

  it("a longer fence is not closed by a shorter one", () => {
    expect(scanFootnotes("````\n```\n[^x]\n````\n[^y]\n").references).toEqual([
      "y",
    ]);
  });

  it("ignores a backslash-escaped reference", () => {
    expect(scanFootnotes("Literal \\[^a] and real [^b]\n").references).toEqual([
      "b",
    ]);
  });

  it("keeps ids case-sensitive", () => {
    expect(scanFootnotes("[^A] [^a]\n").references).toEqual(["A", "a"]);
  });

  it("a definition inside a fence is not a definition", () => {
    const scan = scanFootnotes("```\n[^a]: text\n```\n");
    expect(scan.definitions).toEqual([]);
  });

  it("does not read an indented (4+ spaces) line as a definition", () => {
    const scan = scanFootnotes("    [^a]: text\n");
    expect(scan.definitions).toEqual([]);
  });

  it("keeps inline code in a definition's text (line citations live there)", () => {
    const scan = scanFootnotes("[^a]: Loop, `L2-4`.\n");
    expect(scan.definitions).toEqual([{ id: "a", text: "Loop, `L2-4`." }]);
  });

  it("handles CRLF line endings", () => {
    const scan = scanFootnotes("Claim.[^a]\r\n\r\n[^a]: Text.\r\n");
    expect(scan.references).toEqual(["a"]);
    expect(scan.definitions).toEqual([{ id: "a", text: "Text." }]);
  });
});
