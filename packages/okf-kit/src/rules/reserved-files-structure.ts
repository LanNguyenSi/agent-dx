import type { Finding, Rule, Severity } from "../types.js";

const RULE_ID = "reserved-files-structure";

/**
 * Body structure of the two reserved files, on top of `reserved-files-bare`
 * (which only checks that they carry no frontmatter block). The OKF spec
 * (v0.1 section 7 / v0.2 section 9, conformance v0.1 9.3 / v0.2 11.3)
 * reserves `log.md` and `index.md` at any depth and constrains their bodies.
 *
 * Severity is spec-version dependent (operator decision, binding): the
 * existing corpus predates the log format, so `log.md` findings are errors
 * only under v0.2 and warnings under v0.1. `index.md` free prose is a SHOULD
 * in the spec, so it is a warning under both versions.
 */

// A CommonMark ATX heading: 0 to 3 leading spaces, 1 to 6 `#`, then either
// end of line or whitespace followed by the heading text. `#foo` (no space)
// is not a heading, matching CommonMark. The trailing group drops an optional
// closing sequence of `#` (## Title ##).
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

// A level-2 date heading's whole text must be exactly this: a four-digit year,
// a two-digit month, a two-digit day. Whether the day actually exists on a
// calendar is a separate check (see `isoDateEpoch`), so `2026-02-30` matches
// the shape here but is still rejected as a date.
const ISO_DATE_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A list item: any indent, then an unordered (`-`, `*`, `+`) or an ordered
// (digits then `.`/`)`) marker, then at least one space or tab and the item's
// content. The space-or-tab after the marker keeps `---` (a thematic break)
// and `1999.9` (no space after the dot) from reading as a list item.
const LIST_ITEM_RE = /^ *([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

// A list item is a conformant index entry when its content begins with a
// markdown link. The description after the link (the spec writes ` - <text>`)
// is optional and its exact separator is not enforced: `[Title](url)`,
// `[Title](url) - description`, `[Title](url), description` and a description
// that wraps onto following lines all begin with the same link, and the spec
// only says SHOULD.
const LINK_AT_START_RE = /^\[[^\]]*\]\([^)]*\)/;

// An HTML comment span, blanked out of both bodies before classification so
// a comment line never reads as free prose or as a heading (the index-side
// masking mirrors `prose-line-references`).
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

type Heading = { level: number; text: string };

function parseHeading(line: string): Heading | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const text = (m[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: m[1].length, text };
}

