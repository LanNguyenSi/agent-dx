import { describe, expect, it } from "vitest";
import {
  formatSourceLineId,
  hashSourceText,
  isSourceLineId,
  normalizeSourceText,
  parseSourceLineId,
  splitSourceLines,
} from "../../src/formats/index.js";

const HELLO_HASH =
  "64ec88ca00b268e5ba1a35678a1b5316d212f4f366b2477232534a8aeca37f3c";

const BOM = String.fromCharCode(0xfeff);

describe("source line hash and ID", () => {
  it("hashes the UTF-8 bytes of the normalised text with SHA-256", () => {
    expect(hashSourceText("Hello world")).toBe(HELLO_HASH);
  });

  it("builds the ID as L<position>-<first 12 hex characters>", () => {
    const lines = splitSourceLines("Hello world");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      position: 1,
      kind: "text",
      normalized: "Hello world",
      hash: HELLO_HASH,
      id: "L1-64ec88ca00b2",
    });
  });

  it("parses and formats the ID", () => {
    expect(parseSourceLineId("L17-64ec88ca00b2")).toEqual({
      ok: true,
      value: { position: 17, hash: "64ec88ca00b2" },
    });
    expect(formatSourceLineId(17, HELLO_HASH)).toBe("L17-64ec88ca00b2");
    expect(isSourceLineId("L1-64ec88ca00b2")).toBe(true);
    for (const bad of [
      "L0-64ec88ca00b2",
      "L1-64ec88ca00b",
      "L1-64EC88CA00B2",
      "1-64ec88ca00b2",
      "L01-64ec88ca00b2",
      "L1-64ec88ca00b2x",
    ]) {
      expect(isSourceLineId(bad)).toBe(false);
      expect(parseSourceLineId(bad).ok).toBe(false);
    }
    expect(() => formatSourceLineId(0, HELLO_HASH)).toThrow(RangeError);
    expect(() => formatSourceLineId(1, "abc")).toThrow(RangeError);
  });
});

describe("source line normalisation", () => {
  it.each([
    ["Hello   world", "Hello world"],
    ["  Hello world  ", "Hello world"],
    ["- Hello world", "Hello world"],
    ["* Hello world", "Hello world"],
    ["+ Hello world", "Hello world"],
    ["12. Hello world", "Hello world"],
    ["3) Hello world", "Hello world"],
    ["# Hello world", "Hello world"],
    ["###### Hello world", "Hello world"],
    ["> Hello world", "Hello world"],
    ["> - [ ] Hello world", "Hello world"],
    ["- [x] Hello world", "Hello world"],
    ["- [X] Hello world", "Hello world"],
    ["**Hello** _world_", "Hello world"],
    ["`Hello` ~~world~~", "Hello world"],
    ["| Hello | world |", "Hello world"],
    ["see [docs](https://x.test)", "see docs https://x.test"],
    ["Hello\tworld", "Hello world"],
    ["Hello world", "Hello world"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeSourceText(input)).toBe(expected);
  });

  it.each(["", "   ", "---", "***", "* * *", "===", "|---|:---:|", "-", ">"])(
    "%j normalises to nothing",
    (input) => {
      expect(normalizeSourceText(input)).toBe("");
    },
  );

  it("keeps case and applies Unicode NFC", () => {
    expect(normalizeSourceText("HELLO")).toBe("HELLO");
    expect(normalizeSourceText("é")).toBe("é");
  });

  it("keeps a hash mark that is not followed by a space", () => {
    expect(normalizeSourceText("#1 priority")).toBe("#1 priority");
  });
});

