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
 * All four surfaces now carry the same shared parenthetical listing the
 * three reasons (a CLI option description, two Markdown documents, and
 * a TSDoc comment each wrap it at their own column width, but the words
 * themselves are one shared list, not four independent prose forms).
 * The three reasons are still matched by stable key phrases rather than
 * one exact string, since the surfaces still differ in punctuation and
 * backtick use around that shared list; the match is scoped to the
 * parenthetical itself, not the whole surrounding section, so a key
 * phrase appearing elsewhere in the section (unrelated prose, or a
 * different check's own parenthetical) can never make this guard pass
 * for the wrong reason. Backticks are stripped before matching so a
 * Markdown surface's `` `PATH` `` and a plain-text surface's `PATH` are
 * the same match.
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
 * drift this guard exists to catch. Heading lines inside a fenced code
 * block (between a pair of ``` lines) are never treated as headings --
 * a `#` comment inside a fenced `bash`/`json` example would otherwise
 * be mistaken for a Markdown heading and could truncate or misplace the
 * section this extracts. */
function extractMarkdownSection(
  markdown: string,
  headingPattern: RegExp,
): string {
  const lines = markdown.split("\n");
  const isFence = (line: string): boolean => /^\s*```/.test(line);

  let inFence = false;
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && headingPattern.test(lines[i])) {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) {
    throw new Error(
      `no heading matching ${String(headingPattern)} found; the doctor ` +
        "section may have been renamed or removed",
    );
  }
  const startLevel = /^#+/.exec(lines[startIndex])?.[0].length ?? 0;

  inFence = false;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const level = /^#+/.exec(lines[i])?.[0].length ?? 0;
    if (level > 0 && level <= startLevel) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

/** Marker immediately following the `--target` option's description
 * literal in `src/cli.ts` today: the next commander `.option(...)`
 * argument, its parser function. Exact rather than a generous window,
 * so a future unrelated line landing within a wide window can never be
 * mistaken for part of the description this guard reads. */
const CLI_TARGET_OPTION_MARKER = '"--target <list>",';
const CLI_TARGET_NEXT_ARG_MARKER = "collectList,";

/** Extracts the `--target` option's description string from
 * `src/cli.ts`: everything between the option's own declaration
 * (`"--target <list>",`) and the next commander argument
 * (`collectList,`), which is exactly the quoted description literal
 * plus its surrounding whitespace and trailing comma. Throws when
 * either marker is absent, since a renamed option flag or a reordered
 * argument list is itself the kind of drift this guard exists to
 * catch, not something a wide fallback window should paper over. */
function extractCliTargetDescription(cliSource: string): string {
  const optionIdx = cliSource.indexOf(CLI_TARGET_OPTION_MARKER);
  if (optionIdx === -1) {
    throw new Error(
      `no ${CLI_TARGET_OPTION_MARKER} option declaration found in src/cli.ts`,
    );
  }
  const descriptionStart = optionIdx + CLI_TARGET_OPTION_MARKER.length;
  const nextArgIdx = cliSource.indexOf(
    CLI_TARGET_NEXT_ARG_MARKER,
    descriptionStart,
  );
  if (nextArgIdx === -1) {
    throw new Error(
      `no ${CLI_TARGET_NEXT_ARG_MARKER} marker found after the --target ` +
        "option description in src/cli.ts",
    );
  }
  return cliSource.slice(descriptionStart, nextArgIdx);
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

/** Slices out the shared fallback-reasons parenthetical from a
 * surface's already-scoped text: the `(...)` group that follows the
 * LAST occurrence of the word `co-located` in that text. Every one of
 * the four surfaces mentions `co-located` at least once before the
 * reasons list itself (introducing the guess the reasons explain the
 * fallback to), so the reasons parenthetical is always the one nearest
 * to, and after, that final mention -- never an earlier, unrelated
 * parenthetical the same surface's prose happens to contain (an aside
 * about the guess being "a filesystem stat, no spawn", for instance).
 * Matching against this narrower slice, not the whole surface section,
 * is what stops a dropped reason from being masked by the same words
 * appearing elsewhere in the section. Throws when no `co-located`
 * mention, or no parenthetical after it, is found. */
function extractCoLocatedParenthetical(text: string): string {
  const marker = "co-located";
  let searchFrom = 0;
  let lastMarkerIdx = -1;
  for (;;) {
    const idx = text.indexOf(marker, searchFrom);
    if (idx === -1) break;
    lastMarkerIdx = idx;
    searchFrom = idx + marker.length;
  }
  if (lastMarkerIdx === -1) {
    throw new Error(`no "${marker}" mention found in surface text`);
  }
  const openIdx = text.indexOf("(", lastMarkerIdx);
  if (openIdx === -1) {
    throw new Error(
      `no fallback-reasons parenthetical found after the last "${marker}" ` +
        "mention in surface text",
    );
  }
  const closeIdx = text.indexOf(")", openIdx);
  if (closeIdx === -1) {
    throw new Error(
      "fallback-reasons parenthetical is missing its closing paren",
    );
  }
  return text.slice(openIdx + 1, closeIdx);
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
        const parenthetical = normalizeForMatch(
          extractCoLocatedParenthetical(surface.read()),
        );
        expect(parenthetical).toContain(reason.keyPhrase);
      });
    }
  }

  it("every surface names all three reasons, none of them silently reduced to a subset", () => {
    for (const surface of SURFACES) {
      const parenthetical = normalizeForMatch(
        extractCoLocatedParenthetical(surface.read()),
      );
      const missing = FALLBACK_REASONS.filter(
        (reason) => !parenthetical.includes(reason.keyPhrase),
      ).map((reason) => reason.name);
      expect(
        missing,
        `${surface.name} is missing: ${missing.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("src/cli.ts extraction stays bounded and ends exactly at the next option argument", () => {
    // Pins the exact-bounds contract extractCliTargetDescription relies
    // on: a regression back to a generous fallback window (which could
    // pull in hundreds of characters of unrelated `.action` body) fails
    // here even if it happened to still contain the three key phrases.
    const cliSource = fs.readFileSync(
      path.join(PACKAGE_ROOT, "src", "cli.ts"),
      "utf8",
    );
    const description = extractCliTargetDescription(cliSource);
    expect(description.length).toBeLessThan(600);
    expect(description.trimEnd().endsWith('",')).toBe(true);
    expect(
      cliSource.indexOf(
        CLI_TARGET_NEXT_ARG_MARKER,
        cliSource.indexOf(CLI_TARGET_OPTION_MARKER) +
          CLI_TARGET_OPTION_MARKER.length,
      ),
    ).toBe(
      cliSource.indexOf(CLI_TARGET_OPTION_MARKER) +
        CLI_TARGET_OPTION_MARKER.length +
        description.length,
    );
  });

  it("src/doctor/index.ts emits one runtime detail fragment per documented fallback reason, in the same order the docs list them", () => {
    // The check's own runtime detail strings use different words than
    // the docs' parenthetical (a grammatical sentence fragment folded
    // into a wider message, versus a short parenthetical list), by
    // design: negative_space for this round forbids changing either
    // wording to make them match literally. This instead pins the
    // mapping between the two vocabularies explicitly, so a future edit
    // that drops or reorders one of the three runtime fragments (not
    // just the docs' words) still fails a test.
    //
    //   docs' key phrase (FALLBACK_REASONS)      runtime detail fragment (src/doctor/index.ts)
    //   ----------------------------------------  ----------------------------------------------
    //   "absent from PATH"                        "python3 not found on PATH"
    //   "resolving nothing"                        "did not resolve a cache path"
    //   "doctor's aggregate spawn deadline
    //    already spent"                            "doctor's aggregate spawn deadline"
    const DETAIL_FRAGMENTS = [
      "python3 not found on PATH",
      "did not resolve a cache path",
      "doctor's aggregate spawn deadline",
    ];
    const doctorSource = fs.readFileSync(
      path.join(PACKAGE_ROOT, "src", "doctor", "index.ts"),
      "utf8",
    );
    // Scoped to the `fallbackNotes` construction, not the whole file:
    // the docblock above (already covered by its own surface test)
    // repeats "doctor's aggregate spawn deadline already spent" in
    // prose earlier in the file, which would otherwise be matched
    // instead of the runtime emission this test targets.
    const emissionStart = doctorSource.indexOf(
      "const fallbackNotes: string[] = [];",
    );
    expect(emissionStart).toBeGreaterThan(-1);
    const emissionSource = doctorSource.slice(emissionStart);

    let searchFrom = 0;
    for (const fragment of DETAIL_FRAGMENTS) {
      const idx = emissionSource.indexOf(fragment, searchFrom);
      expect(
        idx,
        `expected src/doctor/index.ts to emit "${fragment}" after offset ${searchFrom} within the fallbackNotes construction`,
      ).toBeGreaterThan(-1);
      searchFrom = idx + fragment.length;
    }
  });
});
