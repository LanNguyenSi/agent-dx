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
 * not count as one), which can carry such a reference across the break, plus,
 * when the first sentence of a paragraph or list item names one, the last
 * sentence of the previous paragraph or list item (a heading does not count
 * as one, and a heading never opens this window), which can be a lead-in line
 * ending in a colon above a list ("Every step below is mandatory:").
 * Fenced code (backtick or tilde fences) is skipped, HTML comment delimiters
 * are dropped, and headings, list items (`-`, `*`, `+`, or a number and a
 * period), and table rows each start a new paragraph. A sentence ends at a
 * period or a question mark followed by white space; a colon does not end one,
 * since `authority: data` and a `key: value` pair contain one.
 *
 * Known limit: a sentence that refers to a runbook only by a pronoun or a
 * synonym and sits outside that window (two or more sentences away, or in a
 * paragraph further from the runbook sentence than the one right before or
 * right after it) is not a runbook sentence, so neither guard sees it. The
 * same holds for a lead-in whose colon-ended sentence shares its paragraph
 * with an earlier sentence (only its last sentence is in the window), and for a
 * runbook named only in a later sentence of the unit that follows the lead-in
 * (only a unit whose first sentence names one opens the window). Review stays
 * the primary control for such wording.
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
  let fence = "";
  const flush = () => {
    if (current.length > 0) units.push(current.join(" "));
    current = [];
  };
  for (const raw of doc.split(/\r?\n/)) {
    const line = raw.trim();
    const opening = line.match(/^(`{3,}|~{3,})/);
    if (fence === "") {
      if (opening) {
        flush();
        fence = opening[1];
        continue;
      }
    } else {
      // A fence closes with the same character, at least as long as the opener.
      if (
        opening &&
        opening[1][0] === fence[0] &&
        opening[1].length >= fence.length
      ) {
        fence = "";
      }
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
    const standalone = /^#{1,6} /.test(line) || line.startsWith("|");
    if (standalone || /^([-*+]|\d+\.) /.test(line)) flush();
    current.push(line);
    if (standalone) flush();
  }
  flush();
  return units
    .map((unit) =>
      unit
        .replace(/<!--|-->/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s*([-*+]|\d+\.)\s+/, "")
        .trim(),
    )
    .filter((unit) => unit.length > 0);
}

/**
 * Sentences of one unit. The splitter breaks after a period or a question mark
 * followed by white space, so a file name such as `06-handoff.md` stays inside its sentence and
 * a semicolon never separates a clause from the qualifier it carries.
 */
export function sentencesOf(unit: string): string[] {
  return unit
    .split(/(?<=[.?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The runbook sentences of a markdown document (see the module comment). */
export function runbookSentences(doc: string): string[] {
  const units = proseUnits(doc).map((unit) => {
    const sentences = sentencesOf(unit);
    return {
      heading: /^#{1,6} /.test(unit),
      sentences,
      names: sentences.map((sentence) => RUNBOOK_SUBJECT.test(sentence)),
      keep: sentences.map(() => false),
    };
  });
  // The first sentence of the next prose unit is in the window when a unit
  // before it names a runbook; a heading carries no prose of its own, so it
  // does not use up that slot.
  let carry = false;
  // The previous prose unit, whose last sentence is in the window when the
  // current unit opens with a runbook sentence (a heading never opens it).
  let previous: (typeof units)[number] | undefined;
  for (const unit of units) {
    const { heading, sentences, names, keep } = unit;
    sentences.forEach((_sentence, i) => {
      keep[i] =
        names[i] ||
        (i > 0 && names[i - 1]) ||
        (i + 1 < sentences.length && names[i + 1]) ||
        (i === 0 && carry && !heading);
    });
    if (!heading && previous && names[0]) {
      previous.keep[previous.keep.length - 1] = true;
    }
    const named = names.some(Boolean);
    if (heading) carry = carry || named;
    else carry = named;
    if (!heading) previous = unit;
  }
  return units.flatMap((unit) =>
    unit.sentences.filter((_sentence, i) => unit.keep[i]),
  );
}
