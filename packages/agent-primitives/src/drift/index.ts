import { UsageError } from "../envelope.js";
import { withoutPathspecEnv } from "../git-env.js";
import { findGitRoot } from "../probe/containment.js";
import {
  diffText,
  grepIdentifier,
  isShallowRepository,
  mergeBase,
  resolveCommit,
  runGit,
  showFile,
  type GitRunResult,
} from "./git.js";
import {
  parseRemovedIdentifiers,
  type RemovedIdentifier,
} from "./parseDiff.js";
import {
  historicalPhraseNearIdentifier,
  matchesAnyGlob,
  nearestHeading,
  parseHeadings,
  type Heading,
} from "./allowlist.js";
import {
  classifyLine,
  parseGrepOutput,
  PHP_SOURCE_PATHSPECS,
  SCAN_PATHSPECS,
  SOURCE_PATHSPECS,
} from "./scan.js";

export type { RemovedIdentifier, RemovedIdentifierKind } from "./parseDiff.js";

export interface DriftOptions {
  /** Any directory inside the target git work tree; every path this
   * command reports and every `--allow` glob it matches against is
   * root-relative regardless of where `cwd` itself sits (see `drift()`'s
   * own doc comment). */
  cwd: string;
  base: string;
  head: string;
  /** `--allow` globs: a site whose path matches one is allowlisted with
   * reason `"matched --allow glob \"<glob>\""`. */
  allow?: readonly string[];
  /** `--ignore-identifier` / `--ignore-identifier-file` names: every site
   * of one of these identifiers is allowlisted with reason
   * `ignored identifier "<name>"`, ahead of the `--allow`, CHANGELOG,
   * migration and historical-phrase reasons. Each name is echoed back in
   * `ignoredIdentifiers` whether or not it produced a site. An empty or
   * whitespace-only name is a usage error. */
  ignoreIdentifiers?: readonly IgnoredIdentifierInput[];
  /** When true, an allowlisted site is ALSO added to `sites` (flagged
   * with `allowlisted: true` and its `allowlistReason`), so a mention
   * this command would otherwise suppress by default counts toward the
   * reported findings and the exit code too. `allowlisted` always
   * carries every allowlisted site regardless of this flag. */
  strict?: boolean;
}

export type DriftKind = "doc" | "comment";

/** Where an ignored identifier came from: one `--ignore-identifier` flag,
 * one line of an `--ignore-identifier-file`, or this command's own
 * local-binding rule (see `drift()`). */
export type IgnoredIdentifierSource = "flag" | "file" | "local-binding";

/** One `--ignore-identifier` / `--ignore-identifier-file` entry as the CLI
 * hands it over: the name and where it came from, so the envelope can echo
 * the provenance back. */
export interface IgnoredIdentifierInput {
  name: string;
  source: Exclude<IgnoredIdentifierSource, "local-binding">;
}

/** One entry of the echoed `ignoredIdentifiers`: an ignored name and its
 * source. Every name the caller asked to ignore is echoed, including one
 * that produced no site at all; a `local-binding` entry is a name this
 * command suppressed by its own default rule. */
export interface IgnoredIdentifier {
  name: string;
  source: IgnoredIdentifierSource;
}

export interface DriftSite {
  path: string;
  line: number;
  identifier: string;
  kind: DriftKind;
  /** The matched line, trimmed, and capped at 300 characters with a
   * trailing `"..."` marker when the line itself is longer. */
  text: string;
  allowlisted?: boolean;
  allowlistReason?: string;
}

export interface DriftCounts {
  removed: number;
  sites: number;
  allowlisted: number;
}

/** Reused, per the package's own status-to-exit-code convention (see
 * `envelope.ts`'s `STATUS_CLASS`, which this task does not modify):
 * `"ok"` (exit 0), `"fail"` (exit 1, borrowed from `verify`'s own
 * finding status, since a mention of a removed identifier is exactly
 * that: something this run found wrong), `"usage_error"` (exit 2). */
export type DriftStatus = "ok" | "fail" | "usage_error";

