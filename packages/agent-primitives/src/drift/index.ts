import { UsageError } from "../envelope.js";
import { findGitRoot } from "../probe/containment.js";
import { diffText, grepIdentifier, revExists, showFile } from "./git.js";
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
import { classifyLine, parseGrepOutput, SCAN_PATHSPECS } from "./scan.js";

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
  /** When true, an allowlisted site is ALSO added to `sites` (flagged
   * with `allowlisted: true` and its `allowlistReason`), so a mention
   * this command would otherwise suppress by default counts toward the
   * reported findings and the exit code too. `allowlisted` always
   * carries every allowlisted site regardless of this flag. */
  strict?: boolean;
}

export type DriftKind = "doc" | "comment";

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
  removedIdentifiers: RemovedIdentifier[];
  sites: DriftSite[];
  allowlisted: DriftSite[];
  counts: DriftCounts;
  warnings: string[];
}

function isChangelogPath(filePath: string): boolean {
  return /changelog/i.test(filePath.split("/").pop() ?? "");
}

/** Matches the README's documented rule, `docs/**\/migration*`: a
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
 * Given a git range (`base..head`), collects the identifiers whose
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
  if (!revExists(gitRoot, options.base)) {
    throw new UsageError(`drift: --base revision not found: ${options.base}`);
  }
  if (!revExists(gitRoot, options.head)) {
    throw new UsageError(`drift: --head revision not found: ${options.head}`);
  }

  const diffResult = diffText(gitRoot, options.base, options.head);
  if (diffResult.error !== undefined || diffResult.status !== 0) {
    throw new UsageError(
      `drift: git diff ${options.base}..${options.head} failed: ` +
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
  const sites: DriftSite[] = [];
  const allowlisted: DriftSite[] = [];
  const headingsByPath = new Map<string, Heading[]>();

  const headingsFor = (filePath: string): Heading[] => {
    const cached = headingsByPath.get(filePath);
    if (cached !== undefined) return cached;
    const content = showFile(gitRoot, options.head, filePath);
    const headings = content !== undefined ? parseHeadings(content) : [];
    headingsByPath.set(filePath, headings);
    return headings;
  };

  for (const name of uniqueNames) {
    const grep = grepIdentifier(gitRoot, options.head, name, SCAN_PATHSPECS);
    if (grep.error !== undefined || (grep.status !== 0 && grep.status !== 1)) {
      warnings.push(
        `git grep for "${name}" at ${options.head} failed: ${grep.error ?? `git exited ${String(grep.status)}: ${grep.stderr.trim()}`}`,
      );
      continue;
    }
    if (grep.status === 1) continue;
    const matches = parseGrepOutput(grep.stdout, options.head);
    for (const match of matches) {
      const kind = classifyLine(match.path, match.text);
      if (kind === undefined) continue;
      const needsHeadings =
        isChangelogPath(match.path) || isMarkdownPath(match.path);
      const decision = classifySite(
        match.path,
        match.line,
        match.text,
        name,
        allowGlobs,
        needsHeadings ? headingsFor(match.path) : [],
      );
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
    removedIdentifiers: parsed.removed,
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