// The start of a fence delimiter line: up to 3 leading spaces, then 3 or
// more backticks or 3 or more tildes. Group 1 is that run of fence
// characters, group 2 the rest of the line (an opener's info string, or a
// closer's trailing whitespace). 4+ leading spaces is an indented code
// block, not a fence, hence the space cap.
const FENCE_RUN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Per-line "inside a fenced code block" flags (delimiter lines included),
 * following the CommonMark fence rules:
 *  - opener: `FENCE_RUN_RE`, any info string may follow the run; the one
 *    exception is a backtick fence whose info string contains a backtick,
 *    which is not a fence at all (a plain paragraph line);
 *  - closer: up to 3 leading spaces, the SAME character as the opener's run,
 *    at least as many of them as the opener had, followed by nothing but
 *    whitespace (only an opener may carry an info string);
 *  - an unclosed fence runs to the end of the file.
 *
 * This is deliberately its own scanner rather than `citations-resolve`'s
 * `scanFenceLines`, which is stricter than CommonMark there (it rejects any
 * info string with a space, so `` ``` bash `` would not open a fence and its
 * closing marker would flip the state of the whole rest of the file); the
 * reserved files show real documents inside fences and must follow the real
 * rules. A fence line is neither a heading nor prose here, and the callers
 * only ever ask "is this line fence content or a delimiter", so flat flags
 * are all this returns.
 */
function scanFences(lines: string[]): boolean[] {
  const fences: boolean[] = [];
  let openRun: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RUN_RE.exec(lines[i] ?? "");
    if (openRun === undefined) {
      const backtickInfoWithBacktick =
        m !== null && m[1][0] === "`" && m[2].includes("`");
      if (m !== null && !backtickInfoWithBacktick) {
        openRun = m[1];
        fences.push(true);
      } else {
        fences.push(false);
      }
      continue;
    }
    if (
      m !== null &&
      m[1][0] === openRun[0] &&
      m[1].length >= openRun.length &&
      m[2].trim() === ""
    ) {
      openRun = undefined;
    }
    fences.push(true);
  }
  return fences;
}

/** The epoch (ms) of `text` when it is a real calendar ISO date, else null. */
function isoDateEpoch(text: string): number | null {
  const m = ISO_DATE_SHAPE_RE.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return null;
  // Date.UTC maps years 0-99 onto 1900+, which the round-trip check below
  // rejects; a real log heading never uses such a year.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

function isListItem(line: string): { content: string } | null {
  const m = LIST_ITEM_RE.exec(line);
  return m ? { content: m[2].trim() } : null;
}

/** Replaces every HTML comment span with same-length blank space (newlines
 * kept), so a comment's text is invisible to the prose scan while the line
 * count and every other line's columns stay put. */
function maskHtmlComments(text: string): string {
  return text.replace(HTML_COMMENT_RE, (span) => span.replace(/[^\n]/g, " "));
}

/**
 * Line offset of a doc's body inside its raw file: reserved files must be
 * bare, but a bundle-root v0.2 `index.md` legally carries an `okf_version`
 * frontmatter block, so body line N is raw line N + offset. Reserved-file
 * findings must point at the real file line, hence the offset.
 */
function bodyLineOffset(raw: string, body: string): number {
  return raw.split(/\r?\n/).length - body.split(/\r?\n/).length;
}

export const reservedFilesStructureRule: Rule = {
  id: RULE_ID,
  description:
    "Body structure of the reserved files. `log.md`: every level-2 heading must be exactly `## YYYY-MM-DD` (a real calendar date, nothing after it), and the date headings must be strictly newest first; an error under OKF v0.2, a warning under v0.1. `index.md`: should be headings plus `- [Title](url) - description` link entries, so a free-prose paragraph is a warning (both versions). A conformant optional `# ...` title, list items that are links without a description, nested list items that are links, fenced code blocks and HTML comments are all accepted.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      if (!doc.isReserved) continue;
      if (doc.basename === "log.md") {
        findings.push(
          ...checkLog(doc.relPath, doc.raw, doc.body, ctx.specVersion),
        );
      } else if (doc.basename === "index.md") {
        findings.push(...checkIndex(doc.relPath, doc.raw, doc.body));
      }
    }
    return findings;
  },
};

/**
 * `log.md`: entries are grouped under level-2 ISO date headings, newest first.
 * Content under a heading is free, so only headings are inspected. Fenced code
 * blocks and HTML comments never contribute headings (the comment masking
 * blanks the comment text out line for line, exactly as in `checkIndex`, so
 * the line numbers of everything outside the comment stay the raw-file lines).
 *
 * Findings:
 *  - one per level-2 heading whose text is not exactly a real ISO date (extra
 *    text, a non-date heading, a malformed or impossible date);
 *  - one per heading at the wrong level whose text IS a bare ISO date (a date
 *    that should have been a level-2 heading);
 *  - one file-level finding when a non-empty `log.md` has no valid date heading
 *    at all and none of the per-heading findings above applies (the heading-less
 *    case: a flat bullet list, a lone title), so the two never double-report the
 *    same file;
 *  - one per date heading that is not strictly older than the previous valid
 *    date heading (out of order, or the same date twice).
 */
