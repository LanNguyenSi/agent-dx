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
 *   2. repo-root-relative (`<repoRoot>/<citedPath>`)
 *   3. doc-relative (`<dirname(doc)>/<citedPath>`)
 *   4. the nearest earlier citation *in the same doc* whose path contains a
 *      `/` and ends with the same suffix as citedPath (the "last full path
 *      mentioned" convention)
 *   5. a repo-wide search for a file whose path ends with citedPath (or,
 *      for a bare filename, whose basename equals it)
 * A citedPath starting with `/` is treated as out of scope (an absolute or
 * placeholder path, e.g. inside a fabricated example stack trace) and
 * skipped without a finding. When step 5 finds more than one candidate the
 * citation is reported as a `notice`-severity "ambiguous target" finding
 * rather than guessed at or false-flagged as missing (never counted toward
 * `--strict`). A citation resolved by none of the above, with zero
 * candidates at step 5, is reported as `missing-file`. A citedPath
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

type Problem = { rule: string; message: string };

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

/** Repo-wide search for files with an exact basename, memoized per root. */
const basenameIndexCache = new Map<string, Map<string, string[]>>();
function findByBasename(root: string, basename: string): string[] {
  let index = basenameIndexCache.get(root);
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
    basenameIndexCache.set(root, index);
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
 * Resolves a citation's path to a single real file. Returns `{ skip: true }`
 * for a citedPath out of scope (leading `/`), `{ path }` on a definitive
 * single resolution, `{ ambiguous: true, candidates }` when more than one
 * plausible target exists, or `null` when nothing matches. Callers must
 * reject a citedPath with a `..` segment (see hasParentSegment) before
 * calling this; it is not re-checked here.
 */
function resolveCitation(
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
  const bySuffix = findByBasename(root, base).filter((m) => {
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

function checkTarget(
  citedPath: string,
  startLine: number,
  endLine: number | null,
  resolvedPath: string,
): Problem | null {
  const content = fs.readFileSync(resolvedPath, "utf8");
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
  const content = fs.readFileSync(resolvedPath, "utf8");
  const lineCount = splitLines(content).length;
  return checkRangeBound(startLine, endLine, lineCount);
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

function pushDrift(
  findings: Finding[],
  file: string,
  citation: string,
  rule: string,
  message: string,
  resolvedTo?: string,
): void {
  findings.push({
    ruleId: RULE_ID,
    severity: "warning",
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

function scanDoc(root: string, bundleDir: string, doc: BundleDoc): Finding[] {
  const findings: Finding[] = [];
  const content = doc.raw;
  const sources = getValidSources(doc.frontmatter.parsed) ?? [];
  const docAbsPath = path.join(bundleDir, doc.relPath);

  const fullAtoms: Atom[] = [];
  const re = new RegExp(CITATION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    fullAtoms.push({
      kind: "full",
      index: m.index,
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : null,
    });
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
      if (problem) {
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
      if (problem) {
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
        `could not resolve ${citedPath}: tried doc sources, repo-root, doc-relative, nearest prior qualified mention, repo-wide search; no candidate file exists`,
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
    if (problem) {
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
    return ctx.docs.flatMap((doc) => scanDoc(root, ctx.bundleDir, doc));
  },
};
