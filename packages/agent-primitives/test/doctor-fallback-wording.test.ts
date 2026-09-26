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
 * Each surface names the three reasons in its own fallback-reasons
 * parenthetical, and those four parentheticals name the same three
 * reasons without being one identical string: docs/doctor.md's own spells
 * the first reason `` `python3` absent from `PATH` `` where the other
 * three spell it `absent from `PATH``, and a CLI option description, two
 * Markdown documents and a TSDoc comment each wrap the list at their own
 * column width. So the three reasons are matched by stable key phrases
 * rather than by one exact literal, with backticks stripped first so a
 * Markdown surface's `` `PATH` `` and a plain-text surface's `PATH` are
 * the same match. The match is scoped to that parenthetical, not to the
 * whole surrounding section, so a key phrase appearing elsewhere in the
 * section (unrelated prose, or a different check's own parenthetical)
 * can never make this guard pass for the wrong reason.
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
 * key phrase -- or the anchor below -- that a surface's own wrapping
 * happens to split across two lines still matches. The phrase itself,
 * not the source file's line length, is what this guard cares about. */
function normalizeForMatch(text: string): string {
  return text.replaceAll("`", "").replace(/\s+/g, " ").trim();
}

/** Every offset `needle` occurs at in `haystack`, non-overlapping. */
function occurrencesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (
    let idx = haystack.indexOf(needle);
    idx !== -1;
    idx = haystack.indexOf(needle, idx + needle.length)
  ) {
    found.push(idx);
  }
  return found;
}

/** The names of the reasons `parenthetical` fails to name, in the
 * canonical order. Empty means all three are named. */
function missingReasons(parenthetical: string): string[] {
  return FALLBACK_REASONS.filter(
    (reason) => !parenthetical.includes(reason.keyPhrase),
  ).map((reason) => reason.name);
}

interface Surface {
  name: string;
  /** Reads the surface's own slice of the file (never the whole file),
   * so a key phrase that happens to appear elsewhere in a large file
   * (a changelog entry, an unrelated section) can never make this
   * guard pass for the wrong reason. */
  read: () => string;
}

/** The Markdown heading level of `line`, or 0 when it is not a heading:
 * a `#` run of one to six, followed by whitespace. The trailing
 * whitespace is what keeps an ordinary prose line that merely starts
 * with a `#` (a line-wrapped `#225 part 2)...` issue reference, for
 * instance) from being read as a heading and ending a section early. */