describe("splitting a source text", () => {
  it("numbers non-empty units from 1 and skips empty ones", () => {
    const lines = splitSourceLines("# Title\n\n- one\n---\n\n- two\n");
    expect(lines.map((l) => [l.position, l.normalized])).toEqual([
      [1, "Title"],
      [2, "one"],
      [3, "two"],
    ]);
  });

  it("accepts \\n, \\r\\n and \\r line breaks alike", () => {
    const a = splitSourceLines("one\ntwo\nthree");
    expect(splitSourceLines("one\r\ntwo\r\nthree")).toEqual(a);
    expect(splitSourceLines("one\rtwo\rthree")).toEqual(a);
  });

  it("ignores a leading byte order mark", () => {
    expect(splitSourceLines(BOM + "Hello world")).toEqual(
      splitSourceLines("Hello world"),
    );
  });

  it("gives the same text at two positions two IDs with one hash", () => {
    const [a, b] = splitSourceLines("same\nother\nsame");
    const c = splitSourceLines("same\nother\nsame")[2]!;
    expect(a!.hash).toBe(c.hash);
    expect(a!.id).not.toBe(c.id);
    expect(b!.position).toBe(2);
  });

  it("changes the ID when the content changes and when the position changes", () => {
    const base = splitSourceLines("one\ntwo")[1]!;
    expect(splitSourceLines("one\ntwo!")[1]!.id).not.toBe(base.id);
    expect(splitSourceLines("zero\none\ntwo")[2]!.id).not.toBe(base.id);
    expect(splitSourceLines("zero\none\ntwo")[2]!.hash).toBe(base.hash);
  });

  it("ignores formatting-only changes", () => {
    expect(splitSourceLines("- **Hello** world")[0]!.id).toBe(
      splitSourceLines("Hello   world")[0]!.id,
    );
  });

  it("counts a fenced code block as one unit, whatever its length", () => {
    const lines = splitSourceLines(
      ["before", "```ts", "x = 1", "", "y", "```", "after"].join("\n"),
    );
    expect(lines.map((l) => [l.kind, l.normalized])).toEqual([
      ["text", "before"],
      ["code", "code:x = 1 y"],
      ["text", "after"],
    ]);
    expect(lines[1]!.hash).toBe(
      "6c0ac620dcf7d9233f294ee97ca3b4500018a53b6dac6263cd66d59e9d8c3343",
    );
  });

  it("counts a tilde fence, an empty fence and an unclosed fence as one unit each", () => {
    expect(splitSourceLines("~~~\na\nb\n~~~").map((l) => l.normalized)).toEqual(
      ["code:a b"],
    );
    expect(splitSourceLines("```\n```").map((l) => l.normalized)).toEqual([
      "code:",
    ]);
    expect(
      splitSourceLines("text\n```\nnever closed\nstill code").map(
        (l) => l.normalized,
      ),
    ).toEqual(["text", "code:never closed still code"]);
  });

  it("closes a fence only with a fence of the same character and at least the same length", () => {
    const lines = splitSourceLines("````\n```\nstill inside\n````\nafter");
    expect(lines.map((l) => l.normalized)).toEqual([
      "code:``` still inside",
      "after",
    ]);
    const tilde = splitSourceLines("~~~\n```\nstill inside\n~~~");
    expect(tilde.map((l) => l.normalized)).toEqual(["code:``` still inside"]);
  });

  it("does not treat an indented block as code", () => {
    const lines = splitSourceLines("    indented text");
    expect(lines.map((l) => [l.kind, l.normalized])).toEqual([
      ["text", "indented text"],
    ]);
  });

  it("counts a Markdown image as one unit of its own", () => {
    const lines = splitSourceLines("![diagram](img/a.png)");
    expect(lines.map((l) => [l.kind, l.normalized])).toEqual([
      ["image", "image:img/a.png"],
    ]);
    expect(lines[0]!.hash).toBe(
      "15ad09c1d3281cbe145d94c541a14d8c590f8ee9be8d535981767fb0c2967dfb",
    );
  });

  it("puts a line's remaining text before its images, images in order", () => {
    const lines = splitSourceLines(
      'See ![one](a.png) and ![two](b.png "title") here',
    );
    expect(lines.map((l) => [l.kind, l.normalized])).toEqual([
      ["text", "See and here"],
      ["image", "image:a.png"],
      ["image", "image:b.png"],
    ]);
  });

  it("does not take a link for an image", () => {
    const lines = splitSourceLines("see [docs](https://x.test)");
    expect(lines.map((l) => [l.kind, l.normalized])).toEqual([
      ["text", "see docs https://x.test"],
    ]);
    expect(lines[0]!.hash).toBe(
      "f165cd6bd78bbfb1621c88f1fe478c19b06a1ffc320ea2aec264df4ba753499c",
    );
  });

  it("returns no unit for an empty or blank text", () => {
    expect(splitSourceLines("")).toEqual([]);
    expect(splitSourceLines("\n \n\t\n")).toEqual([]);
  });
});
