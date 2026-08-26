import fs from "node:fs";
import path from "node:path";
import { getValidSources } from "../util.js";
import type { BundleDoc, Finding, Rule } from "../types.js";

const RULE_ID = "citations-resolve";

/**
 * Warn-only checker for `path:N[-M]` citations inside a bundle's docs (and
 * their continuation forms, see below).
 *
 * Ported from agent-grounding's `scripts/okf-citations-resolve.mjs`
 * (PR #185), which was a repo-local, no-dependency spike at closing a gap
 * `sources-fresh` cannot: `sources-fresh` only compares a doc's `sources`
 * list against file mtimes, so it is structurally blind to an edit that
 * shifts line numbers inside a still-fresh source file. This rule finds
 * every `path:N` / `path:N-M` citation in a doc, resolves `path` to a real
 * file, and warns when the citation clearly cannot be pointing at real
 * content any more.
 *
 * What it checks (mechanical only, no symbol/AST resolution):
 *   - the target file does not exist (after resolution, see below)
 *   - a range's end line is before its start line (an inverted range)
 *   - the cited line (or the end of a range) is past the end of the file
 *   - the start line is blank
 *   - for non-markdown targets only, the start line is only a closing
 *     brace/bracket/paren (`}`, `)`, `]`, optionally with a trailing `,`/`;`)
 *     -- a common signature of "the cited block moved and this now points at
 *     the line right after it used to end"
 *
 * What it does NOT check: whether the cited line is semantically the right
 * one (that needs the actual symbol; out of scope for a warn-only mechanical
 * rule), nor citations without a file extension this rule recognises.
 *
 * Hard-wrapped prose. Some docs hard-wrap prose at a fixed column, which can
 * split a hyphenated filename like `run-state-lifecycle-and-markers.md`
 * across a line break right after the trailing `-`. `CITATION_RE` cannot
 * (and should not) span the newline to reassemble the real citedPath, but
 * without a guard it instead matches the phantom tail on its own
 * (`markers.md:172`), which usually does not exist as a file and produces a
 * false `missing-file`. A `CITATION_RE` match is skipped entirely (neither
 * checked nor counted as a real citation) when it starts at column 0 of its
 * line -- optionally after only whitespace or a list/quote marker
 * (`-`, `*`, `>`, digits, `.`) -- and the previous line ends with `-` or
 * `–`: the signature of a wrapped continuation, not a new citation.
 *
 * Unreadable targets. A resolved target file that exists but cannot be read
 * (permission denied, and similar OS-level failures) is reported as a
 * bundle-level `notice` tagged `unreadable-target` with the OS error code in
 * `detail`, rather than throwing and aborting the whole check: a citation
 * pointing at a file the checker itself cannot read is not evidence the
 * citation is wrong.
 *
 * Porting decision (scope cut from the original): the original script also
 * scanned any `docs/testing/*.md` file that an okf doc's frontmatter
 * `sources` cited, an agent-grounding-specific convention (docs/testing is
 * not part of the OKF spec) that is not exercised by any of the ported
 * tests. This rule instead only scans the docs `loadBundle` already loaded
 * for `ctx.bundleDir` -- a citing doc outside the bundle is out of scope.
 *
 * Path resolution. A bundle's prose citations are frequently written
 * *relative to context* rather than as a full repo-root path, e.g. a doc's
 * frontmatter `sources` list carries `packages/foo/src/cli.ts`, but the
 * prose later just says `cli.ts:42` or `src/cli.ts:42` once the reader
 * "knows" which package the section is about -- and source basenames can be
 * reused across sibling packages, so a resolver that only tried
 * repo-root-relative and doc-relative paths would either flag real,
 * non-drifted citations as "missing file" or silently check the wrong
 * same-named file. Resolution here instead tries, in order:
 *   1. the citing doc's own frontmatter `sources` list, matched by exact
 *      suffix (`source === citedPath || source.endsWith('/' + citedPath)`),
 *      only when exactly one source matches -- the doc's author already
 *      disambiguated which physical file this citation means
 *   2. for a citedPath with no `/` only: doc-relative, then each ancestor
 *      directory of the doc up to (and including) repoRoot, nearest first
 *      -- a bare filename like `README.md` almost always means "the README
 *      *for the package this doc lives in*", and a repo-root-relative
 *      lookup done first would instead silently resolve to an unrelated,
 *      differently-sized file of the same name that happens to sit at the
 *      repo root ("shadowing"). A citedPath containing a `/` skips straight
 *      to step 3: the caller already qualified enough of the path that
 *      "closest ancestor" guessing isn't needed.
 *   3. repo-root-relative (`<repoRoot>/<citedPath>`)
 *   4. doc-relative (`<dirname(doc)>/<citedPath>`) -- redundant with step 2
 *      for a no-`/` citedPath (already tried there), the effective first
 *      resolution attempt for a `/`-containing one
 *   5. the nearest earlier citation *in the same doc* whose path contains a
 *      `/` and ends with the same suffix as citedPath (the "last full path
 *      mentioned" convention)
 *   6. a repo-wide search for a file whose path ends with citedPath (or,
 *      for a bare filename, whose basename equals it)
 * A citedPath starting with `/` is treated as out of scope (an absolute or
 * placeholder path, e.g. inside a fabricated example stack trace) and
 * skipped without a finding. When step 6 finds more than one candidate the
 * citation is reported as a `notice`-severity "ambiguous target" finding
 * rather than guessed at or false-flagged as missing (never counted toward
 * `--strict`). A citation resolved by none of the above, with zero
 * candidates at step 6, is reported as `missing-file`. A citedPath
 * containing a `..` segment is rejected outright (`path-traversal-rejected`)
 * without ever being resolved, so a malformed or hostile citation cannot
 * walk resolution outside the repo.
 *
 * Continuation citations. Once a sentence has stated a full `path:N`
 * citation, prose habitually repeats just the line (or range) for a later
 * reference in the same sentence rather than retyping the path, in three
 * forms:
 *   - `` `:N` `` or `` `:N-M` `` -- a bare colon-prefixed line/range
 *   - `` -`M` `` / `` –`M` `` -- a hyphen- or en-dash-led bare line, the
 *     tail half of a `` `path:N`-`M` `` split range
 *   - `` (`N`) `` -- a parenthesized bare line
 * Each of these resolves against `governing`: the nearest *preceding*
 * citation (full or itself a continuation) that resolved to a real file,
 * scanned in document order. `governing` resets to none whenever the
 * citation immediately before it failed to resolve, was ambiguous, or was
 * out of scope (leading `/`) -- a continuation never silently inherits a
 * stale or unrelated path from further up the doc. A continuation with no
 * governing citation at all (e.g. very start of a doc) is skipped, not
 * flagged: there is nothing to validate it against.
 *
 * A continuation is further split into two roles (see
 * collectContinuationAtoms): "fresh" (a genuinely new start line, checked
 * the same five ways as a full citation's start) versus "extension" (only
 * ever the tail `M` of a split range whose start was already checked) --
 * an extension gets *only* the range-bound checks (inverted-range,
 * range-exceeds-file), never blank/closing-brace: that start line was
 * already checked when it was first cited, so re-running it here would
 * double-report the same drift, and a range legitimately ending on a
 * closing brace is normal, not drift.
 *
 * Requires `ctx.repoRoot` (explicit `--repo-root` or auto-detected): target
 * files usually live outside the bundle itself, so without a repo root
 * there is no filesystem tree to resolve a citation against. Without one,
 * this rule emits a single bundle-level notice, matching `sources-fresh`'s
 * "not inside a git work tree" posture.
 */

