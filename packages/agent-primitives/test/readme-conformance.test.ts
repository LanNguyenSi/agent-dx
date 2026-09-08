import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REFUSAL_RESULT_SHAPE,
  type RefusalReason,
} from "../src/probe/session.js";

/**
 * Parses README.md's "Refusal reason shape" table (under "Result
 * shape") and asserts it equals `REFUSAL_RESULT_SHAPE`
 * (`src/probe/session.ts`) exactly, in both directions: every reason
 * the code contract carries has a matching row here with the same
 * `mutant`/`mutation_probe` presence, and the table names no reason the
 * code contract does not. Parsed from the real file on disk (never a
 * copy-pasted fixture), so an edit to one without the other fails this
 * test rather than only being caught by a human diff review.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, "..", "README.md");

interface ParsedRow {
  reason: string;
  mutant: boolean;
  mutationProbe: boolean;
}

/** Extracts the `| \`reason\` | \`mutant\` | \`mutation_probe\` | ... |`
 * table under the "#### Refusal reason shape" heading: every row from
 * the first `|` row after the header separator up to the next blank
 * line followed by non-table text (in practice: the next line that does
 * not start with `|`). */
function parseRefusalReasonShapeTable(readme: string): ParsedRow[] {
  const headingIndex = readme.indexOf("#### Refusal reason shape");
  if (headingIndex === -1) {
    throw new Error(
      'README.md has no "#### Refusal reason shape" heading; the ' +
        "result-shape section may have been renamed or removed",
    );
  }
  const afterHeading = readme.slice(headingIndex);
  const lines = afterHeading.split("\n");
  const headerRowIndex = lines.findIndex((line) =>
    line.trim().startsWith("| `reason`"),
  );
  if (headerRowIndex === -1) {
    throw new Error(
      'no "| `reason` | ..." header row found under "#### Refusal ' +
        'reason shape"',
    );
  }
  // Bind columns by header cell, not by position: a swap of the
  // `mutant`/`mutation_probe` header cells is a real regression (the
  // rows beneath would then be read under the wrong column), and
  // reading positionally instead of checking the header text would
  // silently let that swap through.
  const headerLine = lines[headerRowIndex];
  const headerCells = headerLine
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const [reasonHeader, mutantHeader, mutationProbeHeader, ...restHeaders] =
    headerCells;
  if (
    reasonHeader !== "`reason`" ||
    mutantHeader !== "`mutant`" ||
    mutationProbeHeader !== "`mutation_probe`" ||
    restHeaders.length !== 1
  ) {
    throw new Error(
      'expected the header row to be exactly "| `reason` | `mutant` | ' +
        `\`mutation_probe\` | <description> |", got: "${headerLine}"`,
    );
  }
  // headerRowIndex + 1 must be the `| --- | --- | ... |` separator row;
  // destroying it (dropping a cell, losing the dashes) would otherwise
  // just shift every data row parsed below by one line without any
  // parse failure to flag it.
  const separatorLine = (lines[headerRowIndex + 1] ?? "").trim();
  if (!/^\|(\s*-{3,}\s*\|)+$/.test(separatorLine)) {
    throw new Error(
      'expected a "| --- | --- | ... |" separator row right after the ' +
        `header, got: "${separatorLine}"`,
    );
  }
  // Data rows start right after the separator row.
  const rows: ParsedRow[] = [];
  for (let i = headerRowIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [reasonCell, mutantCell, mutationProbeCell] = cells;
    const reasonMatch = /^`([a-z_]+)`$/.exec(reasonCell ?? "");
    if (reasonMatch === null) {
      throw new Error(`could not parse a reason from table row: "${line}"`);
    }
    if (mutantCell !== "present" && mutantCell !== "absent") {
      throw new Error(
        `expected "present" or "absent" for \`mutant\` in row: "${line}"`,
      );
    }
    if (mutationProbeCell !== "present" && mutationProbeCell !== "absent") {
      throw new Error(
        `expected "present" or "absent" for \`mutation_probe\` in row: "${line}"`,
      );
    }
    rows.push({
      reason: reasonMatch[1],
      mutant: mutantCell === "present",
      mutationProbe: mutationProbeCell === "present",
    });
  }
  return rows;
}

describe('README.md\'s "Refusal reason shape" table matches REFUSAL_RESULT_SHAPE', () => {
  const readme = fs.readFileSync(README_PATH, "utf8");
  const rows = parseRefusalReasonShapeTable(readme);

  it("parsed at least one row (the table exists and is not empty)", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("names every RefusalReason the code contract carries, and no others", () => {
    const tableReasons = rows.map((r) => r.reason).sort();
    const contractReasons = (
      Object.keys(REFUSAL_RESULT_SHAPE) as RefusalReason[]
    ).sort();
    expect(tableReasons).toEqual(contractReasons);
  });

  it.each(rows)(
    "$reason: README mutant/mutation_probe presence matches REFUSAL_RESULT_SHAPE",
    (row) => {
      const reason = row.reason as RefusalReason;
      const shape = REFUSAL_RESULT_SHAPE[reason];
      expect(shape).toBeDefined();
      expect(row.mutant).toBe(shape.mutant);
      expect(row.mutationProbe).toBe(shape.mutationProbe);
    },
  );
});
