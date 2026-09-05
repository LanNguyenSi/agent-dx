import { UsageError } from "../envelope.js";
import { findGitRoot } from "../probe/containment.js";
import { diffText, grepIdentifier, revExists, showFile } from "./git.js";
import {
  parseRemovedIdentifiers,
  type RemovedIdentifier,
} from "./parseDiff.js";
import {
  historicalPhraseMatch,
  matchesAnyGlob,
  nearestHeading,
  parseHeadings,
  type Heading,
} from "./allowlist.js";
import { classifyLine, parseGrepOutput, SCAN_PATHSPECS } from "./scan.js";

export type { RemovedIdentifier, RemovedIdentifierKind } from "./parseDiff.js";

export interface DriftOptions {
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

function isMigrationPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes("docs/") && lower.includes("migration");
}

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|mdx)$/i.test(filePath);
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
 * historical phrase on the line itself.
 */
function classifySite(
  filePath: string,
  line: number,
  text: string,
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
  const phrase = historicalPhraseMatch(text);
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

  if (findGitRoot(cwd) === undefined) {
    throw new UsageError(`drift: ${cwd} is not inside a git work tree`);
  }
  if (!revExists(cwd, options.base)) {
    throw new UsageError(`drift: --base revision not found: ${options.base}`);
  }
  if (!revExists(cwd, options.head)) {
    throw new UsageError(`drift: --head revision not found: ${options.head}`);
  }

  const diffResult = diffText(cwd, options.base, options.head);
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

  const uniqueNames = [...new Set(parsed.removed.map((r) => r.name))];
  const sites: DriftSite[] = [];
  const allowlisted: DriftSite[] = [];
  const headingsByPath = new Map<string, Heading[]>();

  const headingsFor = (filePath: string): Heading[] => {
    const cached = headingsByPath.get(filePath);
    if (cached !== undefined) return cached;
    const content = showFile(cwd, options.head, filePath);
    const headings = content !== undefined ? parseHeadings(content) : [];
    headingsByPath.set(filePath, headings);
    return headings;
  };

  for (const name of uniqueNames) {
    const grep = grepIdentifier(cwd, options.head, name, SCAN_PATHSPECS);
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
        allowGlobs,
        needsHeadings ? headingsFor(match.path) : [],
      );
      const base: DriftSite = {
        path: match.path,
        line: match.line,
        identifier: name,
        kind,
        text: match.text.trim(),
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