/**
 * Anchored citations. A full citation (never a continuation or short-form
 * atom -- see below) may carry an anchor directly after its range,
 * `path:N-M#anchor`, e.g. `` `CHANGELOG.md:50-144#0.24.0` ``. Motivation: a
 * CHANGELOG.md grows by insertion at the TOP (newest entry first), so every
 * later entry's absolute line numbers shift on every release; the checks
 * above (missing-file, inverted-range, range-exceeds-file, blank-start-line,
 * closing-brace-start-line) are structurally blind to a citation that
 * shifted a whole release section over and now lands, still non-blank and
 * in-bounds, inside the WRONG section -- a citation `CHANGELOG.md:738-748`
 * meant for the "0.7.4" entry that quietly now points at "0.7.3" prose is
 * exactly as green as before the shift. An anchor closes that gap by
 * pinning the citation to a piece of the target's own structure/content that
 * the line-shift does not preserve automatically.
 *
 * Two anchor kinds, told apart by the raw anchor text (group 4 of
 * `CITATION_RE`, see `parseAnchor`):
 *   - **Heading form** (bare, unquoted, e.g. `#0.24.0` or `#[0.24.0]`):
 *     the target's nearest *enclosing* Markdown heading -- see
 *     `findEnclosingHeading` -- must contain the anchor text, and no
 *     heading of the same or shallower level may start before the range's
 *     end line (i.e. the heading must actually enclose the whole range, not
 *     merely precede its start -- see `checkAnchor`). Deliberately capped at
 *     `ANCHOR_HEADING_MAX_LEVEL` (2): a Keep-a-Changelog CHANGELOG.md nests
 *     `## [x.y.z]` release headings around identically-named `### Added` /
 *     `### Changed` / `### Fixed` subsections repeated in every release;
 *     treating "nearest heading of any level" as the anchor target would
 *     make a heading anchor nearly useless here (matching the wrong
 *     release's own "Changed" subsection just as readily as the right
 *     one's), so subsection headings are transparent to this check and only
 *     level-1/level-2 headings are ever considered.
 *   - **String form** (double-quoted, e.g. `#"reproduction requirement"`):
 *     the anchor text must occur, verbatim, on at least one line of the
 *     cited range itself (`checkAnchor`'s string branch) -- "occurs inside
 *     it" rather than "encloses it". No heading structure required, so this
 *     form also works against a non-Markdown target (`.ts`/`.js`/...) where
 *     "nearest enclosing heading" has no meaning.
 * An anchor mismatch is its own drift finding (`anchor-heading-not-found`,
 * `anchor-heading-mismatch`, `anchor-heading-does-not-enclose`,
 * `anchor-not-found-in-range`), checked only once the base start/range
 * checks (blank-start-line, closing-brace-start-line, inverted-range,
 * range-exceeds-file) already came back clean -- same "one problem per
 * citation, base checks first" pattern `checkShortFormTarget` already uses
 * for the block-boundary check. Every one of these four messages names the
 * anchor text itself, and an anchored full citation's own finding label
 * (`path:N-M#anchor`, see `formatAnchorForLabel`) carries the anchor too --
 * without both, two citations to the identical range with different
 * anchors would be indistinguishable in the output.
 *
 * A `#` that immediately follows a citation's range but does not parse as
 * either anchor form at all (unbalanced quotes, a backtick inside a quoted
 * anchor, or nothing after the `#`) is its own separate, `notice`-severity
 * finding, `anchor-malformed` (see `scanDoc`'s main matching loop): the
 * citation is still checked exactly as an anchorless one would be
 * (backward compatible, see below), but silently checking it anchorless
 * when the `#` right there looks like a typo'd anchor attempt would defeat
 * the entire point of writing one -- a single misplaced character would
 * quietly turn the very check the anchor was written for back off.
 *
 * Backward compatible by construction: the `#anchor` suffix is optional in
 * `CITATION_RE`, so an existing anchorless citation matches exactly as
 * before and is checked exactly as before (this section adds a new check
 * gated on the anchor being present, it does not change any existing one).
 * Deliberately scoped to full citations only: a continuation (`` `:M` ``
 * etc.) or a short-form `:N-M` never carries its own path, so there is
 * nowhere natural to hang an anchor on one without inventing a second,
 * detached syntax; the migration this rule was built for (CHANGELOG.md
 * citations) is written as full citations throughout the corpus it targets.
 *
 * Rejected alternatives (see the PR/CHANGELOG for the fuller writeup):
 *   - Embedding the literal heading markup itself, e.g.
 *     `` `CHANGELOG.md:50-144#"## [0.24.0]"` `` -- verbatim-correct but
 *     `#`, `[`, `]`, and the space all need quoting/escaping right next to
 *     the citation, which reads worse in prose than a bare version token
 *     and gains nothing the structural heading-enclosure check does not
 *     already provide from the shorter form.
 *   - A detached anchor, e.g. a trailing parenthetical `(see "0.24.0")`
 *     elsewhere in the sentence -- unparseable without a second, separate
 *     grammar next to the existing continuation/short-form machinery, and
 *     easy to leave behind (or attach to the wrong citation) when a
 *     sentence is edited later.
 *   - A named-capture-group slug matching `sources-fresh`'s YAML shape --
 *     rejected because it would require a second citation site (frontmatter
 *     plus prose) to stay in sync, the exact class of drift this rule
 *     exists to catch.
 */
const ANCHOR_HEADING_MAX_LEVEL = 2;
const MD_HEADING_RE = /^(#{1,6})\s+(.*)$/;

type Anchor = { kind: "heading" | "string"; text: string };

/**
 * Renders a parsed `Anchor` back to the short form used to disambiguate a
 * finding's citation label (see the `citation` variable in `scanDoc`'s main
 * loop): `#text` for a heading anchor (already bracket-stripped by
 * `parseAnchor`), `#"text"` for a string anchor. Two citations to the same
 * range with different anchors would otherwise be indistinguishable in the
 * output -- see the "Anchored citations" doc block above.
 */
function formatAnchorForLabel(anchor: Anchor): string {
  return anchor.kind === "string" ? `#"${anchor.text}"` : `#${anchor.text}`;
}

/**
 * Parses `CITATION_RE`'s optional 4th capture group (the raw anchor text,
 * including its surrounding quotes or brackets if any) into an `Anchor`, or
 * `null` when the citation carried no `#anchor` suffix at all. A
 * double-quoted raw value (`"..."`) is the string form, text taken verbatim
 * between the quotes; anything else is the heading form, with a single
 * wrapping `[...]` stripped (so `#[0.24.0]` and `#0.24.0` compare
 * identically) -- compared as a plain substring against the heading's own
 * raw text (`findEnclosingHeading`'s `text`, itself never stripped of any
 * brackets it happens to carry), not a stripped copy of it -- see the
 * "Anchored citations" doc block above.
 */
function parseAnchor(raw: string | undefined): Anchor | null {
  if (!raw) return null;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return { kind: "string", text: raw.slice(1, -1) };
  }
  const text =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return { kind: "heading", text };
}

/** Per-line fence state, see `scanFenceLines`. */
type FenceLineState = {
  /** True when this line lies inside a fenced code block, delimiters included. */
  fenced: boolean;
  /** True when this line is the delimiter that opens a fenced code block. */
  opensFence: boolean;
  /**
   * True when this line is the closing delimiter that matches the fence it
   * closes (i.e. the *same* marker, `` ``` `` or `~~~`, that opened it).
   */
  closesFence: boolean;
};

/**
 * The single fence state machine every fence-aware consumer in this file
 * derives from: one forward pass over `lines`, replaying the same
 * open/close logic (a line matching `MD_FENCE_DELIM_RE` opens a fence when
 * none is open, a line starting with the *same* marker closes it) that
 * `computeFencedSpans`, `computeFencedLineIndices`, and `isFenceOpeningLine`
 * each used to implement as their own, independently-maintained copy --
 * nothing enforced the three staying in agreement with each other. An
 * unterminated fence (no matching close before the end of `lines`) is
 * reflected by every remaining line coming back `fenced: true` -- each line
 * is marked while the scan is still inside the open fence, so no separate
 * post-loop fixup is needed the way the three original copies each had.
 * State at line `i` never depends on any line after `i`, so a caller that
 * only needs one line's state (see `isFenceOpeningLine`) can safely ignore
 * the rest of the array without re-deriving the logic itself.
 */
function scanFenceLines(lines: string[]): FenceLineState[] {
  const states: FenceLineState[] = [];
  let fenceMarker: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!fenceMarker && MD_FENCE_DELIM_RE.test(trimmed)) {
      fenceMarker = trimmed.slice(0, 3);
      states.push({ fenced: true, opensFence: true, closesFence: false });
    } else if (fenceMarker && trimmed.startsWith(fenceMarker)) {
      states.push({ fenced: true, opensFence: false, closesFence: true });
      fenceMarker = undefined;
    } else {
      states.push({
        fenced: fenceMarker !== undefined,
        opensFence: false,
        closesFence: false,
      });
    }
  }
  return states;
}

/**
 * 0-based line indices that fall inside a fenced code block (```` ``` ````
 * or `~~~`, optionally with a trailing language tag), delimiters included --
 * the target-side twin of `computeFencedSpans` above, which does the same
 * job for the *citing* doc's short-form matching. Derived from
 * `scanFenceLines` (see there). Anchor heading-search needs its own copy
 * because it works from an already-split `lines` array (see
 * `checkFullTarget`), not the raw `content` string `computeFencedSpans`
 * takes, and because it must ignore a target's `# not a heading` sitting
 * inside a fenced example exactly the same way a citing doc's own fences
 * are already ignored for short-form matching -- without this, a `#`-led
 * comment line inside e.g. a fenced shell example in the target is
 * indistinguishable from a real Markdown heading to `MD_HEADING_RE`, and
 * both `findEnclosingHeading` (picks the wrong "nearest" heading) and the
 * enclosure walk in `checkAnchor` (treats it as a section boundary) would
 * misfire on it.
 */
