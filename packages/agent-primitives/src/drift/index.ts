import { UsageError } from "../envelope.js";
import { findGitRoot } from "../probe/containment.js";
import {
  diffText,
  grepHeadDeclarations,
  grepIdentifier,
  isShallowRepository,
  mergeBase,
  resolveCommit,
  showFile,
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

/** The declaration keywords the head-side binding query greps for (see
 * `grepHeadDeclarations`). */
export const DECLARATION_KEYWORDS = [
  "const",
  "let",
  "var",
  "function",
  "class",
];

/** What a head-side hit's text before the keyword, trimmed, may start with
 * to count as a comment line (`isLiveHeadDeclaration` rejects it). */
export const LOCAL_BINDING_COMMENT_PREFIXES = ["//", "/*", "*", "#"];

/** A character that continues an identifier: right after the name it means
 * the hit is a longer name, not `name`. */
export const NAME_CONTINUATION_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * Whether one head-side grep hit is a live declaration of `name` rather
 * than a mention grep's shape cannot tell apart. `git grep -w -E` matches
 * any line CARRYING `(const|let|var|function|class) <name>`, so two shapes
 * reach the caller without being declarations: a comment line (`// const
 * stamp = old approach`) and a longer name whose next character git's `-w`
 * reads as a word boundary (`let retired$old` - git treats `$` as a
 * non-word character). A hit counts only when (i) the text before the
 * keyword, trimmed, names no comment (`//`, `*`, `/*` or `#`) and (ii) the
 * character right after `name` is absent or outside `[A-Za-z0-9_$]`; a
 * real declaration satisfies both. Only those two facts are checked: the
 * shape inside a string, a template literal, JSX text, or a comment that
 * does not start the line still counts as a declaration. The word boundary
 * BEFORE the keyword is not checked here either; it is `git grep -w`'s
 * (see `grepHeadDeclarations`). Behind `-w` the letter, digit and `_`
 * parts of the trailing check are redundant (only `$` reaches it), kept as
 * a guard that does not depend on the grep flag.
 */
export function isLiveHeadDeclaration(text: string, name: string): boolean {
  for (const keyword of DECLARATION_KEYWORDS) {
    const needle = `${keyword} ${name}`;
    for (
      let at = text.indexOf(needle);
      at !== -1;
      at = text.indexOf(needle, at + 1)
    ) {
      const before = text.slice(0, at).trim();
      if (LOCAL_BINDING_COMMENT_PREFIXES.some((p) => before.startsWith(p))) {
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
  // line says nothing about whether the name is gone. Ask head ONCE per
  // candidate name whether a declaration shape of that name survives in the
  // scanned source; where one does, the name is still alive under a local
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
    const head = grepHeadDeclarations(gitRoot, headSha, name, SOURCE_PATHSPECS);
    if (head.error !== undefined || (head.status !== 0 && head.status !== 1)) {
      warnings.push(
        `git grep for a head-side declaration of "${name}" at ${headSha} failed: ${head.error ?? `git exited ${String(head.status)}: ${head.stderr.trim()}`}`,
      );
      continue;
    }
    if (
      head.status === 0 &&
      parseGrepOutput(head.stdout, headSha).some((hit) =>
        isLiveHeadDeclaration(hit.text, name),
      )
    ) {
      localBindings.add(name);
    }
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
