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

  it("an unpaired backtick does not hide references in later paragraphs", () => {
    const scan = scanFootnotes(
      "Use the ` character as a separator.[^a]\n\nLater.[^b]\n\nMore `code` here.[^c]\n",
    );
    expect(scan.references).toEqual(["a", "b", "c"]);
  });

  it("still blanks an inline code span that wraps across a single newline", () => {
    const scan = scanFootnotes("Text `a\n[^hidden] b` end.[^x]\n");
    expect(scan.references).toEqual(["x"]);
  });

  it("ignores references in single- and multi-line HTML comments", () => {
    const scan = scanFootnotes(
      "<!-- [^one] -->\nReal.[^real]\n<!--\n[^two]\n-->\nAfter.[^after]\n",
    );
    expect(scan.references).toEqual(["real", "after"]);
  });

  it("does not treat an HTML comment marker inside an inline code span as a comment", () => {
    // The `<!--` sits inside an inline code span; a real (prose) `-->` comes
    // later. Code spans are recognised first, so the `<!--` is code, the
    // comment never starts, and the `[^a]` reference in between survives.
    const scan = scanFootnotes(
      "Use the `<!--` marker inline. See [^a]. Then a stray --> later.\n",
    );
    expect(scan.references).toEqual(["a"]);
  });

  it("does not let a fence marker written inside an HTML comment open a fence", () => {
    // The ``` is comment text, not a fence opener: the comment is blanked
    // before fences, so it never swallows the reference that follows it.
    const scan = scanFootnotes("<!--\n```\n-->\nReal.[^real]\n");
    expect(scan.references).toEqual(["real"]);
  });

  it("treats `<!-->` as a complete (empty) comment", () => {
    // `<!-->` closes itself, so what follows is prose: the `[^real]` survives
    // and the later `-->` is just text, not a comment terminator reaching back.
    const scan = scanFootnotes("<!-->\nReal.[^real]\n-->\nMore.[^more]\n");
    expect(scan.references).toEqual(["real", "more"]);
  });
});