function computeFencedLineIndices(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  scanFenceLines(lines).forEach((state, i) => {
    if (state.fenced) fenced.add(i);
  });
  return fenced;
}

/**
 * Nearest Markdown heading at or before `startLine` (1-based), considering
 * only heading levels up to `ANCHOR_HEADING_MAX_LEVEL` -- see the "Anchored
 * citations" doc block above for why subsection headings are transparent to
 * this search. `fencedLines` (see `computeFencedLineIndices`) excludes any
 * line inside a fenced code block from matching, so a `#`-led comment
 * inside a fenced example is never mistaken for a heading. Returns `null`
 * when no such heading precedes `startLine` at all (e.g. the citation
 * lands above the target's first release heading).
 */
function findEnclosingHeading(
  lines: string[],
  startLine: number,
  fencedLines: Set<number>,
): { level: number; text: string; lineNo: number } | null {
  for (let i = startLine - 1; i >= 0; i--) {
    if (fencedLines.has(i)) continue;
    const m = (lines[i] ?? "").match(MD_HEADING_RE);
    if (m && m[1].length <= ANCHOR_HEADING_MAX_LEVEL) {
      return { level: m[1].length, text: m[2].trim(), lineNo: i + 1 };
    }
  }
  return null;
}

/**
 * Checks an anchored full citation's anchor against its already-resolved,
 * already-range-checked target -- see the "Anchored citations" doc block
 * above for the two forms' semantics. `endLine` is the citation's end line,
 * or its start line for a single-line citation (a size-1 range).
 */
function checkAnchor(
  anchor: Anchor,
  startLine: number,
  endLine: number,
  lines: string[],
): Problem | null {
  if (anchor.kind === "string") {
    for (let i = startLine - 1; i <= endLine - 1 && i < lines.length; i++) {
      if ((lines[i] ?? "").includes(anchor.text)) return null;
    }
    return {
      rule: "anchor-not-found-in-range",
      message: `anchor "${anchor.text}" does not occur in the cited range (${startLine}-${endLine})`,
    };
  }

  const fencedLines = computeFencedLineIndices(lines);
  const heading = findEnclosingHeading(lines, startLine, fencedLines);
  if (!heading) {
    return {
      rule: "anchor-heading-not-found",
      message: `no heading (level <= ${ANCHOR_HEADING_MAX_LEVEL}) precedes line ${startLine} to anchor "${anchor.text}" against; use a string anchor (#"...") instead against a target with no heading structure`,
    };
  }
  if (!heading.text.includes(anchor.text)) {
    return {
      rule: "anchor-heading-mismatch",
      message: `nearest enclosing heading ("${heading.text}") does not contain anchor "${anchor.text}"`,
    };
  }
  for (let i = heading.lineNo; i <= endLine - 1; i++) {
    if (fencedLines.has(i)) continue;
    const m = (lines[i] ?? "").match(MD_HEADING_RE);
    if (m && m[1].length <= heading.level) {
      return {
        rule: "anchor-heading-does-not-enclose",
        message: `range extends past the section enclosing anchor "${anchor.text}" (next heading "${m[2].trim()}" at line ${i + 1})`,
      };
    }
  }
  return null;
}

