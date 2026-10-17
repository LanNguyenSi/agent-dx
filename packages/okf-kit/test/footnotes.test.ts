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

  it("a fence is not closed by a run of the other fence character", () => {
    expect(scanFootnotes("```\n~~~\n[^x]\n```\n[^y]\n").references).toEqual([
      "y",
    ]);
    expect(scanFootnotes("~~~\n```\n[^x]\n~~~\n[^y]\n").references).toEqual([
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

  it("keeps a fence marker that swallows its comment's `-->` opening a fence", () => {
    // Pinned trade-off: whether a `-->` lies ahead is read with fenced blocks
    // blanked, and on that view the ``` opens a fence that holds the `-->`.
    // So no `-->` licenses the `<!--`, which stays plain text, and the ```
    // opens a fence that runs to the end of the doc, hiding `[^real]`.
    const scan = scanFootnotes("<!--\n```\n-->\nReal.[^real]\n");
    expect(scan.references).toEqual([]);
  });

  it("does not let a fence marker open a fence inside a comment that a `-->` outside fenced code licenses", () => {
    // The `-->` on the last line lies outside every fenced block, so the
    // first `<!--` opens a comment. Inside it the unpaired ``` is comment
    // text: the comment ends at the next `-->`, the claim after it is prose,
    // and the ```js block below is an ordinary fence.
    const body = [
      "<!-- old example, keep for later:",
      "```",
      "-->",
      "Claim.[^a]",
      "",
      "```js",
      "code",
      "```",
      "<!-- note -->",
    ].join("\n");
    expect(scanFootnotes(body).references).toEqual(["a"]);
  });

  it("does not let a `-->` inside a later ``` fence license an inline `<!--`", () => {
    // The only `-->` after the `<!--` is fence content, so the `<!--` is
    // plain text: the references before and after the fence survive.
    const scan = scanFootnotes(
      "Write <!-- here.[^a]\n\n```\n-->\n```\nText.[^b]\n",
    );
    expect(scan.references).toEqual(["a", "b"]);
  });

  it("does not let a `-->` inside a later ~~~ fence license an inline `<!--`", () => {
    const scan = scanFootnotes("a <!-- b [^a]\n~~~\n-->\n~~~\nText.[^b]\n");
    expect(scan.references).toEqual(["a", "b"]);
  });

  it("does not let a `-->` on a fence opener line license a `<!--`", () => {
    // The opener line belongs to the fenced block, info string included.
    const scan = scanFootnotes(
      "Write <!-- x.[^a]\n\n```html -->\ncode\n```\nText.[^b]\n",
    );
    expect(scan.references).toEqual(["a", "b"]);
  });

  it("lets a `-->` after a closed fence license a later `<!--`", () => {
    // The fenced block ends before the comment, so it hides nothing after
    // it: the `-->` on the last line closes the comment as usual.
    const scan = scanFootnotes(
      "```\ncode\n```\nWrite <!-- hidden [^h]\nmore --> shown.[^a]\n",
    );
    expect(scan.references).toEqual(["a"]);
  });

  it("finds every reference in a doc that writes `<!--` in prose and shows a comment in a fenced example", () => {
    const body = [
      "In prose, write <!-- to start an HTML comment. The real claim.[^a]",
      "",
      "```html",
      "<!-- example -->",
      "```",
      "",
      "A dangling one.[^missing]",
      "",
      "[^a]: see `L99`.",
    ].join("\n");
    const scan = scanFootnotes(body);
    expect(scan.references).toEqual(["a", "missing"]);
    expect(scan.definitions).toEqual([{ id: "a", text: "see `L99`." }]);
  });

  it("does not let a `<!--` inside a fenced block open a comment", () => {
    // The fence contains a blank line, so no inline code span covers the
    // `<!--`: fence state must be what keeps it code. A comment opened here
    // would swallow the prose (both references) up to the later `-->`.
    const body = [
      "```html",
      "<!-- your note here",
      "",
      "```",
      "claim.[^a] dangling.[^missing]",
      "<!-- reviewer note -->",
      "[^a]: Source text.",
    ].join("\n");
    const scan = scanFootnotes(body);
    expect(scan.references).toEqual(["a", "missing"]);
    expect(scan.definitions).toEqual([{ id: "a", text: "Source text." }]);
  });

  it("treats `<!-->` as a complete (empty) comment", () => {
    // `<!-->` closes itself, so what follows is prose: the `[^real]` survives
    // and the later `-->` is just text, not a comment terminator reaching back.
    const scan = scanFootnotes("<!-->\nReal.[^real]\n-->\nMore.[^more]\n");
    expect(scan.references).toEqual(["real", "more"]);
  });

  it("treats `<!--->` as a complete (empty) comment", () => {
    const scan = scanFootnotes("<!--->\nReal.[^real]\n-->\nMore.[^more]\n");
    expect(scan.references).toEqual(["real", "more"]);
  });

  it("treats `<!---->` as a closed comment hiding nothing after it", () => {
    const scan = scanFootnotes("a <!----> b.[^a]\n\nMore.[^b]\n");
    expect(scan.references).toEqual(["a", "b"]);
  });

  it("does not open a comment on an unclosed inline `<!--` in prose", () => {
    // No `-->` follows anywhere, so the `<!--` is plain text and hides
    // nothing: every reference and the definition are found.
    const scan = scanFootnotes(
      "Write <!-- to start a comment.[^a]\n\nLater.[^b]\n\n[^a]: Text A.\n[^b]: Text B.\n",
    );
    expect(scan.references).toEqual(["a", "b"]);
    expect(scan.definitions.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("does not open a comment on an unclosed line-start `<!--`", () => {
    // Same rule at line start: no closing `-->` anywhere, so not a comment.
    const scan = scanFootnotes(
      "<!-- unclosed\nReal.[^real]\n\n[^real]: Text.\n",
    );
    expect(scan.references).toEqual(["real"]);
    expect(scan.definitions).toEqual([{ id: "real", text: "Text." }]);
  });

  it("opens a comment on `<!--` when a `-->` follows on a later line", () => {
    const scan = scanFootnotes(
      "Note <!-- hidden [^h]\nmore [^h2]\n-->\nShown.[^a]\n",
    );
    expect(scan.references).toEqual(["a"]);
  });

  it("does not count a `-->` that comes before the `<!--`", () => {
    // The only `-->` sits before the opener (on the same line), so nothing
    // closes the comment: the `<!--` is text and `[^s]` is a reference.
    const scan = scanFootnotes("a --> b <!-- c [^s]\n\nMore.[^m]\n");
    expect(scan.references).toEqual(["s", "m"]);
  });

  it("opens a comment on `<!--` when a `-->` follows on the same line", () => {
    const scan = scanFootnotes("x <!-- hidden [^h] --> shown.[^a]\n");
    expect(scan.references).toEqual(["a"]);
  });

  it("ends an unclosed inline code span at a blank line before a comment", () => {
    // The lone backtick must not carry over the blank line: the comment
    // below is a real comment, so its reference stays hidden.
    const scan = scanFootnotes("a ` b\n\n<!-- hidden [^h] -->\nshown.[^a]\n");
    expect(scan.references).toEqual(["a"]);
  });

  it("ends an unclosed inline code span at a fence opener before a comment", () => {
    const scan = scanFootnotes(
      "a `x\n```\n```\n<!-- hidden [^h] -->\nshown.[^a]\n",
    );
    expect(scan.references).toEqual(["a"]);
  });

  it("ends an unclosed inline code span at a line-start comment", () => {
    // An HTML block interrupts the paragraph, so the unpaired backtick does
    // not swallow the comment or the references after it.
    const scan = scanFootnotes(
      "Press ` to open.[^a]\n<!-- TODO -->\nMore `foo`.[^b]\n",
    );
    expect(scan.references).toEqual(["a", "b"]);
  });

  it("ends an unclosed inline code span at a line-start comment indented up to three spaces", () => {
    const scan = scanFootnotes(
      "Press ` x.[^a]\n  <!-- TODO -->\nMore `foo`.[^b]\n",
    );
    expect(scan.references).toEqual(["a", "b"]);
  });
});
