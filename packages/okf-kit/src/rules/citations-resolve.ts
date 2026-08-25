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

const CITATION_RE =
  /([\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)):(\d+)(?:-(\d+))?/g;
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
// Short-form (paragraph-bound) citation forms, see the "Short-form
// citations" doc block below. Both require an explicit N-M range: a bare
// single number (`(1)`, `:5`) is not matched -- see that doc block for why.
const SHORT_FORM_COLON_RE = /:(\d+)-(\d+)/g;
const SHORT_FORM_PAREN_RE = /\((\d+)-(\d+)\)/g;
// Test-file block-boundary check (see checkRangeBoundary): a citation's
// range into a `.test.ts`/`.spec.ts` (or `.js`/`.mjs` equivalent) target
// must start on a describe(/it( head line and end on its matching closing
// `});` line.
const TEST_FILE_RE = /\.(test|spec)\.(ts|js|mjs)$/i;
const TEST_HEAD_LINE_RE = /^\s*(?:describe|it)\s*\(/;
const TEST_CLOSING_LINE_RE = /^\s*\}\)\s*;\s*$/;
// Markdown block-boundary check (see checkRangeBoundary): a range boundary
// line that is nothing but a bracket (open or close) or a code-fence
// delimiter, optionally with a language tag (fence) or trailing `,`/`;`
// (closing bracket) -- a common signature of a boundary that drifted onto
// structural punctuation rather than real prose content.
const MD_PURE_BRACKET_OR_FENCE_RE = /^(?:[)\]}][;,]?|[[({]|`{3,}\S*|~{3,}\S*)$/;
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

function checkTarget(
  citedPath: string,
  startLine: number,
  endLine: number | null,
  resolvedPath: string,
): Problem | null {
  const read = readTarget(resolvedPath);
  if ("rule" in read) return read;
  const content = read.content;
  const lines = splitLines(content);
  const lineCount = lines.length;

  const bound = checkRangeBound(startLine, endLine, lineCount);
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
 * equivalents), `applyTestBoundary` only (paren-form short forms, see the
 * "Short-form citations" doc block for why colon-form is excluded): the
 * range must start on a `describe(`/`it(` head line and end on a matching
 * closing `});` line. Each mismatch is its own warning-severity rule
 * (`test-range-start-not-head` / `test-range-end-not-closing`) so a
 * fixture/mutation probe can target either independently; the start is
 * checked first, matching checkTarget's existing single-problem-per-citation
 * pattern (never both at once).
 *
 * Markdown targets: mechanical verification of "is this still the same
 * block" is far less reliable for prose than for TS/JS brace structure, so
 * this is a notice, not a warning (see this rule's own risk note on
 * markdown false positives): the range's start or end line landing on a
 * bare bracket or a bare code-fence delimiter (see MD_PURE_BRACKET_OR_FENCE_RE)
 * is a heads-up that the boundary likely drifted onto structural
 * punctuation rather than real prose, not an enforced error. Unlike the
 * test-file check, this is NOT gated on `applyTestBoundary`/form: a false
 * positive here is only a notice, not an enforced warning.
 */
function checkRangeBoundary(
  citedPath: string,
  startLine: number,
  endLine: number,
  lines: string[],
  applyTestBoundary: boolean,
): Problem | null {
  if (applyTestBoundary && isTestFile(citedPath)) {
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
      };
    }
    return null;
  }

  if (citedPath.toLowerCase().endsWith(".md")) {
    const startTrim = (lines[startLine - 1] ?? "").trim();
    if (MD_PURE_BRACKET_OR_FENCE_RE.test(startTrim)) {
      return {
        rule: "markdown-range-boundary-bracket-or-fence",
        message: `range start is a bare bracket/fence line ("${startTrim}")`,
        severity: "notice",
      };
    }
    const endTrim = (lines[endLine - 1] ?? "").trim();
    if (MD_PURE_BRACKET_OR_FENCE_RE.test(endTrim)) {
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
 * test-file/markdown block-boundary check above. `applyTestBoundary`: see
 * checkRangeBoundary (true for paren-form short forms only).
 */
function checkShortFormTarget(
  citedPath: string,
  startLine: number,
  endLine: number,
  resolvedPath: string,
  applyTestBoundary: boolean,
): Problem | null {
  const base = checkTarget(citedPath, startLine, endLine, resolvedPath);
  if (base) return base;
  const read = readTarget(resolvedPath);
  if ("rule" in read) return read;
  return checkRangeBoundary(
    citedPath,
    startLine,
    endLine,
    splitLines(read.content),
    applyTestBoundary,
  );
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
 * Short-form citations. Two additional forms, distinct from the backtick
 * continuations above: a BARE (no surrounding backtick) colon-range
 * `:N-M`, or a BARE parenthesized range `(N-M)`. Unlike a continuation,
 * which chains off `governing` -- the nearest PRECEDING citation anywhere
 * earlier in the doc, reset only on failure/ambiguity/skip -- a short-form
 * citation binds to the last FULL `path:N[-M]` citation named earlier in
 * THE SAME PARAGRAPH (a paragraph boundary is a blank -- empty or
 * whitespace-only -- line). A short-form citation with no full citation
 * earlier in its own paragraph is reported unresolved
 * (`short-form-unbound`, warning), never silently skipped: unlike a
 * continuation right after a rejected/ambiguous citation (which has a real
 * reason to skip -- that citation's resolution is known unusable), a
 * short-form's paragraph simply never named a target, itself worth
 * flagging.
 *
 * Range only, no bare single number (`(1)`, `:5`): every real short-form
 * citation found while building this rule was a range (`(373-375)`,
 * `:580-588`), and a bare single number is far too likely to be an
 * unrelated enumeration marker (this rule's own dogfood target,
 * docs/okf/log.md, uses exactly that numbered-list convention throughout)
 * to detect mechanically without a large false-positive cost.
 *
 * A candidate match is excluded (not even collected) when:
 *   - its `:`/`(` falls inside an already-matched full citation's own
 *     span (the tail of a real `path:N-M` citation, not a new short form)
 *   - the character immediately before or after the match is a backtick
 *     (the backtick continuation forms above already own that syntax)
 *   - (colon form) the character immediately before the `:` is a
 *     path/word character (`[\w./-]`) -- a real filename character there
 *     means this is plausibly part of some other, unrecognised
 *     citation-like token, not a bare short form
 *   - (paren form) the character immediately before the `(` is a word
 *     character -- guards against an incidental `foo(123-456)`-shaped
 *     token that is not prose
 *
 * A resolved short-form citation is checked via checkShortFormTarget (see
 * above): checkTarget's existing checks, plus (paren form only -- see
 * `form` below) the test-file block-boundary check.
 *
 * Colon-form vs. paren-form, and why only paren-form gets the test-file
 * boundary check. Empirically (this rule's own dogfood target,
 * packages/orchestrator-workflow/docs/okf), the two forms carry different
 * author intent: a paren-form short form after a named clause
 * (`detection signals named verbatim (374-379)`) reliably cites one whole
 * describe/it block precisely -- every paren-form short form in that
 * bundle does. A colon-form short form inside a `path:N-M, :X-Y, :Z-W`-style
 * compound list instead conventionally marks an approximate detail
 * location *within* an already-cited, much larger range (that bundle's own
 * prose calls these "sub-citations not individually re-derived"), so most
 * of them do not start on a describe/it head or end on a matching `});` at
 * all -- not drift, just a different, legitimate citation granularity this
 * mechanical checker cannot distinguish from real drift without author
 * intent. Applying the boundary check to colon-form short forms too would
 * therefore flag a large number of correct citations. The markdown
 * bracket/fence check (also in checkRangeBoundary) is NOT restricted this
 * way: it is notice-severity, so a false positive there is an advisory
 * heads-up, not an enforced warning.
 */
type ShortFormMatch = {
  index: number;
  startLine: number;
  endLine: number;
  form: "colon" | "paren";
};

function isWithinAnySpan(
  index: number,
  spans: Array<[number, number]>,
): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

function collectShortFormMatches(
  content: string,
  fullSpans: Array<[number, number]>,
): ShortFormMatch[] {
  const out: ShortFormMatch[] = [];

  const colonRe = new RegExp(SHORT_FORM_COLON_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, fullSpans)) continue;
    const before = m.index > 0 ? content[m.index - 1] : undefined;
    if (before === "`") continue;
    if (before !== undefined && /[\w./-]/.test(before)) continue;
    if (content[m.index + m[0].length] === "`") continue;
    out.push({
      index: m.index,
      startLine: Number(m[1]),
      endLine: Number(m[2]),
      form: "colon",
    });
  }

  const parenRe = new RegExp(SHORT_FORM_PAREN_RE.source, "g");
  while ((m = parenRe.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, fullSpans)) continue;
    const before = m.index > 0 ? content[m.index - 1] : undefined;
    if (before === "`") continue;
    if (before !== undefined && /\w/.test(before)) continue;
    if (content[m.index + m[0].length] === "`") continue;
    out.push({
      index: m.index,
      startLine: Number(m[1]),
      endLine: Number(m[2]),
      form: "paren",
    });
  }

  return out.sort((a, b) => a.index - b.index);
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

/**
 * The citedPath of the nearest full citation strictly before `beforeIndex`
 * and at or after `paragraphStart` -- "the last target document named
 * earlier in the same paragraph" -- or null when none exists.
 */
function findLastNamedTargetInParagraph(
  fullAtoms: Array<{ index: number; citedPath: string }>,
  paragraphStart: number,
  beforeIndex: number,
): string | null {
  let best: { index: number; citedPath: string } | null = null;
  for (const a of fullAtoms) {
    if (a.index >= paragraphStart && a.index < beforeIndex) {
      if (!best || a.index > best.index) best = a;
    }
  }
  return best ? best.citedPath : null;
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
    fullAtoms.push({
      kind: "full",
      index: m.index,
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : null,
    });
    fullSpans.push([m.index, m.index + m[0].length]);
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

    const { citedPath, startLine, endLine } = atom;
    const citation = `${citedPath}:${startLine}${endLine ? "-" + endLine : ""}`;

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

    const problem = checkTarget(citedPath, startLine, endLine, resolution.path);
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
    : collectShortFormMatches(content, fullSpans);
  if (shortFormMatches.length > 0) {
    const paragraphStarts = computeParagraphStarts(content);
    const namedFullAtoms: Array<{ index: number; citedPath: string }> = [];
    for (const a of fullAtoms) {
      if (a.kind === "full")
        namedFullAtoms.push({ index: a.index, citedPath: a.citedPath });
    }

    for (const sf of shortFormMatches) {
      const paragraphStart = paragraphStartFor(paragraphStarts, sf.index);
      const targetPath = findLastNamedTargetInParagraph(
        namedFullAtoms,
        paragraphStart,
        sf.index,
      );
      const rangeLabel = `${sf.startLine}-${sf.endLine}`;

      if (!targetPath) {
        pushDrift(
          findings,
          doc.relPath,
          `${rangeLabel} (short-form)`,
          "short-form-unbound",
          "no target document named earlier in this paragraph",
        );
        continue;
      }

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
        sf.form === "paren",
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