const CITATION_RE =
  /([\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)):(\d+)(?:-(\d+))?(?:#(\[?\w(?:[\w.-]*\w)?\]?|"[^"\n`]*"))?/g;
// Continuation citation forms (see the "Continuation citations" doc block
// above). Each requires the backtick delimiter as part of the match so it
// can never overlap a CITATION_RE match: a full citation's regex match
// never includes the surrounding backticks, and none of these three
// require a `path.ext` prefix before the digits.
const CONT_COLON_RE = /`:(\d+)(?:-(\d+))?`/g;
const CONT_DASH_RE = /[-–]`(\d+)`/g;
const CONT_PAREN_RE = /\(`(\d+)`\)/g;
const CLOSING_ONLY_EXTS = new Set(["ts", "js", "mjs", "yml", "yaml", "json"]);
const CLOSING_BRACE_RE = /^[)\]}][;,]?$/;
// Short-form (paragraph-bound) citation form, see the "Short-form
// citations" doc block below. Requires an explicit N-M range: a bare single
// number (`:5`) is not matched -- see that doc block for why. Only the
// colon form is collected; a bare `(N-M)` is never a short-form citation
// candidate at all -- see the same doc block for why the paren form was
// dropped rather than gated.
const SHORT_FORM_COLON_RE = /:(\d+)-(\d+)/g;
// Test-file block-boundary check (see checkRangeBoundary): a citation's
// range into a `.test.ts`/`.spec.ts` (or `.js`/`.mjs` equivalent) target
// must start on a describe(/it( head line and end on its matching closing
// `});` line.
const TEST_FILE_RE = /\.(test|spec)\.(ts|js|mjs)$/i;
const TEST_HEAD_LINE_RE = /^\s*(?:describe|it)\s*\(/;
const TEST_CLOSING_LINE_RE = /^\s*\}\)\s*;\s*$/;
// Markdown block-boundary check (see checkRangeBoundary): a range boundary
// line that is nothing but a bracket (open or close), optionally with a
// trailing `,`/`;`, is always a drift signal. A bare code-fence delimiter is
// its own, separate signal (see MD_FENCE_DELIM_RE): unlike a bracket, a
// fence line is sometimes the deliberately-correct start of a citation (see
// checkRangeBoundary's markdown branch for the opening-fence exception).
const MD_BARE_BRACKET_RE = /^(?:[)\]}][;,]?|[[({])$/;
const MD_FENCE_DELIM_RE = /^(?:`{3,}\S*|~{3,}\S*)$/;
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  // Ported 1:1 from the original script's own disposable test-fixtures
  // exclusion, kept so the ported EXCLUDED_DIRS regression test carries
  // over verbatim; harmless for any consuming repo that has no directory
  // with this name.
  "okf-citations-resolve-fixtures",
]);

// `severity`, when set, overrides pushDrift's default "warning" (currently
// only "notice", used by the markdown block-boundary check -- see
// checkRangeBoundary -- to keep that check advisory given the false-positive
// risk mechanical prose verification carries).
type Problem = {
  rule: string;
  message: string;
  code?: string;
  severity?: "notice";
};

/** Per-root basename index, see findByBasename. */
type BasenameCache = Map<string, Map<string, string[]>>;

type Atom =
  | {
      kind: "full";
      index: number;
      citedPath: string;
      startLine: number;
      endLine: number | null;
      anchor: Anchor | null;
    }
  | {
      kind: "cont-fresh";
      index: number;
      startLine: number;
      endLine: number | null;
    }
  | { kind: "cont-ext"; index: number; value: number };

type Resolution =
  { skip: true } | { path: string } | { ambiguous: true; candidates: string[] };

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when citedPath has a literal `..` path segment. */
function hasParentSegment(citedPath: string): boolean {
  return citedPath.split("/").includes("..");
}

/**
 * Repo-wide search for files with an exact basename, memoized per root
 * within `cache`. `cache` is built lazily and scoped to a single
 * `citationsResolveRule.run(ctx)` invocation (see the rule's `run`), not
 * held at module scope, so an in-process caller running the check
 * repeatedly (e.g. in a long-lived process, or a test suite that edits
 * fixtures between runs) never sees a stale index from an earlier run.
 */
function findByBasename(
  cache: BasenameCache,
  root: string,
  basename: string,
): string[] {
  let index = cache.get(root);
  if (!index) {
    index = new Map<string, string[]>();
    const found = index;
    const walk = (dir: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const list = found.get(entry.name) ?? [];
          list.push(full);
          found.set(entry.name, list);
        }
      }
    };
    walk(root);
    cache.set(root, index);
  }
  return index.get(basename) ?? [];
}

/**
 * Finds the nearest citation earlier in the same doc whose cited path
 * contains a `/` and ends with the same suffix as `citedPath`, the "full
 * path was mentioned earlier in this section/doc" convention.
 */
function findPriorQualifiedCitation(
  content: string,
  beforeIndex: number,
  citedPath: string,
): string | null {
  const suffix = "/" + citedPath;
  let best: string | null = null;
  let bestIndex = -1;
  const re = new RegExp(CITATION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index >= beforeIndex) break;
    const candidate = m[1];
    if (candidate === citedPath) continue; // not more qualified than itself
    if (
      candidate.includes("/") &&
      (candidate === citedPath || candidate.endsWith(suffix))
    ) {
      if (m.index > bestIndex) {
        bestIndex = m.index;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * For a bare (no `/`) citedPath, tries doc-relative first, then each
 * ancestor directory of the doc, nearest first, up to and including `root`.
 * Returns the first real file found, or `null`. See the "Path resolution"
 * doc block above (step 2) for why this runs before the plain
 * repo-root-relative lookup: a same-named file closer to the citing doc
 * (e.g. a package's own `README.md`) should win over one that merely
 * happens to also exist at the repo root.
 */
function resolveViaAncestorClimb(
  root: string,
  docAbsPath: string,
  citedPath: string,
): string | null {
  const resolvedRoot = path.resolve(root);
  let dir = path.dirname(docAbsPath);
  for (;;) {
    const candidate = path.resolve(dir, citedPath);
    if (isFile(candidate)) return candidate;
    if (path.resolve(dir) === resolvedRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Resolves a citation's path to a single real file. Returns `{ skip: true }`
 * for a citedPath out of scope (leading `/`), `{ path }` on a definitive
 * single resolution, `{ ambiguous: true, candidates }` when more than one
 * plausible target exists, or `null` when nothing matches. Callers must
 * reject a citedPath with a `..` segment (see hasParentSegment) before
 * calling this; it is not re-checked here.
 */
function resolveCitation(
  cache: BasenameCache,
  root: string,
  docAbsPath: string,
  docContent: string,
  docSources: string[],
  citedPath: string,
  matchIndex: number,
): Resolution | null {
  if (citedPath.startsWith("/")) {
    return { skip: true };
  }

  const sourceMatches = docSources.filter(
    (s) => s === citedPath || s.endsWith("/" + citedPath),
  );
  if (sourceMatches.length === 1) {
    const candidate = path.resolve(root, sourceMatches[0]);
    if (isFile(candidate)) return { path: candidate };
  }

  if (!citedPath.includes("/")) {
    const viaAncestor = resolveViaAncestorClimb(root, docAbsPath, citedPath);
    if (viaAncestor) return { path: viaAncestor };
  }

  const rootRelative = path.resolve(root, citedPath);
  if (isFile(rootRelative)) return { path: rootRelative };

  const docRelative = path.resolve(path.dirname(docAbsPath), citedPath);
  if (isFile(docRelative)) return { path: docRelative };

  const prior = findPriorQualifiedCitation(docContent, matchIndex, citedPath);
  if (prior) {
    const candidate = path.resolve(root, prior);
    if (isFile(candidate)) return { path: candidate };
  }

  const base = citedPath.includes("/")
    ? (citedPath.split("/").pop() as string)
    : citedPath;
  const bySuffix = findByBasename(cache, root, base).filter((m) => {
    const normalized = m.split(path.sep).join("/");
    return (
      normalized === citedPath ||
      normalized.endsWith("/" + citedPath) ||
      !citedPath.includes("/")
    );
  });
  if (bySuffix.length === 1) return { path: bySuffix[0] };
  if (bySuffix.length > 1) {
    return {
      ambiguous: true,
      candidates: bySuffix.map((m) => path.relative(root, m)),
    };
  }

  return null;
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (
    lines.length > 0 &&
    lines[lines.length - 1] === "" &&
    content.endsWith("\n")
  ) {
    lines.pop();
  }
  return lines;
}

// Range-bound checks shared by a full citation's own range (via
// checkTarget below) and a cont-ext atom's extension (via
// checkRangeBoundOnly): a citation's end before its start, or either bound
// past the end of the file. Both are pure "does this range make sense"
// checks, independent of what the start line's content actually is.
function checkRangeBound(
  startLine: number,
  endLine: number | null,
  lineCount: number,
): Problem | null {
  if (endLine !== null && endLine < startLine) {
    return {
      rule: "inverted-range",
      message: `range end (${endLine}) is before its start (${startLine})`,
    };
  }

  const last = endLine ?? startLine;
  if (startLine > lineCount || last > lineCount) {
    return {
      rule: "range-exceeds-file",
      message: `citation exceeds file length (${lineCount} line(s))`,
    };
  }

  return null;
}

/**
 * Reads a resolved target's content, or reports why it couldn't be read
 * (permission denied, and similar OS-level failures short of the file not
 * existing at all -- `resolveCitation` already confirmed the target exists
 * via `isFile`/`fs.statSync`, which does not require read permission).
 * Returned as a `Problem` with `rule: "unreadable-target"` and `code` set to
 * the OS error code, so callers can route it to a `notice`-severity finding
 * (see pushUnreadable) instead of the usual `warning`-severity drift finding
 * -- an unreadable file is not evidence the citation itself is wrong.
 */
function readTarget(resolvedPath: string): { content: string } | Problem {
  try {
    return { content: fs.readFileSync(resolvedPath, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      rule: "unreadable-target",
      message: "target file exists but could not be read",
      code,
    };
  }
}

/**
 * The non-I/O half of checkTarget: every check that only needs the
 * target's already-read `lines`, not the filesystem. Split out so a caller
 * that needs a second, different check against the same target (see
 * checkShortFormTarget) can read the file once and reuse `lines` for both,
 * instead of checkTarget re-reading it internally.
 */
function checkTargetLines(
  citedPath: string,
  startLine: number,
  endLine: number | null,
  lines: string[],
): Problem | null {
  const bound = checkRangeBound(startLine, endLine, lines.length);
  if (bound) return bound;

  const startText = lines[startLine - 1] ?? "";
  const trimmed = startText.trim();
  if (trimmed === "") {
    return { rule: "blank-start-line", message: "start line is blank" };
  }

  const ext = (citedPath.split(".").pop() ?? "").toLowerCase();
  if (CLOSING_ONLY_EXTS.has(ext) && CLOSING_BRACE_RE.test(trimmed)) {
    return {
      rule: "closing-brace-start-line",
      message: `start line is only a closing brace/bracket ("${trimmed}")`,
    };
  }

  return null;
}

function checkTarget(
  citedPath: string,
  startLine: number,
  endLine: number | null,
  resolvedPath: string,
): Problem | null {
  const read = readTarget(resolvedPath);
  if ("rule" in read) return read;
  return checkTargetLines(
    citedPath,
    startLine,
    endLine,
    splitLines(read.content),
  );
}

/**
 * A full citation's complete check: `checkTargetLines`'s existing checks
 * (unreadable-target, inverted-range, range-exceeds-file, blank-start-line,
 * closing-brace-start-line), plus, only when those all pass and the
 * citation carried an anchor, the anchor check above (see the "Anchored
 * citations" doc block). Reads the resolved target once, mirroring
 * `checkShortFormTarget`'s reasoning for the block-boundary check. Anchors
 * are full-citation-only (see that doc block for why), so `checkTarget`
 * itself is untouched and still used as-is for a cont-fresh atom.
 */
function checkFullTarget(
  citedPath: string,
  startLine: number,
  endLine: number | null,
  resolvedPath: string,
  anchor: Anchor | null,
): Problem | null {
  const read = readTarget(resolvedPath);
  if ("rule" in read) return read;
  const lines = splitLines(read.content);
  const base = checkTargetLines(citedPath, startLine, endLine, lines);
  if (base) return base;
  if (!anchor) return null;
  return checkAnchor(anchor, startLine, endLine ?? startLine, lines);
}

// A cont-ext atom only ever extends the *end* of a range whose start line
// was already fully checked (blank / closing-brace) when it was cited as
// its own full citation or cont-fresh atom -- re-running checkTarget here
// would re-derive that same start-line check against the identical line
// and, on a real drift, double-report it as a second finding. This checks
// only whether the (possibly inverted, possibly out-of-file) range itself
// is sound.
function checkRangeBoundOnly(
  startLine: number,
  endLine: number,
  resolvedPath: string,
): Problem | null {
  const read = readTarget(resolvedPath);
  if ("rule" in read) return read;
  const lineCount = splitLines(read.content).length;
  return checkRangeBound(startLine, endLine, lineCount);
}

function isTestFile(citedPath: string): boolean {
  return TEST_FILE_RE.test(citedPath);
}

/**
 * True when the line at `lines[lineIndex]` is a fence delimiter
 * (```` ``` ```` or `~~~`, optionally with a trailing language tag) that
 * *opens* a fenced code block, as opposed to closing one -- determined by
 * replaying the same open/close state machine `stripFencedCode`-style
 * scanners use from the top of the document, not by the line's own text
 * (a bare closing fence and an untagged opening fence are lexically
 * identical). Used by checkRangeBoundary's markdown branch: citing a
 * fenced block starting at its own opening fence line is the natural,
 * correct way to cite it, so that specific case is exempted from the
 * fence-as-drift-signal check (see there). Derived from `scanFenceLines`
 * (see there); state at `lineIndex` never depends on any line after it, so
 * scanning the whole array and reading one index back is equivalent to (and
 * replaces) the original's own up-to-`lineIndex`-only replay.
 */
function isFenceOpeningLine(lines: string[], lineIndex: number): boolean {
  return scanFenceLines(lines)[lineIndex]?.opensFence ?? false;
}

/**
 * True when `lines[endLineIndex]` is the closing delimiter that matches
 * the *opening* fence at `lines[startLineIndex]` (the caller must already
 * have confirmed the start line is a genuine opening fence, via
 * isFenceOpeningLine, before calling this) -- the first line after the
 * opener whose trimmed text starts with the same fence marker. Used by
 * checkRangeBoundary's markdown branch to also exempt a range's END from
 * the fence-as-drift-signal check when the range legitimately cites a
 * whole fenced code block from its own opening delimiter to its own
 * closing delimiter: the natural, correct way to cite such a block, not
 * drift, the same reasoning the start-side exception already applies.
 */
function isMatchingFenceClosingLine(
  lines: string[],
  startLineIndex: number,
  endLineIndex: number,
): boolean {
  const fenceMarker = (lines[startLineIndex] ?? "").trim().slice(0, 3);
  for (let i = startLineIndex + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.startsWith(fenceMarker)) {
      return i === endLineIndex;
    }
  }
  return false;
}

/**
 * Additional block-boundary check for a short-form citation's range (see
 * the "Short-form citations" doc block below), layered on top of
 * checkTarget's existing per-start-line checks via checkShortFormTarget.
 * Deliberately scoped to short-form citations only, not wired into
 * checkTarget/checkRangeBoundOnly (the full/continuation citation paths):
 * applying it there too was tried first and rejected -- the real bundle
 * this rule was built against has legitimate full citations into test
 * files that cite a couple of arbitrary lines (e.g. two lines of a shared
 * regex definition), not a describe/it block, and flagging those as newly
 * broken would have regressed the existing 0-warning baseline. Short-form
 * citations are the demonstrated motivating case (a paragraph naming a
 * test file once, then citing several of its describe/it blocks by bare
 * range alone), so the check is scoped to exactly that mechanism.
 *
 * Test-file targets (`.test.ts`/`.spec.ts`, and their `.js`/`.mjs`
 * equivalents): the range must start on a `describe(`/`it(` head line and
 * end on a matching closing `});` line. Severity split, by evidence
 * strength: a wrong START line is a
 * *warning* (`test-range-start-not-head`) -- the range beginning somewhere
 * other than a block head is strong drift evidence. A range whose start IS
 * correct but whose END is not the matching `});` is only a *notice*
 * (`test-range-end-not-closing`): this also matches a deliberate partial
 * citation (citing from a block's head to partway through it), which is not
 * drift. The start is checked first and returned alone, matching
 * checkTarget's existing single-problem-per-citation pattern (never both at
 * once).
 *
 * Markdown targets: mechanical verification of "is this still the same
 * block" is far less reliable for prose than for TS/JS brace structure, so
 * this is a notice, not a warning (see this rule's own risk note on
 * markdown false positives). The range's start or end line landing on a
 * bare bracket (MD_BARE_BRACKET_RE) is always a heads-up that the boundary
 * likely drifted onto structural punctuation rather than real prose. A bare
 * code-fence delimiter (MD_FENCE_DELIM_RE) is also always a drift signal at
 * either boundary, with two exceptions carved out for the one legitimate
 * way to cite a whole fenced code block by its own delimiters: the START is
 * exempted when that line is itself a genuine *opening* fence (see
 * isFenceOpeningLine), and, only when the start already qualified for that
 * exemption, the END is exempted when it is that same fence's matching
 * *closing* delimiter (see isMatchingFenceClosingLine) -- citing a fenced
 * block from its own opening delimiter through its own closing delimiter is
 * the natural, correct way to cite it, not drift.
 */
function checkRangeBoundary(
  citedPath: string,
  startLine: number,
  endLine: number,
  lines: string[],
): Problem | null {
  if (isTestFile(citedPath)) {
    const startText = lines[startLine - 1] ?? "";
    if (!TEST_HEAD_LINE_RE.test(startText)) {
      return {
        rule: "test-range-start-not-head",
        message: `range start is not a "describe(" or "it(" head line ("${startText.trim()}")`,
      };
    }
    const endText = lines[endLine - 1] ?? "";
    if (!TEST_CLOSING_LINE_RE.test(endText)) {
      return {
        rule: "test-range-end-not-closing",
        message: `range end is not a matching closing "});" line ("${endText.trim()}")`,
        severity: "notice",
      };
    }
    return null;
  }

  if (citedPath.toLowerCase().endsWith(".md")) {
    const startTrim = (lines[startLine - 1] ?? "").trim();
    const startIsFence = MD_FENCE_DELIM_RE.test(startTrim);
    if (
      MD_BARE_BRACKET_RE.test(startTrim) ||
      (startIsFence && !isFenceOpeningLine(lines, startLine - 1))
    ) {
      return {
        rule: "markdown-range-boundary-bracket-or-fence",
        message: `range start is a bare bracket/fence line ("${startTrim}")`,
        severity: "notice",
      };
    }
    const endTrim = (lines[endLine - 1] ?? "").trim();
    const endIsFence = MD_FENCE_DELIM_RE.test(endTrim);
    const endIsMatchingClose =
      startIsFence &&
      endIsFence &&
      isMatchingFenceClosingLine(lines, startLine - 1, endLine - 1);
    if (
      MD_BARE_BRACKET_RE.test(endTrim) ||
      (endIsFence && !endIsMatchingClose)
    ) {
      return {
        rule: "markdown-range-boundary-bracket-or-fence",
        message: `range end is a bare bracket/fence line ("${endTrim}")`,
        severity: "notice",
      };
    }
    return null;
  }

  return null;
}

/**
 * A short-form citation's full check: checkTarget's existing checks
 * (unreadable-target, inverted-range, range-exceeds-file, blank-start-line,
 * closing-brace-start-line), plus, only when those all pass, the
 * test-file/markdown block-boundary check above (see checkRangeBoundary).
 * Reads the resolved target from disk exactly once (a dogfood bundle can
 * run this against the same target file a dozen-plus times for one
 * compound short-form list) and reuses the same `lines` array for both
 * checks, instead of checkTarget and checkRangeBoundary each reading and
 * re-splitting it independently.
 */
function checkShortFormTarget(
  citedPath: string,
  startLine: number,
  endLine: number,
  resolvedPath: string,
): Problem | null {
  const read = readTarget(resolvedPath);
  if ("rule" in read) return read;
  const lines = splitLines(read.content);
  const base = checkTargetLines(citedPath, startLine, endLine, lines);
  if (base) return base;
  return checkRangeBoundary(citedPath, startLine, endLine, lines);
}

/**
 * Collects every continuation-citation atom (see the "Continuation
 * citations" doc block above) in `content`, sorted by document position.
 *
 * Each atom is tagged with a role:
 *   - "cont-fresh": establishes a new start line (optionally with its own
 *     embedded end, e.g. `` `:75-78` ``), checked the same way as a full
 *     citation's start (blank / closing-brace / range-exceeds).
 *   - "cont-ext": purely extends the *end* of whatever start line came
 *     immediately before it (a `` -`M` `` / `` –`M` `` tail, or a
 *     `` `:M` `` directly preceded by a `-`/`–`). Ending a range on a
 *     closing brace is completely normal, so an extension is checked ONLY
 *     for the range-bound checks (inverted-range, range-exceeds-file),
 *     never blank/closing-brace.
 * A colon-form match (`` `:N` ``) is "cont-ext" exactly when the nearest
 * non-whitespace character before its opening backtick is `-` or `–`;
 * otherwise it is "cont-fresh". Dash-form (`` -`M` ``/`` –`M` ``) is
 * always "cont-ext" by construction. Paren-form (`` (`N`) ``) is always
 * "cont-fresh".
 */
function collectContinuationAtoms(content: string): Atom[] {
  const atoms: Atom[] = [];

  const colonRe = new RegExp(CONT_COLON_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(content)) !== null) {
    const before = content.slice(0, m.index).trimEnd();
    if (/[-–]$/.test(before)) {
      atoms.push({
        kind: "cont-ext",
        index: m.index,
        value: m[2] ? Number(m[2]) : Number(m[1]),
      });
    } else {
      atoms.push({
        kind: "cont-fresh",
        index: m.index,
        startLine: Number(m[1]),
        endLine: m[2] ? Number(m[2]) : null,
      });
    }
  }

  const dashRe = new RegExp(CONT_DASH_RE.source, "g");
  while ((m = dashRe.exec(content)) !== null) {
    atoms.push({ kind: "cont-ext", index: m.index, value: Number(m[1]) });
  }

  const parenRe = new RegExp(CONT_PAREN_RE.source, "g");
  while ((m = parenRe.exec(content)) !== null) {
    atoms.push({
      kind: "cont-fresh",
      index: m.index,
      startLine: Number(m[1]),
      endLine: null,
    });
  }

  return atoms;
}

