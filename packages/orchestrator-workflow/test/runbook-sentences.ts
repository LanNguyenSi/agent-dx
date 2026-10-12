/**
 * Sentence extraction for the runbook rule guard in runbook-selection.test.ts.
 * It lives outside a `*.test.ts` file so that the guard and a one-off
 * listing of the current sentences (when vetting a deliberate wording
 * change) use the same segmentation.
 *
 * A runbook sentence is a sentence of an installed markdown asset that names
 * a runbook, a checklist, or the data authority, plus the sentence right
 * before it and the sentence right after it in the same paragraph or list
 * item, which can refer to it without naming it ("Every step of those is
 * mandatory." before it, "It becomes ..." or "Such a defect ..." after it),
 * plus the first sentence of the next paragraph or list item (a heading does
 * not count as one), which can carry such a reference across the break.
 * Fenced code is skipped, HTML comment delimiters are dropped, and headings,
 * list items, and table rows each start a new paragraph.
 *
 * Known limit: a sentence that refers to a runbook only by a pronoun or a
 * synonym and sits outside that window (two or more sentences away, or in a
 * later paragraph than the one right after) is not a runbook sentence, so
 * neither guard sees it. Review stays the primary control for such wording.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { ASSETS_DIR } from "../src/assets.js";

export const RUNBOOK_SUBJECT =
  /run[- ]?books?|checklist|authority: ?`?data|`data`|data[- ]authority/i;

/** Every markdown asset the kit installs, as a `/`-separated path under assets/. */
export function assetMarkdownFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) {
        found.push(relative(ASSETS_DIR, full).split(sep).join("/"));
      }
    }
  };
  walk(ASSETS_DIR);
  return found.sort();
}

/** Paragraphs and list items of a markdown document, each on one line. */
export function proseUnits(doc: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length > 0) units.push(current.join(" "));
    current = [];
  };
  for (const raw of doc.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === "") {
      flush();
      continue;
    }
    const standalone = /^#{1,6} /.test(line) || line.startsWith("|");
    if (standalone || /^([-*]|\d+\.) /.test(line)) flush();
    current.push(line);
    if (standalone) flush();
  }
  flush();
  return units
    .map((unit) =>
      unit
        .replace(/<!--|-->/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s*([-*]|\d+\.)\s+/, "")
        .trim(),
    )
    .filter((unit) => unit.length > 0);
}

/**
 * Sentences of one unit. The splitter breaks after a period followed by white
 * space, so a file name such as `06-handoff.md` stays inside its sentence and
 * a semicolon never separates a clause from the qualifier it carries.
 */
export function sentencesOf(unit: string): string[] {
  return unit
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The runbook sentences of a markdown document (see the module comment). */
export function runbookSentences(doc: string): string[] {
  const found: string[] = [];
  // The first sentence of the next prose unit is in the window when a unit
  // before it names a runbook; a heading carries no prose of its own, so it
  // does not use up that slot.
  let carry = false;
  for (const unit of proseUnits(doc)) {
    const heading = /^#{1,6} /.test(unit);
    const sentences = sentencesOf(unit);
    const names = sentences.map((sentence) => RUNBOOK_SUBJECT.test(sentence));
    sentences.forEach((sentence, i) => {
      if (
        names[i] ||
        (i > 0 && names[i - 1]) ||
        (i + 1 < sentences.length && names[i + 1]) ||
        (i === 0 && carry && !heading)
      ) {
        found.push(sentence);
      }
    });
    const named = names.some(Boolean);
    if (heading) carry = carry || named;
    else carry = named;
  }
  return found;
}
