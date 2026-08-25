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
// line that is nothing but a bracket (open or close), optionally with a
// trailing `,`/`;`, is always a drift signal. A bare code-fence delimiter is
// its own, separate signal (see MD_FENCE_DELIM_RE): unlike a bracket, a
// fence line is sometimes the deliberately-correct start of a citation (see
// checkRangeBoundary's markdown branch for the opening-fence exception).
const MD_BARE_BRACKET_RE = /^(?:[)\]}][;,]?|[[({])$/;
const MD_FENCE_DELIM_RE = /^(?:`{3,}\S*|~{3,}\S*)$/;
// Short-form plausibility gate (see collectShortFormMatches): a bare N-M
// range in running prose is syntactically indistinguishable from a real
// short-form citation, so these are deliberately narrow, high-confidence
// exclusions rather than an attempt at a full classifier -- see
// collectShortFormMatches's doc block for what is and is not caught by
// each of these.
const SHORT_FORM_MAX_SPAN = 300; // generous upper bound on a plausible cited block size, in lines
const YEAR_MIN = 1900;
const YEAR_MAX = 2199;
// A small, curated set of ports it is plausible for ordinary prose to name
// together (not exhaustive -- a heuristic, not a full IANA port list).
const WELL_KNOWN_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 119, 123, 143, 161, 194, 389, 443, 445, 465,
  587, 636, 873, 993, 995, 1433, 1521, 1723, 3000, 3306, 3389, 5432, 5672, 5900,
  5984, 6379, 6443, 7000, 8000, 8080, 8081, 8443, 8888, 9000, 9042, 9092, 9200,
  9300, 11211, 15672, 27017,
]);
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
 * True when the line at `lines[lineIndex]` is a fence delimiter
 * (```` ``` ```` or `~~~`, optionally with a trailing language tag) that
 * *opens* a fenced code block, as opposed to closing one -- determined by
 * replaying the same open/close state machine `stripFencedCode`-style
 * scanners use from the top of the document, not by the line's own text
 * (a bare closing fence and an untagged opening fence are lexically
 * identical). Used by checkRangeBoundary's markdown branch: citing a
 * fenced block starting at its own opening fence line is the natural,
 * correct way to cite it, so that specific case is exempted from the
 * fence-as-drift-signal check (see there).
 */
function isFenceOpeningLine(lines: string[], lineIndex: number): boolean {
  let inFence = false;
  let fenceMarker: string | undefined;
  for (let i = 0; i <= lineIndex; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!inFence && MD_FENCE_DELIM_RE.test(trimmed)) {
      if (i === lineIndex) return true;
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
    } else if (inFence && fenceMarker && trimmed.startsWith(fenceMarker)) {
      if (i === lineIndex) return false;
      inFence = false;
      fenceMarker = undefined;
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
 * equivalents), both short-form syntaxes alike (colon-form and paren-form
 * are no longer distinguished here -- see the "Short-form citations" doc
 * block for why the earlier paren-only gate was removed): the range must
 * start on a `describe(`/`it(` head line and end on a matching closing
 * `});` line. Severity split, by evidence strength: a wrong START line is a
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
 * code-fence delimiter (MD_FENCE_DELIM_RE) gets the same treatment at the
 * END of a range, but NOT at the START when that start line is itself a
 * genuine *opening* fence (see isFenceOpeningLine): citing a fenced code
 * block starting at its own opening delimiter is the natural, correct way
 * to cite it, not drift.
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
    if (MD_BARE_BRACKET_RE.test(endTrim) || MD_FENCE_DELIM_RE.test(endTrim)) {
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
 * test-file/markdown block-boundary check above (applied to both short-form
 * syntaxes alike; see checkRangeBoundary).
 */
function checkShortFormTarget(
  citedPath: string,
  startLine: number,
  endLine: number,
  resolvedPath: string,
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
 * earlier in its own paragraph is reported unresolved (`short-form-unbound`,
 * a NOTICE, not a warning -- see the plausibility gate note below for why),
 * never silently skipped: unlike a continuation right after a
 * rejected/ambiguous citation (which has a real reason to skip -- that
 * citation's resolution is known unusable), a short-form's paragraph simply
 * never named a target, itself worth flagging.
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
 *     span (the tail of a real `path:N-M` citation, not a new short form),
 *     a fenced or indented code block, an inline code span, or a Markdown
 *     table row (see computeExcludedSpans) -- a bare numeric range inside
 *     any of these is virtually never a citation
 *   - the character immediately before or after the match is a backtick
 *     (the backtick continuation forms above already own that syntax)
 *   - (colon form) the character immediately before the `:` is a
 *     path/word character (`[\w./-]`) -- a real filename character there
 *     means this is plausibly part of some other, unrecognised
 *     citation-like token, not a bare short form
 *   - (paren form) the character immediately before the `(` is a word
 *     character -- guards against an incidental `foo(123-456)`-shaped
 *     token that is not prose
 *   - it fails the plausibility gate (see isPlausibleShortFormRange): an
 *     inverted pair, an implausibly large span, a year-range-shaped pair,
 *     or (colon form) a well-known-port-pair-shaped pair
 *
 * A resolved short-form citation is checked via checkShortFormTarget (see
 * above): checkTarget's existing checks, plus the test-file/Markdown
 * block-boundary check, applied to both short-form syntaxes alike (see
 * checkRangeBoundary; there is no longer a colon-form/paren-form split
 * there -- see that function's doc block for why the earlier split was
 * removed: sampling the drift it was hiding showed it was suppressing real
 * drift for the dominant colon-form syntax, not marking a legitimate
 * granularity convention).
 *
 * Plausibility gate (isPlausibleShortFormRange). A bare `N-M` range in
 * ordinary prose ("the window (2026-2027)", "opens :80-443") is
 * syntactically indistinguishable from a real short-form citation, so
 * these checks are narrow and high-confidence rather than an attempt at a
 * full classifier: an inverted pair (`start > end`) or a span wider than
 * SHORT_FORM_MAX_SPAN lines is rejected outright (no real citation in this
 * rule's own dogfood corpus cites a block anywhere near that wide); a pair
 * that both look like a year (four digits, 1900-2199) is rejected
 * regardless of form; a colon-form pair that both look like a well-known
 * port number (see WELL_KNOWN_PORTS) is rejected -- colon-form only,
 * because `path:N-M`-shaped prose is what motivates the colon form's
 * existence, while a bare `(80-443)` in prose is comparatively rare. A
 * range that passes this gate but is not actually a citation (e.g. a small
 * plain-English number range like "steps (2-4)") can still be collected
 * and, if a real citation happens to be named earlier in the same
 * paragraph, silently bound to it; this is a known, documented limitation
 * (see the README) rather than a false positive this mechanical gate can
 * close without either a semantic parser or rejecting genuine small-range
 * citations (this rule's own short-form fixture cites ranges as narrow as
 * one line).
 */
function isPlausibleShortFormRange(
  startLine: number,
  endLine: number,
  form: "colon" | "paren",
): boolean {
  if (startLine > endLine) return false;
  if (endLine - startLine > SHORT_FORM_MAX_SPAN) return false;
  const looksLikeYear = (n: number) =>
    n >= YEAR_MIN && n <= YEAR_MAX && String(n).length === 4;
  if (looksLikeYear(startLine) && looksLikeYear(endLine)) return false;
  if (
    form === "colon" &&
    WELL_KNOWN_PORTS.has(startLine) &&
    WELL_KNOWN_PORTS.has(endLine)
  ) {
    return false;
  }
  return true;
}

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
  excludedSpans: Array<[number, number]>,
): ShortFormMatch[] {
  const out: ShortFormMatch[] = [];

  const colonRe = new RegExp(SHORT_FORM_COLON_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, excludedSpans)) continue;
    const before = m.index > 0 ? content[m.index - 1] : undefined;
    if (before === "`") continue;
    if (before !== undefined && /[\w./-]/.test(before)) continue;
    if (content[m.index + m[0].length] === "`") continue;
    const startLine = Number(m[1]);
    const endLine = Number(m[2]);
    if (!isPlausibleShortFormRange(startLine, endLine, "colon")) continue;
    out.push({ index: m.index, startLine, endLine, form: "colon" });
  }

  const parenRe = new RegExp(SHORT_FORM_PAREN_RE.source, "g");
  while ((m = parenRe.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, excludedSpans)) continue;
    const before = m.index > 0 ? content[m.index - 1] : undefined;
    if (before === "`") continue;
    if (before !== undefined && /\w/.test(before)) continue;
    if (content[m.index + m[0].length] === "`") continue;
    const startLine = Number(m[1]);
    const endLine = Number(m[2]);
    if (!isPlausibleShortFormRange(startLine, endLine, "paren")) continue;
    out.push({ index: m.index, startLine, endLine, form: "paren" });
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
 * a reason to scan its contents for short-form citations.
 */
function computeFencedSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const lines = content.split("\n");
  let offset = 0;
  let fenceMarker: string | undefined;
  let fenceStart = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    const lineEnd = offset + line.length;
    if (!fenceMarker && MD_FENCE_DELIM_RE.test(trimmed)) {
      fenceMarker = trimmed.slice(0, 3);
      fenceStart = offset;
    } else if (fenceMarker && trimmed.startsWith(fenceMarker)) {
      spans.push([fenceStart, lineEnd]);
      fenceMarker = undefined;
      fenceStart = -1;
    }
    offset = lineEnd + 1; // +1 for the newline joining this line to the next
  }
  if (fenceMarker && fenceStart >= 0) {
    spans.push([fenceStart, content.length]);
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
 */
function computeInlineCodeSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(`+)[^`]*?\1/g;
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
    : collectShortFormMatches(content, [
        ...fullSpans,
        ...computeExcludedSpans(content),
      ]);
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
          "no full `path:N` citation earlier in this paragraph to bind to",
          undefined,
          "notice",
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