/**
 * Short-form citations. A BARE (no surrounding backtick) colon-range
 * `:N-M`, distinct from the backtick continuations above. Unlike a
 * continuation, which chains off `governing` -- the nearest PRECEDING
 * citation anywhere earlier in the doc, reset only on failure/ambiguity/
 * skip -- a short-form citation only ever binds to the last FULL
 * `path:N[-M]` citation named earlier in THE SAME PARAGRAPH (a paragraph
 * boundary is a blank -- empty or whitespace-only -- line): once a
 * candidate clears the serial-connective gate below, it binds
 * unconditionally to that target, with no further check on the two
 * ranges' relationship. A gate-cleared candidate with no full citation
 * earlier in its own paragraph is reported unresolved
 * (`short-form-unbound`, a NOTICE, not a warning), never silently skipped:
 * unlike a continuation right after a rejected/ambiguous citation (which
 * has a real reason to skip -- that citation's resolution is known
 * unusable), a short-form's paragraph simply never named a usable target,
 * itself worth flagging. A candidate the gate rejects is not collected at
 * all -- it produces no finding of any kind, not even short-form-unbound.
 *
 * Range only, no bare single number (`:5`): every real short-form citation
 * found while building this rule was a range (`:580-588`), and a bare
 * single number is far too likely to be an unrelated enumeration marker
 * (this rule's own dogfood target, docs/okf/log.md, uses exactly that
 * numbered-list convention throughout) to detect mechanically without a
 * large false-positive cost.
 *
 * Only the colon form (`:N-M`) is collected. A bare parenthesized range
 * `(N-M)` is NOT collected at all, deliberately: three earlier rounds each
 * tried to separate a real short-form citation from ordinary prose that
 * merely contains an N-M-shaped number pair ("the window (2026-2027)",
 * "follow steps (2-4)", "three engineers (1-3)") by deciding from the
 * range's VALUES -- an inverted-pair check, a span cap plus a year/port
 * plausibility gate, then a containment-or-adjacency check against the
 * paragraph's last full citation -- and all three were eventually defeated
 * by the same class of false positive, because every real paren-form
 * citation this rule was ever built against had the identical shape
 * `<English word> (N-M)` as ordinary prose. There is no lexical signal
 * that separates them; dropping paren-form collection measured zero cost
 * against this rule's own dogfood corpus (39 findings / 17 warnings / 22
 * notices, unchanged with and without it -- see the CHANGELOG). The colon
 * form does not have this problem: prose essentially never writes a bare
 * `:N-M` outside a citation-adjacent context, and the serial-connective
 * gate below narrows it further.
 *
 * Serial-connective gate. A colon-form candidate is collected ONLY when
 * the nearest preceding non-whitespace text, after trimming whitespace, is
 * one of the characters `,`, `;`, `(`, or ends in the word `and` or `or`
 * -- the shape a short-form citation takes in a serial list of sub-ranges
 * ("the `TODO` cells, :72-74 (the ...), and :92-97 (the ...)", "review
 * finding L1 (:1170-1227, ...)"). Measured over the 137 markdown files in
 * this repo: 37 whitespace-or-punctuation-preceded bare `:N-M` occurrences,
 * 29 of them serial-connective-preceded, and all 29 are genuine citations
 * (13 preceded by `(`, 12 by a comma, 4 by `and`) -- the comma is
 * load-bearing at 12 of 29, so the gate is not narrowed to `(` and `and`
 * only. The 8 non-serial occurrences this gate correctly excludes are this
 * package's own README quoting false-positive examples, this rule's own
 * test fixture, and docs/okf/log.md's "old :93-94 -> new :150-151" delta
 * narration (a reserved file, already skipped regardless -- see below). A
 * candidate this gate rejects is dropped before any binding is attempted:
 * it is not a citation, and produces nothing at all, not even
 * short-form-unbound. See isSerialConnectivePreceded for the exact check.
 *
 * A candidate is excluded from even being considered against the gate when:
 *   - its `:` falls inside an already-matched full citation's own span
 *     (the tail of a real `path:N-M` citation, not a new short form), a
 *     fenced or indented code block, an inline code span, or a Markdown
 *     table row (see computeExcludedSpans) -- a bare numeric range inside
 *     any of these is virtually never a citation
 *   - the character immediately before or after the match is a backtick
 *     (the backtick continuation forms above already own that syntax)
 *
 * A resolved short-form citation is checked via checkShortFormTarget (see
 * above): checkTarget's existing checks, plus the test-file/Markdown
 * block-boundary check (see checkRangeBoundary).
 *
 * Documented residual (not fixed): a prose shape where the serial
 * connective happens to precede a bare range that is still not a real
 * citation -- e.g. "the exposed ports, :80-443, stayed open" -- still
 * binds to the paragraph's last full citation and can produce a false
 * warning. This was not observed anywhere in the 137-file corpus this
 * gate was measured against; see the README and CHANGELOG.
 */