export interface DriftResult {
  status: DriftStatus;
  base: string;
  head: string;
  /** The commit `base` resolved to. */
  baseSha: string;
  /** The commit `head` resolved to. */
  headSha: string;
  /** The commit the diff actually started from: the merge-base of
   * `baseSha` and `headSha`. Equal to `baseSha` when `base` is an ancestor
   * of `head`. */
  mergeBase: string;
  removedIdentifiers: RemovedIdentifier[];
  /** Every ignored name and where the ignore came from: all of the
   * `ignoreIdentifiers` input (deduplicated, in the order first given) plus
   * one `local-binding` entry per name the default rule suppressed. */
  ignoredIdentifiers: IgnoredIdentifier[];
  sites: DriftSite[];
  allowlisted: DriftSite[];
  counts: DriftCounts;
  warnings: string[];
}

function isChangelogPath(filePath: string): boolean {
  return /changelog/i.test(filePath.split("/").pop() ?? "");
}

/** Matches docs/drift.md's documented rule, `docs/**\/migration*`: a
 * `docs/` path segment (at the start of the path, or after a `/`) with
 * "migration" appearing somewhere in the remainder of the path. A loose
 * `includes("docs/") && includes("migration")` (the prior check) also
 * passed a path like `migration/docs/x.md`, where "docs/" and
 * "migration" both appear but not in a `docs/**` subtree at all. */
function isMigrationPath(filePath: string): boolean {
  return /(^|\/)docs\/.*migration/i.test(filePath);
}

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|mdx)$/i.test(filePath);
}

/** The most a `DriftSite.text` ever carries: a site's text is the whole
 * matched source line, and an ordinary line stays well under this, but an
 * unusually long line (a dense CHANGELOG bullet, a long comment) would
 * otherwise dominate the envelope's size and starve `sites`/`counts` out
 * of the default `--max-chars` budget under reduction. Cut with a
 * trailing `"..."` marker rather than silently, so a reader can tell the
 * text was capped rather than that the line itself ended there. */
const SITE_TEXT_MAX_CHARS = 300;