function checkLog(
  file: string,
  raw: string,
  body: string,
  specVersion: string,
): Finding[] {
  const findings: Finding[] = [];
  const severity: Severity = specVersion === "v0.2" ? "error" : "warning";
  const offset = bodyLineOffset(raw, body);
  const lines = maskHtmlComments(body).split(/\r?\n/);
  // One fence scan for the whole body (see `scanFences`): delimiter lines and
  // the lines between them all read fenced, and a fence closes only on a run
  // of the same character that is at least as long as the opener's, so a
  // `~~~` line inside a ``` block stays content.
  const fences = scanFences(lines);
  const validDates: { epoch: number; text: string; line: number }[] = [];
  let perHeadingFindings = 0;

  for (let i = 0; i < lines.length; i++) {
    if (fences[i]) continue;

    const heading = parseHeading(lines[i]);
    if (!heading) continue;

    const dateEpoch = isoDateEpoch(heading.text);
    const line = offset + i + 1;
    if (heading.level === 2) {
      if (dateEpoch === null) {
        findings.push({
          ruleId: RULE_ID,
          severity,
          file,
          message: `log.md level-2 heading \`## ${heading.text}\` (line ${line}) is not exactly \`## YYYY-MM-DD\`; log.md entries must group under a level-2 ISO date heading, newest first.`,
        });
        perHeadingFindings++;
      } else {
        validDates.push({ epoch: dateEpoch, text: heading.text, line });
      }
    } else if (dateEpoch !== null) {
      findings.push({
        ruleId: RULE_ID,
        severity,
        file,
        message: `log.md date heading \`${"#".repeat(heading.level)} ${heading.text}\` (line ${line}) uses heading level ${heading.level}; date headings must be level 2 (\`## YYYY-MM-DD\`).`,
      });
      perHeadingFindings++;
    }
  }

  if (
    perHeadingFindings === 0 &&
    validDates.length === 0 &&
    body.trim() !== ""
  ) {
    findings.push({
      ruleId: RULE_ID,
      severity,
      file,
      message:
        "log.md has no `## YYYY-MM-DD` date headings; log.md entries must be grouped under level-2 ISO date headings, newest first.",
    });
  }

  for (let i = 1; i < validDates.length; i++) {
    const prev = validDates[i - 1];
    const cur = validDates[i];
    if (cur.epoch >= prev.epoch) {
      findings.push({
        ruleId: RULE_ID,
        severity,
        file,
        message: `log.md date heading \`## ${cur.text}\` (line ${cur.line}) is not older than the previous \`## ${prev.text}\` (line ${prev.line}); date headings must be strictly newest first.`,
      });
    }
  }

  return findings;
}

/**
 * `index.md`: headings plus `- [Title](url) - description` link entries. A run
 * of free-prose lines (one paragraph) is a single warning naming its first
 * line. A line is free prose when it is not blank, not a heading, not inside a
 * fenced code block or an HTML comment, and not part of a list entry. A list
 * item is an entry when its content begins with a markdown link; its wrapped
 * description lines belong to that item (never a separate paragraph), and a
 * nested list item is an entry when it is a link. A list item that is not a
 * link (a bullet of plain text, top level or nested) reads as free prose.
 */
function checkIndex(file: string, raw: string, body: string): Finding[] {
  const findings: Finding[] = [];
  const offset = bodyLineOffset(raw, body);
  const masked = maskHtmlComments(body);
  const lines = masked.split(/\r?\n/);
  // Same fence scan as `checkLog` (see `scanFences`): every line of a fenced
  // block, delimiters included, reads fenced, and a fence closes only on a
  // run of the same character that is at least as long as the opener's.
  const fences = scanFences(lines);
  let i = 0;

  // True when `index` is not a line that continues the block currently open:
  // a blank line, a fence (opening, closing, or inside) or a heading always
  // closes any block; a list item additionally closes a free-prose paragraph
  // (an entry never lives inside a prose paragraph).
  const closesBlock = (index: number, forProse: boolean): boolean => {
    if (index >= lines.length) return true;
    if (fences[index]) return true;
    const trimmed = lines[index].trim();
    if (trimmed === "") return true;
    if (parseHeading(lines[index])) return true;
    if (forProse && isListItem(lines[index])) return true;
    return false;
  };

  while (i < lines.length) {
    if (fences[i]) {
      i++;
      continue;
    }
    const trimmed = lines[i].trim();
    if (trimmed === "" || parseHeading(lines[i])) {
      i++;
      continue;
    }

    if (isListItem(lines[i])) {
      // Walk the whole list block: each list-item line is judged on its own
      // (a non-link item is free prose), while wrapped description lines are
      // absorbed into the item they continue. The block ends at a blank line,
      // a fence or a heading.
      let j = i;
      while (true) {
        const item = isListItem(lines[j]);
        if (item && !LINK_AT_START_RE.test(item.content)) {
          findings.push(proseFinding(file, offset, j));
        }
        if (closesBlock(j + 1, false)) break;
        j++;
      }
      i = j + 1;
      continue;
    }

    // Free prose paragraph: one finding at its first line, then skip its
    // continuation lines.
    findings.push(proseFinding(file, offset, i));
    let j = i + 1;
    while (!closesBlock(j, true)) j++;
    i = j;
  }

  return findings;
}

function proseFinding(
  file: string,
  offset: number,
  bodyIndex: number,
): Finding {
  return {
    ruleId: RULE_ID,
    severity: "warning",
    file,
    message: `index.md should list entries as \`- [Title](url) - description\` under headings, not free prose (line ${offset + bodyIndex + 1}).`,
  };
}
