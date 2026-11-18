import { UsageError } from "./errors.js";
import {
  isoDateEpoch,
  maskHtmlComments,
  parseHeading,
  scanFences,
} from "./rules/reserved-files-structure.js";

/**
 * Adds one entry to the text of a bundle's `log.md`, in the position and
 * shape the file already uses (see `reserved-files-structure` for the rules
 * the result must keep: entries newest first, level-2 `## YYYY-MM-DD` date
 * headings):
 *
 *  - the log has date headings: the entry goes first under the heading of
 *    `stamp`'s UTC date, which is created above the newest heading when that
 *    one is older; when the newest heading is LATER than the stamp's date no
 *    position keeps the order, so the call refuses (`UsageError`)
 *  - the log is a flat bullet list (no date headings): the entry goes above
 *    the first bullet
 *  - the log has neither: a date heading and the entry are appended
 *
 * The entry reads `- <stamp>, <text>`, the shape the bundles' own entries
 * use. Entries are separated by a blank line when the existing ones are, and
 * packed when they are not. Headings and bullets inside a fenced block or an
 * HTML comment are not looked at. Line endings of the file are kept, and the
 * result ends with one line ending.
 */
export function addLogEntry(raw: string, stamp: string, text: string): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const masked = maskHtmlComments(lines.join("\n")).split("\n");
  const fenced = scanFences(masked);
  const dateHeadings: Array<{ index: number; date: string }> = [];
  const bullets: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (fenced[i]) continue;
    const heading = parseHeading(masked[i]);
    if (heading) {
      if (heading.level === 2 && isoDateEpoch(heading.text) !== null) {
        dateHeadings.push({ index: i, date: heading.text });
      }
      continue;
    }
    if (masked[i].startsWith("- ")) bullets.push(i);
  }

  const today = stamp.slice(0, 10);
  const entry = entryLines(stamp, text);
  const newest = dateHeadings[0];

  if (newest !== undefined) {
    if (newest.date > today) {
      throw new UsageError(
        `log.md: the newest date heading \`## ${newest.date}\` is later than ${today}, so an entry for ${today} has no position that keeps the log newest first`,
      );
    }
    if (newest.date === today) {
      let at = newest.index + 1;
      while (at < lines.length && lines[at].trim() === "") at++;
      const loose = isLoose(
        lines,
        bullets.filter((b) => b > newest.index),
      );
      if (at >= lines.length) {
        lines.push("", ...entry);
      } else {
        lines.splice(at, 0, ...entry, ...(loose ? [""] : []));
      }
    } else {
      lines.splice(newest.index, 0, `## ${today}`, "", ...entry, "");
    }
  } else if (bullets.length > 0) {
    lines.splice(
      bullets[0],
      0,
      ...entry,
      ...(isLoose(lines, bullets) ? [""] : []),
    );
  } else {
    if (lines.length > 0) lines.push("");
    lines.push(`## ${today}`, "", ...entry);
  }

  return lines.join(eol) + eol;
}

/** `- <stamp>, <text>`; a multi-line text continues on lines indented by two spaces. */
function entryLines(stamp: string, text: string): string[] {
  const [first, ...rest] = text.trim().split(/\r?\n/);
  return [
    `- ${stamp}, ${first.trim()}`,
    ...rest.map((line) => (line.trim() === "" ? "" : `  ${line.trimEnd()}`)),
  ];
}

/** True when the first two of `bullets` are separated by a blank line, or when there is at most one (a lone entry reads as loose). */
function isLoose(lines: string[], bullets: number[]): boolean {
  if (bullets.length < 2) return true;
  return lines[bullets[1] - 1].trim() === "";
}
