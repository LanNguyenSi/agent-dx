import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the run-together class a review found in this README (a
 * commit-introduced `` `--pass-regex`predicate `` and neighbouring
 * `` `pass`,`` / ``its `summary`and`failures`come`` adjacencies): an
 * inline code span with no space between its backtick and the prose
 * word on either side. A naive `` /[A-Za-z0-9]`[^`]+`[A-Za-z0-9]/ `` scan
 * both over- and under-counts: it fires on two unrelated spans sharing
 * one line ("`a`, and `b`done" matches the stretch from `a`'s closing
 * backtick to `b`'s opening one) and on fenced code, and it misses a
 * span glued on only one side. `findRunTogethers` instead strips fenced
 * blocks, pairs same-length backtick runs into spans across the whole
 * document (an inline span may itself wrap a soft line break), and
 * flags a span only when the character immediately before its opening
 * backtick or immediately after its closing backtick is `[A-Za-z0-9]`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, "..", "README.md");
const DOCS_DIR = path.join(__dirname, "..", "docs");

/** README.md plus every `docs/*.md` file, each paired with a label used
 * in its own `it` title, so a run-together introduced in a moved
 * reference doc is caught the same way one in the README is. */
function scannedDocFiles(): { label: string; filePath: string }[] {
  const docsFiles = fs
    .readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      label: `docs/${name}`,
      filePath: path.join(DOCS_DIR, name),
    }));
  return [{ label: "README.md", filePath: README_PATH }, ...docsFiles];
}

export interface RunTogether {
  /** 1-based line number where the glued character sits. */
  line: number;
  /** Which side of the code span is glued to a word character. */
  side: "before" | "after";
  /** A short slice of the surrounding text for a human-readable report. */
  context: string;
}

interface BacktickRun {
  start: number;
  end: number;
  length: number;
}

interface Span {
  start: number;
  end: number;
}

/**
 * Blanks out fenced code blocks (``` or ~~~ fences of length >= 3),
 * keeping line numbers stable so callers can report accurate positions.
 * A fence closes on any line starting with the same fence character
 * repeated at least three times, mirroring common Markdown fence
 * matching (exact-length re-matching is not needed here: this package's
 * README nests neither fence character inside the other's block).
 */
function stripFencedBlocks(text: string): string {
  const lines = text.split("\n");
  let fenceChar: string | null = null;
  let fenceLength = 0;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    const fenceOpen = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceChar === null) {
      if (fenceOpen) {
        fenceChar = fenceOpen[1][0];
        fenceLength = fenceOpen[1].length;
        return "";
      }
      return line;
    }
    // CommonMark: a closing fence uses the same character and is at least
    // as long as the opening fence.
    if (
      fenceOpen &&
      fenceOpen[1][0] === fenceChar &&
      fenceOpen[1].length >= fenceLength
    ) {
      fenceChar = null;
      fenceLength = 0;
    }
    return "";
  });
  return out.join("\n");
}

/** Finds backtick runs, then pairs each opener with the next later run
 * of the same length to form inline code spans (CommonMark's matching
 * rule, simplified: this README never nests a shorter run inside a
 * longer one). */
function extractSpans(text: string): Span[] {
  const runs: BacktickRun[] = [];
  const runRegex = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = runRegex.exec(text)) !== null) {
    runs.push({
      start: match.index,
      end: match.index + match[0].length,
      length: match[0].length,
    });
  }
  const spans: Span[] = [];
  let i = 0;
  while (i < runs.length) {
    const opener = runs[i];
    let matched = false;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].length === opener.length) {
        spans.push({ start: opener.start, end: runs[j].end });
        i = j + 1;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return spans;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Scans Markdown `text` for an inline code span glued to an adjacent
 * word character outside fenced blocks. Exported so a seeded string can
 * be asserted against directly, without touching README.md. */
export function findRunTogethers(text: string): RunTogether[] {
  const stripped = stripFencedBlocks(text);
  const spans = extractSpans(stripped);
  const findings: RunTogether[] = [];
  const contextOf = (span: Span) =>
    stripped
      .slice(
        Math.max(0, span.start - 20),
        Math.min(stripped.length, span.end + 20),
      )
      .replace(/\n/g, " / ");
  for (const span of spans) {
    const before = span.start > 0 ? stripped[span.start - 1] : "";
    const after = span.end < stripped.length ? stripped[span.end] : "";
    if (/[A-Za-z0-9]/.test(before)) {
      findings.push({
        line: lineOf(stripped, span.start),
        side: "before",
        context: contextOf(span),
      });
    }
    if (/[A-Za-z0-9]/.test(after)) {
      findings.push({
        line: lineOf(stripped, span.end),
        side: "after",
        context: contextOf(span),
      });
    }
  }
  return findings;
}

describe("findRunTogethers()", () => {
  it("finds nothing in a clean sentence", () => {
    expect(
      findRunTogethers("a check that ends `fail` or `error` with zero"),
    ).toEqual([]);
  });

  it("flags a word glued before a code span", () => {
    const findings = findRunTogethers("a check that ends`fail` with zero");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.side).toBe("before");
  });

  it("flags a word glued after a code span", () => {
    const findings = findRunTogethers("see `timedOut`or the exit code");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.side).toBe("after");
  });

  it("keeps a longer fence open across a shorter fence-like line", () => {
    const text = [
      "````md",
      "```",
      "still`inside`the block",
      "````",
      "outside `ok` here",
    ].join("\n");
    expect(findRunTogethers(text)).toHaveLength(0);
  });

  it("does not flag two separate code spans that merely share a line", () => {
    // A naive /[A-Za-z0-9]`[^`]+`[A-Za-z0-9]/ scan would match the
    // stretch from `a`'s closing backtick through to `b`'s opening one;
    // the span-aware scanner must not.
    expect(findRunTogethers("see `a`, and `b` done")).toEqual([]);
  });

  it("ignores a run-together inside a fenced code block", () => {
    const fenced = ["```", "word`code`word", "```"].join("\n");
    expect(findRunTogethers(fenced)).toEqual([]);
  });

  it("flags a span that wraps a soft line break the same as one on a single line", () => {
    const wrapped = 'is `status:\n"usage_error"` and more';
    expect(findRunTogethers(wrapped)).toEqual([]);
    const glued = 'is `status:\n"usage_error"`glued and more';
    const findings = findRunTogethers(glued);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.side).toBe("after");
  });
});

describe("packages/agent-primitives README.md and docs/*.md have no inline-code run-togethers", () => {
  for (const { label, filePath } of scannedDocFiles()) {
    it(`finds zero run-togethers outside fenced blocks in ${label}`, () => {
      const text = fs.readFileSync(filePath, "utf8");
      expect(findRunTogethers(text)).toEqual([]);
    });
  }
});
