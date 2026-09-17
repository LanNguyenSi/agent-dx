import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The `python-bytecode-cache` check's fallback to a co-located
 * `__pycache__` guess has exactly three reasons (`python3` absent from
 * `PATH`, a `python3` that did not resolve a cache path, and doctor's
 * own aggregate spawn deadline already spent), and an operator reading
 * any ONE of the four surfaces below should see all three named, not a
 * subset. This mechanically pins that invariant across all four
 * surfaces at once, reading each from disk (never a copy-pasted
 * fixture), so a future edit to any one surface that drops a reason (or
 * that stops naming it in words a human -- or this guard -- can find)
 * fails here instead of only being caught by review.
 *
 * The three reasons are matched by stable key phrases rather than one
 * exact sentence, since the four surfaces are different prose forms
 * (a CLI option description, two Markdown documents, a TSDoc comment)
 * that are not expected to share one literal sentence, only the same
 * three facts. Backticks are stripped before matching so a Markdown
 * surface's `` `PATH` `` and a plain-text surface's `PATH` are the same
 * match.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, "..");

interface FallbackReason {
  name: string;
  /** Matched case-sensitively against the surface's text with
   * backticks stripped. */
  keyPhrase: string;
}

const FALLBACK_REASONS: FallbackReason[] = [
  { name: "python3 absent from PATH", keyPhrase: "absent from PATH" },
  { name: "python3 resolving nothing", keyPhrase: "resolving nothing" },
  {
    name: "doctor's aggregate spawn deadline already spent",
    keyPhrase: "doctor's aggregate spawn deadline already spent",
  },
];

/** Strips Markdown/TSDoc backticks and collapses every run of
 * whitespace (including the line breaks these four surfaces are all
 * hand-wrapped at, at various column widths) to a single space, so a
 * key phrase that a surface's own wrapping happens to split across two
 * lines still matches. The phrase itself, not the source file's line
 * length, is what this guard cares about. */
function normalizeForMatch(text: string): string {
  return text.replaceAll("`", "").replace(/\s+/g, " ").trim();
}

interface Surface {
  name: string;
  /** Reads the surface's own slice of the file (never the whole file),
   * so a key phrase that happens to appear elsewhere in a large file
   * (a changelog entry, an unrelated section) can never make this
   * guard pass for the wrong reason. */
  read: () => string;
}

/** Extracts one named section of a Markdown file: from its heading line
 * up to (excluding) the next heading of the same or a shallower level.
 * Throws (rather than returning an empty slice a missing-reason
 * assertion would then blame on the wrong cause) when the heading is
 * not found, since a renamed or removed heading is itself the kind of
 * drift this guard exists to catch. */
function extractMarkdownSection(
  markdown: string,
  headingPattern: RegExp,
): string {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => headingPattern.test(line));
  if (startIndex === -1) {
    throw new Error(
      `no heading matching ${String(headingPattern)} found; the doctor ` +
        "section may have been renamed or removed",
    );
  }
  const startLevel = /^#+/.exec(lines[startIndex])?.[0].length ?? 0;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const level = /^#+/.exec(lines[i])?.[0].length ?? 0;
    if (level > 0 && level <= startLevel) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

/** Extracts the `--target` option's description from `src/cli.ts`: the
 * quoted string literal on the same line as `"--target"`. Read as a
 * single line rather than parsed as TypeScript, since only the
 * description string's own words are the surface under test. */
function extractCliTargetDescription(cliSource: string): string {
  const line = cliSource
    .split("\n")
    .find((l) => l.includes('"--target') && l.includes("description"));
  if (line !== undefined) return line;
  // The description may live on a following line from the option
  // declaration; fall back to the whole option block by locating
  // "--target" and taking a generous window of source after it.
  const idx = cliSource.indexOf('"--target');
  if (idx === -1) {
    throw new Error('no "--target" option declaration found in src/cli.ts');
  }
  return cliSource.slice(idx, idx + 1200);
}

/** Extracts the `DoctorOptions` interface body from `src/doctor/index.ts`,
 * by its own declaration through its closing brace at column 0 (the
 * style every interface in this file is written in), then strips each
 * line's leading TSDoc comment marker (an opening slash-star-star, a
 * closing star-slash, or a line-leading star) before joining with
 * spaces: left in place, a marker sitting between two words a
 * comment's own line wrap split (`resolving`, newline, `nothing`) would
 * survive whitespace collapsing as a literal star token wedged inside
 * the phrase this guard is looking for. */
function extractDoctorOptionsInterface(doctorSource: string): string {
  const startIdx = doctorSource.indexOf("export interface DoctorOptions");
  if (startIdx === -1) {
    throw new Error("no `export interface DoctorOptions` found");
  }
  const endIdx = doctorSource.indexOf("\n}", startIdx);
  if (endIdx === -1) {
    throw new Error("DoctorOptions interface has no closing brace");
  }
  return doctorSource
    .slice(startIdx, endIdx)
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, ""))
    .join(" ");
}

const SURFACES: Surface[] = [
  {
    name: "src/cli.ts (--target option description)",
    read: () =>
      extractCliTargetDescription(
        fs.readFileSync(path.join(PACKAGE_ROOT, "src", "cli.ts"), "utf8"),
      ),
  },
  {
    name: "assets/skill/SKILL.md (## 4. Doctor)",
    read: () =>
      extractMarkdownSection(
        fs.readFileSync(
          path.join(PACKAGE_ROOT, "assets", "skill", "SKILL.md"),
          "utf8",
        ),
        /^#{1,6}\s+4\.\s+Doctor\s*$/,
      ),
  },
  {
    name: "README.md (## `doctor`)",
    read: () =>
      extractMarkdownSection(
        fs.readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8"),
        /^#{1,6}\s+`doctor`\s*$/,
      ),
  },
  {
    name: "src/doctor/index.ts (DoctorOptions docblock)",
    read: () =>
      extractDoctorOptionsInterface(
        fs.readFileSync(
          path.join(PACKAGE_ROOT, "src", "doctor", "index.ts"),
          "utf8",
        ),
      ),
  },
];

describe("doctor: python-bytecode-cache fallback wording, across all four surfaces", () => {
  for (const surface of SURFACES) {
    for (const reason of FALLBACK_REASONS) {
      it(`${surface.name} names "${reason.name}"`, () => {
        const text = normalizeForMatch(surface.read());
        expect(text).toContain(reason.keyPhrase);
      });
    }
  }

  it("every surface names all three reasons, none of them silently reduced to a subset", () => {
    for (const surface of SURFACES) {
      const text = normalizeForMatch(surface.read());
      const missing = FALLBACK_REASONS.filter(
        (reason) => !text.includes(reason.keyPhrase),
      ).map((reason) => reason.name);
      expect(
        missing,
        `${surface.name} is missing: ${missing.join(", ")}`,
      ).toEqual([]);
    }
  });
});