function headingLevel(line: string): number {
  return /^(#{1,6})\s/.exec(line)?.[1].length ?? 0;
}

/** The fence marker opening or closing a fenced code block on `line`
 * (``` or ~~~, the two CommonMark spellings), or undefined. Tracked by
 * marker rather than as one boolean so a ``` line inside a ~~~ block
 * (or the reverse) does not toggle the other's state. */
function fenceMarker(line: string): string | undefined {
  return /^\s*(```|~~~)/.exec(line)?.[1];
}

/** Extracts one named section of a Markdown file: from its heading line
 * up to (excluding) the next heading of the same or a shallower level.
 * Throws (rather than returning an empty slice a missing-reason
 * assertion would then blame on the wrong cause) when the heading is
 * not found, since a renamed or removed heading is itself the kind of
 * drift this guard exists to catch. Heading lines inside a fenced code
 * block are never treated as headings -- a `#` comment inside a fenced
 * `bash`/`json` example would otherwise be mistaken for a Markdown
 * heading and could truncate or misplace the section this extracts. */
function extractMarkdownSection(
  markdown: string,
  headingPattern: RegExp,
): string {
  const lines = markdown.split("\n");

  let openFence: string | undefined;
  const trackFence = (line: string): boolean => {
    const marker = fenceMarker(line);
    if (marker === undefined) return false;
    if (openFence === undefined) openFence = marker;
    else if (openFence === marker) openFence = undefined;
    return true;
  };

  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (trackFence(lines[i])) continue;
    if (openFence === undefined && headingPattern.test(lines[i])) {
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
  const startLevel = headingLevel(lines[startIndex]);
  if (startLevel === 0) {
    throw new Error(
      `line matched by ${String(headingPattern)} is not a Markdown heading: ` +
        lines[startIndex],
    );
  }

  openFence = undefined;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (trackFence(lines[i])) continue;
    if (openFence !== undefined) continue;
    const level = headingLevel(lines[i]);
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

/** The clause every one of the four surfaces uses to introduce the
 * fallback-reasons parenthetical: the reasons are the ways `python3`
 * "cannot be asked or does not answer". This is a semantic anchor, not
 * a positional one -- the parenthetical is identified by the sentence
 * that introduces it, so neither an unrelated parenthetical earlier in
 * the surface nor another mention of the guess later in it changes
 * which `(...)` group is read. */
const FALLBACK_REASONS_ANCHOR = "does not answer";

/** Slices out the fallback-reasons parenthetical from a surface's
 * already-scoped text: the first `(...)` group after the surface's one
 * `does not answer` anchor, normalized. Matching against this narrower
 * slice, not the whole surface section, is what stops a dropped reason
 * from being masked by the same words appearing elsewhere in that
 * section.
 *
 * Fails closed on ambiguity rather than guessing: an anchor that is
 * missing, or that occurs more than once (two introducing clauses, so
 * two candidate parentheticals), throws instead of falling back to a
 * positional rule such as "the last one", which would let a degraded
 * reasons list be masked by a later sentence that happens to repeat the
 * three phrases, and would let a harmless later sentence with a
 * parenthetical of its own take the reasons list's place. */
function extractFallbackReasonsParenthetical(text: string): string {
  const normalized = normalizeForMatch(text);
  const anchors = occurrencesOf(normalized, FALLBACK_REASONS_ANCHOR);
  if (anchors.length === 0) {
    throw new Error(
      `no "${FALLBACK_REASONS_ANCHOR}" anchor found in surface text; the ` +
        "clause introducing the fallback reasons may have been reworded",
    );
  }
  if (anchors.length > 1) {
    throw new Error(
      `"${FALLBACK_REASONS_ANCHOR}" occurs ${String(anchors.length)} times in ` +
        "surface text, so which parenthetical lists the fallback reasons is " +
        "ambiguous",
    );
  }
  const openIdx = normalized.indexOf("(", anchors[0]);
  if (openIdx === -1) {
    throw new Error(
      `no fallback-reasons parenthetical found after the ` +
        `"${FALLBACK_REASONS_ANCHOR}" anchor in surface text`,
    );
  }
  const closeIdx = normalized.indexOf(")", openIdx);
  if (closeIdx === -1) {
    throw new Error(
      "fallback-reasons parenthetical is missing its closing paren",
    );
  }
  return normalized.slice(openIdx + 1, closeIdx);
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
    name: "docs/doctor.md (# `doctor`)",
    read: () =>
      extractMarkdownSection(
        fs.readFileSync(path.join(PACKAGE_ROOT, "docs", "doctor.md"), "utf8"),
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
        const parenthetical = extractFallbackReasonsParenthetical(
          surface.read(),
        );
        expect(parenthetical).toContain(reason.keyPhrase);
      });
    }
  }

  it("every surface names all three reasons, none of them silently reduced to a subset", () => {
    for (const surface of SURFACES) {
      const parenthetical = extractFallbackReasonsParenthetical(surface.read());
      const missing = missingReasons(parenthetical);
      expect(
        missing,
        `${surface.name} is missing: ${missing.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("every surface carries the introducing anchor exactly once, so no surface's reasons parenthetical is ambiguous", () => {
    // The precondition the semantic anchor rests on, asserted against
    // the real surfaces rather than assumed: a second `does not answer`
    // clause appearing in one of these slices would make two
    // parentheticals candidates, and this guard fails closed (see the
    // fixture cases below) rather than picking one.
    for (const surface of SURFACES) {
      const anchors = occurrencesOf(
        normalizeForMatch(surface.read()),
        FALLBACK_REASONS_ANCHOR,
      );
      expect(
        anchors.length,
        `${surface.name} carries "${FALLBACK_REASONS_ANCHOR}" ${String(anchors.length)} times`,
      ).toBe(1);
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
    // The option declaration this extraction starts from is unique in
    // the file, so the slice cannot begin at some other `--target`
    // spelling that a later refactor introduced.
    expect(occurrencesOf(cliSource, CLI_TARGET_OPTION_MARKER).length).toBe(1);
    // And it ends before the next commander argument rather than
    // running on into the surrounding builder chain: none of the tokens
    // that would mark a wider slice appear inside it.
    for (const beyondTheBound of [".option(", ".action(", "collectList"]) {
      expect(
        description,
        `extracted --target description must not reach ${beyondTheBound}`,
      ).not.toContain(beyondTheBound);
    }
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
    // Scoped to the `fallbackNotes` construction itself -- from the
    // array's declaration to the `fallbackNote` join that consumes it,
    // not to the rest of the file: the docblock above (already covered
    // by its own surface test) repeats "doctor's aggregate spawn
    // deadline already spent" in prose earlier in the file, and a
    // future check further down could repeat any of the three, either
    // of which would otherwise be matched instead of the runtime
    // emission this test targets.
    const emissionStart = doctorSource.indexOf(
      "const fallbackNotes: string[] = [];",
    );
    expect(emissionStart).toBeGreaterThan(-1);
    const emissionEnd = doctorSource.indexOf(
      "const fallbackNote =",
      emissionStart,
    );
    expect(emissionEnd).toBeGreaterThan(emissionStart);
    const emissionSource = doctorSource.slice(emissionStart, emissionEnd);

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

/** The three reasons as one of the four surfaces spells them, used only
 * to build the fixtures below. The guard itself never compares against
 * this string; it matches the three key phrases. */
const FIXTURE_REASONS =
  "absent from PATH, resolving nothing, or doctor's aggregate spawn " +
  "deadline already spent";

/** A surface-shaped fixture: the introducing clause, its reasons
 * parenthetical, and whatever prose follows. Shaped after the real
 * `--target` help text, so the extractor is exercised on the same
 * sentence structure the four real surfaces carry. */
function fixtureSurface(reasons: string, tail = ""): string {
  return (
    "for a .py path among these, the CPython bytecode cache python3 " +
    "itself resolves for that file is reported, and a co-located " +
    "__pycache__ is the named fallback whenever python3 cannot be " +
    `asked or does not answer (${reasons}).${tail}`
  );
}

describe("doctor fallback wording: the reasons parenthetical is found semantically, and fails closed", () => {
  it("reads the reasons parenthetical, not an unrelated one the same surface carries earlier", () => {
    const text =
      "a target reached after the deadline is spent falls back to the " +
      "co-located __pycache__ guess (a filesystem stat, no spawn). " +
      fixtureSurface(FIXTURE_REASONS);
    expect(extractFallbackReasonsParenthetical(text)).toBe(FIXTURE_REASONS);
    expect(missingReasons(extractFallbackReasonsParenthetical(text))).toEqual(
      [],
    );
  });

  it("stays on the reasons parenthetical when a later sentence mentions the co-located guess again", () => {
    // A positional rule anchored on the LAST `co-located` mention would
    // move to this trailing sentence's own parenthetical and report all
    // three reasons as missing, failing a surface that is in fact
    // correct. The semantic anchor does not move.
    const text = fixtureSurface(
      FIXTURE_REASONS,
      " The co-located guess itself is a filesystem stat, not a spawn " +
        "(no python3 is started for it).",
    );
    expect(extractFallbackReasonsParenthetical(text)).toBe(FIXTURE_REASONS);
    expect(missingReasons(extractFallbackReasonsParenthetical(text))).toEqual(
      [],
    );
  });

  it("fails when the reasons parenthetical is degraded even though a later sentence still repeats all three phrases", () => {
    // The case a positional anchor passes for the wrong reason: the
    // list an operator actually reads names one reason, while prose
    // further down happens to carry the other two phrases. The guard
    // must read the degraded list, not the prose.
    const text = fixtureSurface(
      "absent from PATH",
      " Historically this list also named a python3 resolving nothing, " +
        "or doctor's aggregate spawn deadline already spent, before the " +
        "check stopped distinguishing them.",
    );
    expect(extractFallbackReasonsParenthetical(text)).toBe("absent from PATH");
    expect(missingReasons(extractFallbackReasonsParenthetical(text))).toEqual([
      "python3 resolving nothing",
      "doctor's aggregate spawn deadline already spent",
    ]);
  });

  it("throws when the introducing clause is gone rather than reading some other parenthetical", () => {
    const text =
      "a co-located __pycache__ is the named fallback whenever python3 " +
      `cannot be asked (${FIXTURE_REASONS}).`;
    expect(() => extractFallbackReasonsParenthetical(text)).toThrow(
      /no "does not answer" anchor found/,
    );
  });

  it("throws when the introducing clause occurs twice, rather than picking one of the two parentheticals", () => {
    const text =
      fixtureSurface(FIXTURE_REASONS) +
      " A second check also falls back whenever its own helper does not " +
      "answer (a different list entirely).";
    expect(() => extractFallbackReasonsParenthetical(text)).toThrow(
      /occurs 2 times/,
    );
  });

  it("throws when no parenthetical follows the introducing clause", () => {
    const text =
      "a co-located __pycache__ is the named fallback whenever python3 " +
      "cannot be asked or does not answer.";
    expect(() => extractFallbackReasonsParenthetical(text)).toThrow(
      /no fallback-reasons parenthetical found/,
    );
  });
});

describe("doctor fallback wording: Markdown section extraction", () => {
  const FIXTURE = [
    "# agent-primitives",
    "",
    "## `doctor`",
    "",
    "A composer link rule remains its own pending task (issue",
    "#225 part 2). For every check without a predicate the plain exit",
    "code is read.",
    "",
    "~~~bash",
    "# agent-primitives doctor --target path/to/module.py",
    "```",
    "## not a heading either",
    "~~~",
    "",
    "```json",
    "~~~",
    "# also inside a fence",
    "```",
    "",
    "The last line of the doctor section.",
    "",
    "## `verify`",
    "",
    "The first line of the next section.",
    "",
  ].join("\n");

  it("does not end the section at a prose line that merely starts with a #", () => {
    // docs/non-js-test-runners.md carries exactly this shape today: a
    // line-wrapped issue reference (`#225 part 2). For every`) sitting
    // at column 0 inside a section. Read as a level-1 heading it would
    // truncate the section right there, and every reason after that point would
    // read as missing.
    const section = extractMarkdownSection(FIXTURE, /^#{1,6}\s+`doctor`\s*$/);
    expect(section).toContain("#225 part 2");
    expect(section).toContain("The last line of the doctor section.");
  });

  it("does not end the section at a # line inside a ~~~ fence", () => {
    const section = extractMarkdownSection(FIXTURE, /^#{1,6}\s+`doctor`\s*$/);
    expect(section).toContain("## not a heading either");
    expect(section).toContain("The last line of the doctor section.");
  });

  it("does not end the section at a # line inside a ``` fence", () => {
    const section = extractMarkdownSection(FIXTURE, /^#{1,6}\s+`doctor`\s*$/);
    expect(section).toContain("# also inside a fence");
    expect(section).toContain("The last line of the doctor section.");
  });

  it("does not let a ``` line inside a ~~~ block (or the reverse) close the other's fence", () => {
    // Each fence in the fixture carries the other marker on a line of
    // its own. Tracked as one boolean, the stray ``` inside the ~~~
    // block would close it, the `## not a heading either` line right
    // after would read as a heading, and the section would end there.
    const section = extractMarkdownSection(FIXTURE, /^#{1,6}\s+`doctor`\s*$/);
    expect(section).toContain("## not a heading either");
    expect(section).toContain("# also inside a fence");
    expect(section).toContain("The last line of the doctor section.");
  });

  it("does end the section at the next real heading of the same level", () => {
    const section = extractMarkdownSection(FIXTURE, /^#{1,6}\s+`doctor`\s*$/);
    expect(section).not.toContain("The first line of the next section.");
    expect(
      section.trimEnd().endsWith("The last line of the doctor section."),
    ).toBe(true);
  });

  it("throws when the heading is gone, rather than returning an empty slice", () => {
    expect(() =>
      extractMarkdownSection(FIXTURE, /^#{1,6}\s+`stethoscope`\s*$/),
    ).toThrow(/may have been renamed or removed/);
  });
});