function capSiteText(text: string): string {
  if (text.length <= SITE_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, SITE_TEXT_MAX_CHARS)}...`;
}

/** The declaration keywords the head-side binding query greps for
 * (`headDeclarationGrep`), in the order they appear in its pattern. The
 * TS/JS set plus the keywords every other language this command extracts
 * declarations from spells a declaration with: PHP declares with
 * `interface`, `trait` and `enum` (its `function`/`const`/`class` are
 * already listed), and a head-side `type`, `interface` or `enum`
 * declaration now counts for the TS/JS local-binding rule the same way a
 * `class` one does. Several of these are common English words, which is
 * safe only because `isAnchoredBefore` rejects a keyword reached through
 * an open string literal or standing behind anything but a modifier or an
 * opener: one inside a string or in the middle of an expression does not
 * count. Add a keyword HERE, never in the grep call, which is derived
 * from this list. */
export const DECLARATION_KEYWORDS = [
  "const",
  "let",
  "var",
  "function",
  "class",
  "type",
  "interface",
  "enum",
  "trait",
];

/** The words that may stand between a head-side line's start and its
 * declaration keyword and still leave the keyword the line's first token
 * (the anchor `isAnchoredBefore` accepts on its own): TS/JS's
 * `export`/`default`/`declare`/`async` plus the modifiers PHP spells
 * ahead of a declaration (`abstract`, `final`, `readonly`, `static`,
 * visibility); `async` is here because the extraction regex accepts it
 * ahead of `function`, so a head-side `async function` binding must
 * anchor too. Derived into the modifier-prefix test below; add a
 * modifier HERE, never in the expression. */
export const HEAD_KEYWORD_MODIFIERS = [
  "export",
  "default",
  "declare",
  "async",
  "abstract",
  "final",
  "readonly",
  "static",
  "public",
  "protected",
  "private",
];

/** The openers that may stand immediately before a head-side keyword (with
 * only whitespace after the opener) and still leave what follows a
 * declaration: the boundaries a legal declaration follows - an open paren
 * (a `for (const x of y)` head), an open brace (a block or arrow body, an
 * `if (x) { const y = 1 }`), a semicolon (the statement after one), an
 * arrow (an expression-bodied callback), a colon (a `case` or label).
 * Checked by `isAnchoredBefore`; add an opener HERE, never in the
 * expression. */
export const HEAD_KEYWORD_OPENERS = ["(", "{", ";", "=>", ":"];

const HEAD_KEYWORD_MODIFIER_PREFIX_RE = new RegExp(
  `^\\s*(?:(?:${HEAD_KEYWORD_MODIFIERS.join("|")})\\s+)*$`,
);

const HEAD_KEYWORD_OPENER_SUFFIX_RE = new RegExp(
  `(?:${HEAD_KEYWORD_OPENERS.map((opener) => escapeRegExp(opener)).join("|")})\\s*$`,
);

/**
 * Whether the text before a head-side keyword occurrence is an anchor for
 * it, i.e. whether a keyword standing there is a declaration rather than
 * part of an expression. Both must hold: (i) QUOTE PARITY - `before`
 * holds an even number of `"`, an even number of `'` and an even number
 * of backticks, so a keyword reached through an open string literal never
 * counts (`const s = "const err` has one `"` open, and `const` and `type`
 * are common English words inside prose strings); and (ii) it is either
 * only whitespace plus `HEAD_KEYWORD_MODIFIERS` (the keyword is the
 * line's first token after optional modifiers), or it ends with one of
 * `HEAD_KEYWORD_OPENERS` plus optional whitespace (a loop head, a block
 * or arrow body, the statement after a `;`, a `case` label). Accepted
 * limits: a keyword behind a mid-line comment that itself follows an
 * opener counts (`{ // const err`), since the comment guard below only
 * names a comment at the START of `before`; and a string that opened on an
 * earlier line has no quote visible here, so parity cannot see it.
 * Callers pass `before` already lowercased when the keyword was matched
 * case-insensitively (the `.php` pass).
 */
export function isAnchoredBefore(before: string): boolean {
  for (const quote of ['"', "'", "`"]) {
    if ((before.split(quote).length - 1) % 2 !== 0) return false;
  }
  return (
    HEAD_KEYWORD_MODIFIER_PREFIX_RE.test(before) ||
    HEAD_KEYWORD_OPENER_SUFFIX_RE.test(before)
  );
}

/** Regex metacharacters, escaped before an identifier is put into an
 * extended regular expression (a name can legally contain `$`). */
function escapeRegExp(text: string): string {
  return text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

/** The `git grep -E` pattern of the head-side binding query: every
 * declaration keyword followed by ` <name>`, built from
 * `DECLARATION_KEYWORDS` so the keyword list lives exactly once. The
 * trailing word boundary the shape needs is `-w`'s own (git's `-E` on a
 * BSD regex build reads `\b` as a literal, which would silently match
 * nothing); `-w` also supplies the boundary BEFORE the keyword, so
 * `superclass err` never matches the query for `err`. */
export function headDeclarationPattern(
  name: string,
  keywords: readonly string[] = DECLARATION_KEYWORDS,
): string {
  return `(${keywords.join("|")}) ${escapeRegExp(name)}`;
}

/** `git grep -n -w -E [-i] -e <headDeclarationPattern(name)> <rev> --
 * <pathspecs>`: does `name` still have a declaration-shaped line at
 * `rev` anywhere in the scanned source files (the head-side binding the
 * local-binding rule of `drift()` looks for)? One call per name and
 * pathspec group, never one per file; `ignoreCase` is set only for the
 * second, `.php`-only pass (`PHP_SOURCE_PATHSPECS`), because PHP is the
 * one scanned language whose keywords are case-insensitive and the
 * filter would otherwise never see a `FUNCTION`-spelled declaration for
 * grep to return. Three shapes that match here are not live declarations
 * and are filtered after the grep, in the caller
 * (`isLiveHeadDeclaration`): a comment line (`// const stamp = old
 * approach`), a longer name whose next character `-w` reads as a word
 * boundary (`let retired$old`, because git treats `$` as a non-word
 * character), and a keyword reached through an expression or a string
 * (`throw new Error("unexpected type payload")`). A name bound by
 * destructuring (`const { err } = ...`) and a function parameter are not
 * declaration shapes and are not seen. */
function headDeclarationGrep(
  cwd: string,
  rev: string,
  name: string,
  pathspecs: readonly string[],
  ignoreCase = false,
): GitRunResult {
  return runGit(
    cwd,
    [
      "grep",
      "-n",
      "-w",
      "-E",
      ...(ignoreCase ? ["-i"] : []),
      "-e",
      headDeclarationPattern(name),
      rev,
      "--",
      ...pathspecs,
    ],
    // The pathspecs are globs: an ambient GIT_*_PATHSPECS switch would
    // make git grep match none of them and exit 1, which reads as "no
    // head-side declaration".
    withoutPathspecEnv(),
  );
}

/** What a head-side hit's text before the keyword, trimmed, may start with
 * to count as a comment line (`isLiveHeadDeclaration` rejects it; the
 * anchor already rejects a line-start comment, this is the guard that does
 * not depend on the anchor). It reads the START of that text only, so a
 * mid-line comment behind an opener (`{ // const err`) passes: an accepted
 * limit, since rejecting it would mean treating `//` anywhere on the line
 * as a comment and losing real declarations whose initializer contains a
 * string with those characters. */
export const LOCAL_BINDING_COMMENT_PREFIXES = ["//", "/*", "*", "#"];

/** A character that continues an identifier: right after the name it means
 * the hit is a longer name, not `name`. */
export const NAME_CONTINUATION_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * Whether one head-side grep hit is a live declaration of `name` rather
 * than a mention grep's shape cannot tell apart. `git grep -w -E` matches
 * any line CARRYING `(const|let|var|function|class|type|interface|enum|
 * trait) <name>` (the pattern is derived from `DECLARATION_KEYWORDS`), so
 * three shapes reach the caller without being declarations: a keyword
 * reached through an expression or a string (`throw new Error("unexpected
 * type payload")`), a comment line (`// const stamp = old approach`), and a
 * longer name whose next character `-w` reads as a word boundary
 * (`let retired$old` - git treats `$` as a non-word character). A hit
 * counts only when (i) `isAnchoredBefore` accepts the text before the
 * keyword - quote parity, and either only whitespace and
 * `HEAD_KEYWORD_MODIFIERS` or a trailing `HEAD_KEYWORD_OPENERS` opener,
 * so a loop head, a block or arrow body or the statement after a `;`
 * counts while a keyword inside a string or in the middle of an
 * expression never does - (ii) it names no comment (`//`, `*`, `/*` or
 * `#`; the anchor already rejects a line-start comment, this is kept as a
 * guard that does not depend on the anchor), and (iii) the character right
 * after `name` is absent or outside `[A-Za-z0-9_$]`; a real declaration
 * satisfies all three. `ignoreCase` is the PHP pass (the `.php`-only
 * case-insensitive grep, see `headDeclarationGrep`): keyword, comment
 * prefixes and the anchor are then matched case-insensitively (PHP
 * keywords are), the NAME still must match its exact case (a
 * case-variant NAME is a different binding for this tool; PHP's own
 * case-insensitivity of function names is a documented limit), and the
 * caller passes it only for hits that can only come from `.php` files.
 * The word boundary BEFORE the keyword is not checked here either; it is
 * `git grep -w`'s (see `headDeclarationGrep`). Behind `-w` the letter,
 * digit and `_` parts of the trailing check are redundant (only `$`
 * reaches it), kept as a guard that does not depend on the grep flag.
 */
export function isLiveHeadDeclaration(
  text: string,
  name: string,
  ignoreCase = false,
): boolean {
  const haystack = ignoreCase ? text.toLowerCase() : text;
  for (const keyword of DECLARATION_KEYWORDS) {
    const needle = ignoreCase
      ? `${keyword} ${name.toLowerCase()}`
      : `${keyword} ${name}`;
    for (
      let at = haystack.indexOf(needle);
      at !== -1;
      at = haystack.indexOf(needle, at + 1)
    ) {
      if (
        ignoreCase &&
        text.slice(at + keyword.length + 1, at + needle.length) !== name
      ) {
        continue;
      }
      const before = text.slice(0, at);
      if (!isAnchoredBefore(ignoreCase ? before.toLowerCase() : before)) {
        continue;
      }
      const trimmedBefore = before.trim();
      if (
        LOCAL_BINDING_COMMENT_PREFIXES.some((p) => trimmedBefore.startsWith(p))
      ) {
        continue;
      }
      const after =
        at + needle.length < text.length ? text[at + needle.length] : "";
      if (after !== "" && NAME_CONTINUATION_CHARACTER.test(after)) continue;
      return true;
    }
  }
  return false;
}

interface SiteAllowDecision {
  allowlisted: boolean;
  reason?: string;
}

/**
 * Decides whether one matched site is allowlisted, and why. Checked in
 * this order (first match wins; only one reason is ever reported per
 * site even when more than one would apply): an explicit `--allow` glob,
 * a released CHANGELOG section, a migration doc path or heading, then a
 * historical phrase within a bounded span around `identifier`'s own
 * occurrence on the line (see `historicalPhraseNearIdentifier`) - never
 * the whole line, so an unrelated historical phrase far away on a long
 * line never suppresses a present-tense mention of `identifier`.
 */
function classifySite(
  filePath: string,
  line: number,
  text: string,
  identifier: string,
  allowGlobs: readonly string[],
  headings: readonly Heading[],
): SiteAllowDecision {
  const glob = matchesAnyGlob(filePath, allowGlobs);
  if (glob !== undefined) {
    return { allowlisted: true, reason: `matched --allow glob "${glob}"` };
  }
  if (isChangelogPath(filePath)) {
    const section = nearestHeading(headings, line, 2);
    if (
      section !== undefined &&
      !/unreleased/i.test(section.text) &&
      /\d+\.\d+\.\d+/.test(section.text)
    ) {
      return {
        allowlisted: true,
        reason: `released changelog section "${section.text}"`,
      };
    }
  }
  if (isMigrationPath(filePath)) {
    return { allowlisted: true, reason: "migration doc path" };
  }
  if (isMarkdownPath(filePath)) {
    const section = nearestHeading(headings, line, 2);
    if (section !== undefined && /migration/i.test(section.text)) {
      return {
        allowlisted: true,
        reason: `under migration heading "${section.text}"`,
      };
    }
  }
  const phrase = historicalPhraseNearIdentifier(text, identifier);
  if (phrase !== undefined) {
    return {
      allowlisted: true,
      reason: `historical phrase "${phrase.trim()}"`,
    };
  }
  return { allowlisted: false };
}

/**
 * Given a git range (merge-base(base, head)..head), collects the identifiers whose
 * declaration this range removed (see `parseDiff.ts`) and reports every
 * remaining mention of them, at `head`, in the repo's docs and source
 * comments (see `scan.ts`) - a doc or comment describing a removed
 * identifier as though it were still current is drift.
 *
 * Throws `UsageError` for a `cwd` outside a git work tree, a `base` or
 * `head` that does not resolve to a commit, or a `git diff` that itself
 * failed; every other outcome (including zero removed identifiers, or
 * zero mentions) is a normal, successful result.
 */
export async function drift(options: DriftOptions): Promise<DriftResult> {
  const { cwd } = options;
  const allowGlobs = options.allow ?? [];
  const warnings: string[] = [];

  const gitRoot = findGitRoot(cwd);
  if (gitRoot === undefined) {
    throw new UsageError(`drift: ${cwd} is not inside a git work tree`);
  }
  // Every git call below runs with `gitRoot` as its cwd, not the caller's
  // `cwd` (which may be a subdirectory of the work tree). `git diff` and
  // `git show <rev>:<path>` are already root-relative regardless of cwd,
  // but `git grep` reports paths relative to ITS OWN cwd: left alone, a
  // subdirectory cwd would make a heading/released-section lookup
  // silently read the wrong file (or none), and an `--allow` glob
  // written against a root-relative path would never match. Rooting the
  // grep call here, alongside the diff and show calls that already are
  // root-relative, keeps every path in this module root-relative,
  // uniformly.
  const baseSha = resolveCommit(gitRoot, options.base);
  if (baseSha === undefined) {
    throw new UsageError(`drift: --base revision not found: ${options.base}`);
  }
  const headSha = resolveCommit(gitRoot, options.head);
  if (headSha === undefined) {
    throw new UsageError(`drift: --head revision not found: ${options.head}`);
  }

  // Both revisions are resolved to commits once, and the diff runs from
  // their merge-base, so a symbolic base (a remote-tracking ref that moved
  // after the branch point) reports the same removals as the SHA it
  // resolves to. A plain `base..head` diff would also count every change
  // the base side made since the branch point as a removal on the head side.
  let diffBase: string;
  const mb = mergeBase(gitRoot, baseSha, headSha);
  if (mb.sha !== undefined) {
    diffBase = mb.sha;
  } else {
    diffBase = baseSha;
    const cause = isShallowRepository(gitRoot)
      ? "shallow clone: the history needed to find a common ancestor may be missing, fetch more history"
      : mb.reason === "no-common-ancestor"
        ? "no common ancestor"
        : `git merge-base failed: ${mb.detail}`;
    warnings.push(
      `no merge-base between ${baseSha} and ${headSha} (${cause}): diffing the two trees directly`,
    );
  }

  const diffResult = diffText(gitRoot, diffBase, headSha);
  if (diffResult.error !== undefined || diffResult.status !== 0) {
    throw new UsageError(
      `drift: git diff ${diffBase}..${headSha} failed: ` +
        (diffResult.error ??
          `git exited ${String(diffResult.status)}: ${diffResult.stderr.trim()}`),
    );
  }

  const parsed = parseRemovedIdentifiers(diffResult.stdout);
  if (parsed.movedNames.length > 0) {
    warnings.push(
      `${parsed.movedNames.length} identifier(s) declared on both a removed and an added line are treated as moved, not removed: ${parsed.movedNames.join(", ")}`,
    );
  }
  for (const skipped of parsed.skippedFileBasenames) {
    warnings.push(
      `deleted file basename skipped, not reported as a removed identifier (not a recognized source extension, or "${skipped.basename}" does not look like an identifier): ${skipped.path}`,
    );
  }
  // The PHP identifier bar, once per distinct name: a removed PHP
  // declaration whose name is an ordinary prose word (a migration's
  // `up`/`down`, a controller's `index`) was not scanned word by word
  // across every doc; the removal is still named here so the operator
  // sees the blind spot rather than a silent zero.
  for (const name of parsed.skippedPhpNames) {
    warnings.push(
      `removed PHP declaration "${name}" not scanned: does not look like an identifier`,
    );
  }
  // The extractor gap, once per extension, in extension order (which
  // `parseRemovedIdentifiers` already sorted): the diff removed lines
  // from scanned source files whose language has no declaration
  // extractor (today `.py` and `.sh`), so declarations may have been
  // removed there and nothing was collected. An absence of removed
  // identifiers from such a file is then a known blind spot, not a
  // clean result.
  for (const gap of parsed.extractorGaps) {
    warnings.push(
      `no declaration extractor for .${gap.ext}; removed identifiers from ${String(gap.files)} files not collected`,
    );
  }

  const uniqueNames = [...new Set(parsed.removed.map((r) => r.name))];

  // Ignored names, in the order first given: a `--ignore-identifier` flag
  // and an `--ignore-identifier-file` line arrive on equal terms, so a name
  // given by both forms is echoed once, with the source it arrived on
  // first (the CLI passes the flags before the file's lines).
  const explicitIgnore = new Map<string, IgnoredIdentifierInput["source"]>();
  for (const input of options.ignoreIdentifiers ?? []) {
    const name = input.name.trim();
    if (name === "") {
      throw new UsageError(
        "drift: --ignore-identifier needs an identifier name, got an empty one",
      );
    }
    if (!explicitIgnore.has(name)) explicitIgnore.set(name, input.source);
  }

  // The local-binding rule, on by default and never opt-in: a candidate
  // that was an indented, non-exported declaration was bound inside some
  // enclosing scope (a function body, a method, a block), so removing that
  // line says nothing about whether the name is gone. Ask head per
  // candidate name whether a declaration shape of that name survives in
  // the scanned source: one case-sensitive `git grep` over every scanned
  // source pathspec, plus a case-insensitive pass over just the `.php`
  // pathspecs (PHP keywords are case-insensitive; no other scanned
  // language's are). Where one does, the name is still alive under a local
  // binding of its own and a doc or comment that mentions it is not drift.
  // A name whose candidates include an exported, column-0 or non-
  // declaration one is never touched (the removal was of something public
  // or structural), and neither is a name an explicit ignore already
  // covers. Limits, documented in docs/drift.md: indentation is a proxy for
  // scope, not a scope analysis, and the head-side shape does not see a
  // destructuring binding or a parameter.
  const candidatesByName = new Map<string, RemovedIdentifier[]>();
  for (const candidate of parsed.removed) {
    const group = candidatesByName.get(candidate.name) ?? [];
    group.push(candidate);
    candidatesByName.set(candidate.name, group);
  }
  const localBindings = new Set<string>();
  for (const name of uniqueNames) {
    if (explicitIgnore.has(name)) continue;
    const candidates = candidatesByName.get(name) ?? [];
    const everyCandidateLocal =
      candidates.length > 0 &&
      candidates.every(
        (candidate) =>
          candidate.kind === "declaration" &&
          candidate.exported === false &&
          candidate.indented === true,
      );
    if (!everyCandidateLocal) continue;
    const head = headDeclarationGrep(gitRoot, headSha, name, SOURCE_PATHSPECS);
    // A second pass over the `.php` pathspecs only, case-insensitively:
    // PHP keywords are case-insensitive, so a `PRIVATE FUNCTION
    // helperThing()` at head is as live a binding as the lowercase
    // spelling - and the case-sensitive grep above would never even
    // return its line for the filter to judge.
    const phpHead = headDeclarationGrep(
      gitRoot,
      headSha,
      name,
      PHP_SOURCE_PATHSPECS,
      true,
    );
    const failed = [head, phpHead].find(
      (r) => r.error !== undefined || (r.status !== 0 && r.status !== 1),
    );
    if (failed !== undefined) {
      warnings.push(
        `git grep for a head-side declaration of "${name}" at ${headSha} failed: ${failed.error ?? `git exited ${String(failed.status)}: ${failed.stderr.trim()}`}`,
      );
      continue;
    }
    const liveAtHead =
      (head.status === 0 &&
        parseGrepOutput(head.stdout, headSha).some((hit) =>
          isLiveHeadDeclaration(hit.text, name),
        )) ||
      (phpHead.status === 0 &&
        parseGrepOutput(phpHead.stdout, headSha).some((hit) =>
          isLiveHeadDeclaration(hit.text, name, true),
        ));
    if (liveAtHead) localBindings.add(name);
  }

  const ignoredIdentifiers: IgnoredIdentifier[] = [
    ...[...explicitIgnore].map(([name, source]) => ({ name, source })),
    ...[...localBindings].map((name): IgnoredIdentifier => ({
      name,
      source: "local-binding",
    })),
  ];

  const sites: DriftSite[] = [];
  const allowlisted: DriftSite[] = [];
  const headingsByPath = new Map<string, Heading[]>();

  const headingsFor = (filePath: string): Heading[] => {
    const cached = headingsByPath.get(filePath);
    if (cached !== undefined) return cached;
    const content = showFile(gitRoot, headSha, filePath);
    const headings = content !== undefined ? parseHeadings(content) : [];
    headingsByPath.set(filePath, headings);
    return headings;
  };

  for (const name of uniqueNames) {
    const ignored = explicitIgnore.get(name);
    const grep = grepIdentifier(gitRoot, headSha, name, SCAN_PATHSPECS);
    if (grep.error !== undefined || (grep.status !== 0 && grep.status !== 1)) {
      warnings.push(
        `git grep for "${name}" at ${headSha} failed: ${grep.error ?? `git exited ${String(grep.status)}: ${grep.stderr.trim()}`}`,
      );
      continue;
    }
    if (grep.status === 1) continue;
    const matches = parseGrepOutput(grep.stdout, headSha);
    for (const match of matches) {
      const kind = classifyLine(match.path, match.text);
      if (kind === undefined) continue;
      const needsHeadings =
        isChangelogPath(match.path) || isMarkdownPath(match.path);
      let decision: SiteAllowDecision = classifySite(
        match.path,
        match.line,
        match.text,
        name,
        allowGlobs,
        needsHeadings ? headingsFor(match.path) : [],
      );
      // An ignored name outranks every path-shaped reason (it is the
      // caller's own statement about this identifier); the local-binding
      // rule is the opposite: a default that only speaks up when nothing
      // else allowlisted the site, so its reason is never a lie about a
      // glob or a heading that also happened to match.
      if (ignored !== undefined) {
        decision = {
          allowlisted: true,
          reason: `ignored identifier "${name}"`,
        };
      } else if (localBindings.has(name) && !decision.allowlisted) {
        decision = {
          allowlisted: true,
          reason: `local binding "${name}" still declared at head`,
        };
      }
      const base: DriftSite = {
        path: match.path,
        line: match.line,
        identifier: name,
        kind,
        text: capSiteText(match.text.trim()),
      };
      if (decision.allowlisted) {
        const flagged: DriftSite = {
          ...base,
          allowlisted: true,
          allowlistReason: decision.reason,
        };
        allowlisted.push(flagged);
        if (options.strict) sites.push(flagged);
      } else {
        sites.push(base);
      }
    }
  }

  return {
    status: sites.length > 0 ? "fail" : "ok",
    base: options.base,
    head: options.head,
    baseSha,
    headSha,
    mergeBase: diffBase,
    removedIdentifiers: parsed.removed,
    ignoredIdentifiers,
    sites,
    allowlisted,
    counts: {
      removed: parsed.removed.length,
      sites: sites.length,
      allowlisted: allowlisted.length,
    },
    warnings,
  };
}
