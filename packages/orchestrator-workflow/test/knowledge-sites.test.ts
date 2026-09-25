import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every kit text site that mentions `docs/okf` (the default bundle
 * location) outside a fenced code block. A repository can configure
 * `knowledge` in `.ai/workflow/manifest.json` to point at a different bundle
 * location (see init.ts's `KnowledgeBundle`); no prose site may describe
 * `docs/okf` as the sole, hard-coded locator without also naming the
 * configured list it is the default of. This is the drift check named by
 * this task's AC3.
 */
const SCANNED_FILES = [
  "README.md",
  "assets/agents/explorer.md",
  "assets/agents/implementer.md",
  "assets/agents/reviewer.md",
  "assets/agents/task-slicer.md",
  "assets/skill/references/evidence-and-probes.md",
  "assets/templates/02-tasks.md",
  "assets/templates/06-handoff.md",
];

/**
 * Lines allowlisted as concrete examples, not normative locator claims: a
 * verification-set JSON snippet's literal `argv` naming `docs/okf` for a
 * repository that does use the default. Keyed by file, each entry is a
 * distinctive substring of the allowed line (not the whole line, so
 * rewrapping does not break the allowlist).
 */
const EXAMPLE_ARGV_ALLOWLIST: Record<string, string[]> = {
  "README.md": ['"npx", "okf-kit", "check", "docs/okf"'],
};

function stripFencedCodeBlocks(content: string): string[] {
  const lines = content.split("\n");
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    kept.push(inFence ? "" : line);
  }
  return kept;
}

describe("no kit text site hard-codes docs/okf as the sole knowledge-bundle locator", () => {
  for (const relPath of SCANNED_FILES) {
    it(`${relPath}`, () => {
      const content = readFileSync(`${PACKAGE_DIR}${relPath}`, "utf8");
      const allowlist = EXAMPLE_ARGV_ALLOWLIST[relPath] ?? [];
      const lines = stripFencedCodeBlocks(content);
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("docs/okf")) continue;
        if (allowlist.some((needle) => line.includes(needle))) continue;
        // A prose sentence (or paragraph) naming docs/okf can wrap across
        // several lines; look at this line plus the four immediately before
        // and after for the "knowledge" back-reference (the configured
        // `knowledge` field, or the words "knowledge bundle").
        const window = lines
          .slice(Math.max(0, i - 4), Math.min(lines.length, i + 5))
          .join(" ");
        if (!/knowledge/i.test(window)) {
          offenders.push(`line ${i + 1}: ${line.trim()}`);
        }
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});