type ShortFormMatch = {
  index: number;
  startLine: number;
  endLine: number;
};

/**
 * True when the nearest non-whitespace text before `matchIndex` in
 * `content` is a serial connective: the single character `,`, `;`, or `(`,
 * or the word `and`/`or` (case-insensitive, word-boundary-matched so it
 * does not fire on the tail of a longer word like "brand"). See the
 * "Short-form citations" doc block above for why this is the gate.
 */
function isSerialConnectivePreceded(
  content: string,
  matchIndex: number,
): boolean {
  const before = content.slice(0, matchIndex).trimEnd();
  if (before === "") return false;
  const lastChar = before[before.length - 1];
  if (lastChar === "," || lastChar === ";" || lastChar === "(") return true;
  return /\b(?:and|or)$/i.test(before);
}

function isWithinAnySpan(
  index: number,
  spans: Array<[number, number]>,
): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

function collectShortFormMatches(
  content: string,
  excludedSpans: Array<[number, number]>,
): ShortFormMatch[] {
  const out: ShortFormMatch[] = [];

  const colonRe = new RegExp(SHORT_FORM_COLON_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, excludedSpans)) continue;
    if (content[m.index - 1] === "`") continue;
    if (content[m.index + m[0].length] === "`") continue;
    if (!isSerialConnectivePreceded(content, m.index)) continue;
    const startLine = Number(m[1]);
    const endLine = Number(m[2]);
    out.push({ index: m.index, startLine, endLine });
  }

  return out.sort((a, b) => a.index - b.index);
}

/**
 * Char spans of every fenced code block in `content` (```` ``` ```` or
 * `~~~`, optionally with a trailing language tag), each span running from
 * the start of the opening fence line to the end of the closing fence line
 * inclusive. An unterminated fence (no matching close before end of doc) is
 * treated as running to the end of the content -- conservative, since an
 * unterminated fence is itself a doc problem outside this rule's scope, not
 * a reason to scan its contents for short-form citations. Derived from
 * `scanFenceLines` (see there): per-line fenced/opens/closes state is
 * converted to char-offset spans by tracking each line's `[start, end)`
 * offset in `content` alongside it.
 */
function computeFencedSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const lines = content.split("\n");
  const states = scanFenceLines(lines);
  let offset = 0;
  let spanStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = offset + lines[i].length;
    if (states[i].opensFence) spanStart = offset;
    if (states[i].closesFence && spanStart >= 0) {
      spans.push([spanStart, lineEnd]);
      spanStart = -1;
    }
    offset = lineEnd + 1; // +1 for the newline joining this line to the next
  }
  if (spanStart >= 0) {
    spans.push([spanStart, content.length]);
  }
  return spans;
}

/**
 * Char spans of every CommonMark-style indented code block in `content`: a
 * maximal run of consecutive non-blank lines, each indented by at least
 * four spaces or a leading tab, whose first line is preceded by a blank
 * line or the start of the document (an indented code block cannot
 * interrupt a paragraph). A blank line inside the run does not itself end
 * it, matching CommonMark. Simplified relative to the full CommonMark
 * spec (no list-item-context awareness); adequate for this mechanical,
 * warn-only rule.
 */
function computeIndentedCodeSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const lines = content.split("\n");
  let offset = 0;
  let blockStart = -1;
  let blockEnd = -1;
  let prevBlank = true;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const isBlank = line.trim() === "";
    const isIndented = /^( {4,}|\t)/.test(line);
    if (!isBlank && isIndented && (blockStart !== -1 || prevBlank)) {
      if (blockStart === -1) blockStart = lineStart;
      blockEnd = lineEnd;
    } else if (isBlank && blockStart !== -1) {
      // blank line inside an open block: keep it open, don't extend blockEnd
    } else if (!isBlank) {
      if (blockStart !== -1) spans.push([blockStart, blockEnd]);
      blockStart = -1;
      blockEnd = -1;
    }
    prevBlank = isBlank;
    offset = lineEnd + 1;
  }
  if (blockStart !== -1) spans.push([blockStart, blockEnd]);
  return spans;
}

