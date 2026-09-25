import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * The back-reference every kit text sentence that names `docs/okf` must
 * carry. A repository can configure `knowledge` in
 * `.ai/workflow/manifest.json` to point at other bundle locations (see
 * init.ts's `KnowledgeBundle`); `docs/okf` is only the default, so no prose
 * sentence may name it without naming the configured list it is the
 * default of.
 */
const BACK_REFERENCE = "`knowledge` in `.ai/workflow/manifest.json`";

/**
 * Sentences allowlisted as concrete examples, not locator claims: a
 * verification-set JSON snippet's literal `argv` naming `docs/okf` for a
 * repository that does use the default. Keyed by file, each entry is a
 * distinctive substring of the allowed sentence.
 */
const EXAMPLE_ALLOWLIST: Record<string, string[]> = {
  "README.md": ['"npx", "okf-kit", "check", "docs/okf"'],
};

/** README.md, INSTALL-AGENT.md and every Markdown file under assets/. */
function scannedFiles(): string[] {
  const files = ["README.md", "INSTALL-AGENT.md"];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) {
        files.push(relative(PACKAGE_DIR, full));
      }
    }
  };
  walk(join(PACKAGE_DIR, "assets"));
  return files.sort();
}

/** Replaces every line inside a fenced code block, fences included, with
 * an empty line, so line numbers stay aligned with the file. */
function blankFencedCodeBlocks(lines: string[]): string[] {
  let inFence = false;
  return lines.map((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

interface Sentence {
  text: string;
  line: number;
}

/**
 * Splits prose into sentences. A block ends at a blank line, a heading, or
 * the start of a list item; inside a block, lines are joined with single
 * spaces and split after `.`, `!` or `?` (optionally followed by a closing
 * bracket, quote or backtick) when whitespace and an upper-case letter,
 * backtick, bracket or asterisk follow.
 */
function sentences(content: string): Sentence[] {
  const lines = blankFencedCodeBlocks(content.split("\n"));
  const blocks: { text: string; line: number }[] = [];
  let current: { parts: string[]; line: number } | null = null;
  const flush = (): void => {
    if (current)
      blocks.push({ text: current.parts.join(" "), line: current.line });
    current = null;
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      return;
    }
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s)/.test(trimmed)) flush();
    if (!current) current = { parts: [], line: index + 1 };
    current.parts.push(trimmed);
  });
  flush();
  const result: Sentence[] = [];
  for (const block of blocks) {
    for (const text of block.text.split(/(?<=[.!?][)"'`]*)\s+(?=[A-Z`(*[])/)) {
      result.push({ text, line: block.line });
    }
  }
  return result;
}

/** Every sentence naming `docs/okf` without the back-reference. */
function offendingSentences(
  content: string,
  allowlist: string[] = [],
): string[] {
  return sentences(content)
    .filter(({ text }) => text.includes("docs/okf"))
    .filter(({ text }) => !allowlist.some((needle) => text.includes(needle)))
    .filter(({ text }) => !text.includes(BACK_REFERENCE))
    .map(({ text, line }) => `block at line ${line}: ${text}`);
}

describe("no kit text site hard-codes docs/okf as the sole knowledge-bundle locator", () => {
  it("scans SKILL.md, the templates and README among the files", () => {
    const files = scannedFiles();
    for (const expected of [
      "README.md",
      "assets/skill/SKILL.md",
      "assets/templates/06-handoff.md",
      "assets/skill/references/evidence-and-probes.md",
    ]) {
      expect(files).toContain(expected);
    }
  });

  for (const relPath of scannedFiles()) {
    it(relPath, () => {
      const content = readFileSync(join(PACKAGE_DIR, relPath), "utf8");
      const offenders = offendingSentences(
        content,
        EXAMPLE_ALLOWLIST[relPath] ?? [],
      );
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }

  it("flags the pre-change wording and accepts the back-reference", () => {
    expect(
      offendingSentences(
        "Check whether the repo carries a curated\nknowledge bundle (for example a `docs/okf/` directory with an\n`index.md`): if one exists, read it.",
      ),
    ).toHaveLength(1);
    expect(
      offendingSentences(
        "- Require the bundle\n  check whenever the repository has `docs/okf/`, regardless of edit scope.\n- Other item names `knowledge` in `.ai/workflow/manifest.json`.",
      ),
    ).toHaveLength(1);
    expect(
      offendingSentences(
        "First sentence names `knowledge` in `.ai/workflow/manifest.json`. Second sentence names docs/okf alone.",
      ),
    ).toHaveLength(1);
    expect(
      offendingSentences(
        "```\ndocs/okf in a fence\n```\nA bundle (`knowledge` in\n`.ai/workflow/manifest.json`; default `docs/okf/`) exists.",
      ),
    ).toEqual([]);
  });

  it("reports the file line of the block, fences counted", () => {
    expect(offendingSentences("```\nx\n```\n\nNames docs/okf alone.")).toEqual([
      "block at line 5: Names docs/okf alone.",
    ]);
  });
});