/**
 * Char spans of every inline code span in `content` (`` `...` ``, or a
 * longer run of backticks as the delimiter). This is a superset of the
 * narrower "immediately adjacent to a backtick" guard already applied in
 * collectShortFormMatches: that guard only rejects a match directly
 * touching a backtick, so a short form embedded further inside a longer
 * inline code span (e.g. `` `ports (1-3)` ``) was previously matched and
 * bound; this closes that gap.
 *
 * Confined to a single line (the pairing regex excludes `\n`): CommonMark
 * inline code spans cannot themselves span multiple lines in the sense
 * this rule cares about, but more importantly, an unmatched backtick run
 * (a typo, or a literal backtick in prose) previously paired greedily with
 * the *next* backtick run anywhere later in the whole document, silently
 * treating everything in between -- potentially several unrelated
 * sentences and any short-form citation among them -- as one giant inline
 * code span. Confining the match to a single line means a backtick run
 * with no partner on the same line produces no span at all, instead of
 * reaching across a newline for one.
 */
function computeInlineCodeSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(`+)[^`\n]*?\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Char spans of every Markdown table row in `content`: a line whose
 * trimmed form starts and ends with `|`. Decision (documented in the
 * README): a short-form citation inside a table cell is never recognised,
 * the same way one inside a code span is not -- excluded here rather than
 * left to the plausibility gate, since a table cell's content is prose-like
 * and can otherwise carry a range shape the gate would not reject (e.g.
 * `| col (5-9) |`).
 */
function computeTableRowSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const lines = content.split("\n");
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      trimmed.length > 1
    ) {
      spans.push([offset, offset + line.length]);
    }
    offset += line.length + 1;
  }
  return spans;
}

/**
 * All char spans short-form matching must never fire inside: fenced code,
 * indented code, inline code spans, and Markdown table rows. Computed once
 * per doc and combined with fullSpans (see scanDoc) via the existing
 * isWithinAnySpan helper -- the same mechanism a full citation's own span
 * already uses, not a second one.
 */
function computeExcludedSpans(content: string): Array<[number, number]> {
  return [
    ...computeFencedSpans(content),
    ...computeIndentedCodeSpans(content),
    ...computeInlineCodeSpans(content),
    ...computeTableRowSpans(content),
  ];
}

/**
 * Paragraph-start offsets in `content`, ascending, always including 0. A
 * paragraph boundary is a blank (empty or whitespace-only) line.
 */
function computeParagraphStarts(content: string): number[] {
  const starts = [0];
  const re = /\n[ \t]*\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    starts.push(m.index + m[0].length);
  }
  return starts;
}

/** The start offset of the paragraph containing `index` (see computeParagraphStarts). */
function paragraphStartFor(starts: number[], index: number): number {
  let result = starts[0];
  for (const s of starts) {
    if (s > index) break;
    result = s;
  }
  return result;
}

/** A full citation named in a paragraph, for short-form binding. */
type NamedFullCitation = {
  index: number;
  citedPath: string;
};

/**
 * The nearest full citation strictly before `beforeIndex` and at or after
 * `paragraphStart` -- "the last target document named earlier in the same
 * paragraph" -- or null when none exists.
 */
function findLastNamedTargetInParagraph(
  fullAtoms: NamedFullCitation[],
  paragraphStart: number,
  beforeIndex: number,
): NamedFullCitation | null {
  let best: NamedFullCitation | null = null;
  for (const a of fullAtoms) {
    if (a.index >= paragraphStart && a.index < beforeIndex) {
      if (!best || a.index > best.index) best = a;
    }
  }
  return best;
}

function pushDrift(
  findings: Finding[],
  file: string,
  citation: string,
  rule: string,
  message: string,
  resolvedTo?: string,
  severity: "warning" | "notice" = "warning",
): void {
  findings.push({
    ruleId: RULE_ID,
    severity,
    file,
    message: `\`${citation}\`: ${message} [${rule}]`,
    ...(resolvedTo ? { detail: `resolvedTo: ${resolvedTo}` } : {}),
  });
}

function pushAmbiguous(
  findings: Finding[],
  file: string,
  citation: string,
  candidates: string[],
): void {
  findings.push({
    ruleId: RULE_ID,
    severity: "notice",
    file,
    message: `\`${citation}\`: ambiguous target, not evaluated [unresolved-ambiguous]`,
    detail: `candidates: ${candidates.join(", ")}`,
  });
}

function pushUnreadable(
  findings: Finding[],
  file: string,
  citation: string,
  resolvedTo: string,
  code: string,
): void {
  findings.push({
    ruleId: RULE_ID,
    severity: "notice",
    file,
    message: `\`${citation}\`: target file exists but could not be read [unreadable-target]`,
    detail: `resolvedTo: ${resolvedTo}, errorCode: ${code}`,
  });
}

/**
 * True when a `CITATION_RE` match at `matchIndex` is the phantom tail of a
 * filename hard-wrapped across a line break (see the "Hard-wrapped prose"
 * doc block above): the match starts at column 0 of its line, optionally
 * after only whitespace or a list/quote marker, and the previous line ends
 * with `-` or `–`.
 */
function isWrappedPathContinuation(
  content: string,
  matchIndex: number,
): boolean {
  const lineStart = content.lastIndexOf("\n", matchIndex - 1) + 1;
  if (lineStart === 0) return false; // no previous line to have wrapped from
  const prefix = content.slice(lineStart, matchIndex);
  if (!/^[\s>*.\d-]*$/.test(prefix)) return false;
  const prevLineEnd = lineStart - 1; // index of the newline just before lineStart
  const prevLineStart = content.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const prevLine = content.slice(prevLineStart, prevLineEnd);
  return /[-–]$/.test(prevLine);
}

/**
 * Raw text following a malformed anchor's `#` (see `anchor-malformed` in
 * `scanDoc`'s main matching loop), used only to make that finding's message
 * concrete: from just after the `#` up to the next backtick or newline
 * (whichever comes first), or the end of `content` -- roughly as far as
 * `CITATION_RE`'s own anchor alternatives would have looked before giving
 * up, so the reported fragment matches what was actually typed rather than
 * running on into unrelated later prose.
 */
function extractMalformedAnchorRaw(content: string, hashIndex: number): string {
  const from = hashIndex + 1;
  let end = content.length;
  const nl = content.indexOf("\n", from);
  if (nl !== -1 && nl < end) end = nl;
  const bt = content.indexOf("`", from);
  if (bt !== -1 && bt < end) end = bt;
  return content.slice(from, end);
}

function scanDoc(
  cache: BasenameCache,
  root: string,
  bundleDir: string,
  doc: BundleDoc,
): Finding[] {
  const findings: Finding[] = [];
  const content = doc.raw;
  const sources = getValidSources(doc.frontmatter.parsed) ?? [];
  const docAbsPath = path.join(bundleDir, doc.relPath);

  const fullAtoms: Atom[] = [];
  // Char spans of every matched full citation, used to keep short-form
  // matching (see collectShortFormMatches) from re-matching the tail of a
  // real `path:N-M` citation as a bare short form.
  const fullSpans: Array<[number, number]> = [];
  const re = new RegExp(CITATION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (isWrappedPathContinuation(content, m.index)) continue;
    const matchEnd = m.index + m[0].length;
    // anchor-malformed (notice): a `#` immediately follows the range but
    // group 4 (the anchor) did not match -- unbalanced quotes, a backtick
    // inside a quoted anchor, or nothing at all after the `#` (e.g.
    // `path:N-M#` at end of line). The citation is still pushed as an
    // ordinary anchorless atom below (backward compatible: checked exactly
    // as it always was), this only ADDS a heads-up that a `#` sitting right
    // there was silently not read as the anchor it looks like it was meant
    // to be -- see the "Anchored citations" doc block above for why a typo
    // here would otherwise silently disable the very check it was written
    // for.
    if (m[4] === undefined && content[matchEnd] === "#") {
      const citedPath = m[1];
      const startLine = Number(m[2]);
      const endLine = m[3] ? Number(m[3]) : null;
      const citation = `${citedPath}:${startLine}${endLine ? "-" + endLine : ""}`;
      const raw = extractMalformedAnchorRaw(content, matchEnd);
      pushDrift(
        findings,
        doc.relPath,
        citation,
        "anchor-malformed",
        `a "#" follows the citation's range but does not parse as a heading or string anchor (raw: "${raw}")`,
        undefined,
        "notice",
      );
    }
    fullAtoms.push({
      kind: "full",
      index: m.index,
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : null,
      anchor: parseAnchor(m[4]),
    });
    fullSpans.push([m.index, matchEnd]);
  }

  const atoms = [...fullAtoms, ...collectContinuationAtoms(content)].sort(
    (a, b) => a.index - b.index,
  );

  // `governing`: nearest preceding citation (full or continuation) that
  // resolved to a real file; see the "Continuation citations" doc block
  // above for the reset rules. `lastStartLine`: the start line a "cont-ext"
  // atom extends into a range; tracks the most recent full or cont-fresh
  // atom's own startLine, scoped together with `governing`.
  let governing: { citedPath: string; resolvedPath: string } | null = null;
  let lastStartLine: number | null = null;

  for (const atom of atoms) {
    if (atom.kind === "cont-ext") {
      if (!governing || lastStartLine === null) continue; // nothing to extend
      const citation = `${governing.citedPath}:${lastStartLine}-${atom.value} (continuation)`;
      const problem = checkRangeBoundOnly(
        lastStartLine,
        atom.value,
        governing.resolvedPath,
      );
      if (problem?.rule === "unreadable-target") {
        pushUnreadable(
          findings,
          doc.relPath,
          citation,
          path.relative(root, governing.resolvedPath),
          problem.code ?? "UNKNOWN",
        );
      } else if (problem) {
        pushDrift(
          findings,
          doc.relPath,
          citation,
          problem.rule,
          problem.message,
          path.relative(root, governing.resolvedPath),
        );
      }
      continue; // governing and lastStartLine both carry over unchanged
    }

    if (atom.kind === "cont-fresh") {
      if (!governing) continue; // nothing to validate a bare continuation against
      const { startLine, endLine } = atom;
      const citation = `${governing.citedPath}:${startLine}${endLine ? "-" + endLine : ""} (continuation)`;
      const problem = checkTarget(
        governing.citedPath,
        startLine,
        endLine,
        governing.resolvedPath,
      );
      if (problem?.rule === "unreadable-target") {
        pushUnreadable(
          findings,
          doc.relPath,
          citation,
          path.relative(root, governing.resolvedPath),
          problem.code ?? "UNKNOWN",
        );
      } else if (problem) {
        pushDrift(
          findings,
          doc.relPath,
          citation,
          problem.rule,
          problem.message,
          path.relative(root, governing.resolvedPath),
        );
      }
      lastStartLine = startLine;
      continue; // governing (same file) carries over unchanged
    }

    const { citedPath, startLine, endLine, anchor } = atom;
    // The anchor, when present, is carried in the citation label itself
    // (not just the anchor-check finding's own message) so two citations to
    // the same range with different anchors are distinguishable in the
    // output -- see formatAnchorForLabel and the "Anchored citations" doc
    // block above. Continuations and short-form citations never carry an
    // anchor (see there), so their own citation labels are unaffected.
    const citation = `${citedPath}:${startLine}${endLine ? "-" + endLine : ""}${anchor ? formatAnchorForLabel(anchor) : ""}`;

    if (hasParentSegment(citedPath)) {
      pushDrift(
        findings,
        doc.relPath,
        citation,
        "path-traversal-rejected",
        `citedPath contains a ".." segment and was rejected without resolving: ${citedPath}`,
      );
      governing = null;
      lastStartLine = null;
      continue;
    }

    const resolution = resolveCitation(
      cache,
      root,
      docAbsPath,
      content,
      sources,
      citedPath,
      atom.index,
    );

    if (!resolution) {
      pushDrift(
        findings,
        doc.relPath,
        citation,
        "missing-file",
        `could not resolve ${citedPath}: tried doc sources, ancestor climb (bare filenames only), repo-root, doc-relative, nearest prior qualified mention, repo-wide search; no candidate file exists`,
      );
      governing = null;
      lastStartLine = null;
      continue;
    }
    if ("skip" in resolution) {
      governing = null;
      lastStartLine = null;
      continue;
    }
    if ("ambiguous" in resolution) {
      pushAmbiguous(findings, doc.relPath, citation, resolution.candidates);
      governing = null;
      lastStartLine = null;
      continue;
    }

    const problem = checkFullTarget(
      citedPath,
      startLine,
      endLine,
      resolution.path,
      anchor,
    );
    if (problem?.rule === "unreadable-target") {
      pushUnreadable(
        findings,
        doc.relPath,
        citation,
        path.relative(root, resolution.path),
        problem.code ?? "UNKNOWN",
      );
    } else if (problem) {
      pushDrift(
        findings,
        doc.relPath,
        citation,
        problem.rule,
        problem.message,
        path.relative(root, resolution.path),
      );
    }
    governing = { citedPath, resolvedPath: resolution.path };
    lastStartLine = startLine;
  }

  // Short-form (paragraph-bound) citations -- see that doc block above.
  // Deliberately independent of `governing`/`lastStartLine`: short-form
  // binding is paragraph-scoped by design, not chained through the
  // document-wide continuation state machine above. Reserved files
  // (index.md, log.md, see doc.isReserved) are skipped entirely: they are
  // append-only narrative journals, not `sources:`-driven reference docs,
  // and routinely narrate historical "old N-M -> new X-Y" line-number
  // deltas as prose data about past changes -- not live citations against
  // current content -- which this rule's bare-range matching cannot tell
  // apart from a real short-form citation. Full/continuation citations in
  // reserved files are still scanned as before; this carve-out is scoped
  // to short-form matching only.
  const shortFormMatches = doc.isReserved
    ? []
    : collectShortFormMatches(content, [
        ...fullSpans,
        ...computeExcludedSpans(content),
      ]);
  if (shortFormMatches.length > 0) {
    const paragraphStarts = computeParagraphStarts(content);
    const namedFullAtoms: NamedFullCitation[] = [];
    for (const a of fullAtoms) {
      if (a.kind === "full") {
        namedFullAtoms.push({
          index: a.index,
          citedPath: a.citedPath,
        });
      }
    }

    for (const sf of shortFormMatches) {
      const paragraphStart = paragraphStartFor(paragraphStarts, sf.index);
      const target = findLastNamedTargetInParagraph(
        namedFullAtoms,
        paragraphStart,
        sf.index,
      );
      const rangeLabel = `${sf.startLine}-${sf.endLine}`;

      if (!target) {
        pushDrift(
          findings,
          doc.relPath,
          `${rangeLabel} (short-form)`,
          "short-form-unbound",
          "no full `path:N` citation earlier in this paragraph to bind to",
          undefined,
          "notice",
        );
        continue;
      }

      const targetPath = target.citedPath;
      const citation = `${targetPath}:${rangeLabel} (short-form)`;

      if (hasParentSegment(targetPath)) {
        // The full citation that named this target already reported
        // path-traversal-rejected for itself; not re-flagged a second time.
        continue;
      }

      const resolution = resolveCitation(
        cache,
        root,
        docAbsPath,
        content,
        sources,
        targetPath,
        sf.index,
      );

      if (!resolution) {
        pushDrift(
          findings,
          doc.relPath,
          citation,
          "missing-file",
          `could not resolve ${targetPath}: tried doc sources, ancestor climb (bare filenames only), repo-root, doc-relative, nearest prior qualified mention, repo-wide search; no candidate file exists`,
        );
        continue;
      }
      if ("skip" in resolution) continue;
      if ("ambiguous" in resolution) {
        pushAmbiguous(findings, doc.relPath, citation, resolution.candidates);
        continue;
      }

      const problem = checkShortFormTarget(
        targetPath,
        sf.startLine,
        sf.endLine,
        resolution.path,
      );
      if (problem?.rule === "unreadable-target") {
        pushUnreadable(
          findings,
          doc.relPath,
          citation,
          path.relative(root, resolution.path),
          problem.code ?? "UNKNOWN",
        );
      } else if (problem) {
        pushDrift(
          findings,
          doc.relPath,
          citation,
          problem.rule,
          problem.message,
          path.relative(root, resolution.path),
          problem.severity,
        );
      }
    }
  }

  return findings;
}

export const citationsResolveRule: Rule = {
  id: RULE_ID,
  description:
    "`path:N`/`path:N-M` citations (and their `:N`, -`M`/–`M`, (`N`) continuations) must resolve to a real target file and land on real, non-blank content. Mechanical only: does not verify the cited line is semantically correct.",
  run(ctx) {
    if (!ctx.repoRoot) {
      // Never silently skip: mirrors sources-fresh's posture so a "clean"
      // run is never a fake pass when there is no filesystem tree to
      // resolve citation targets against.
      return [
        {
          ruleId: RULE_ID,
          severity: "notice",
          file: "",
          message: "citation resolution skipped: not inside a git work tree",
        },
      ];
    }
    const root = ctx.repoRoot;
    // Fresh per invocation: see findByBasename's doc comment for why this
    // is not held at module scope.
    const cache: BasenameCache = new Map();
    return ctx.docs.flatMap((doc) => scanDoc(cache, root, ctx.bundleDir, doc));
  },
};
