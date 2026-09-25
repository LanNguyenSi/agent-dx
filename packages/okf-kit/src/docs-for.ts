import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./bundle.js";
import { UsageError } from "./errors.js";
import { detectRepoRoot } from "./git.js";
import { getValidSources } from "./util.js";
import type { BundleDoc, RunGit } from "./types.js";

export interface DocsForOptions {
  repoRoot?: string;
  /** Test-only override for git access; production code shells out to the real `git` binary. */
  runGit?: RunGit;
}

/** One bundle doc whose `sources` matched at least one given path, and which of its sources matched. */
export interface DocsForMatch {
  /** Bundle-relative path, forward-slash separated (same convention as `Finding.file`). */
  doc: string;
  /** The doc's own `sources` entries that matched at least one given path, sorted, deduplicated. */
  sources: string[];
}

export interface DocsForResult {
  bundleDir: string;
  matches: DocsForMatch[];
}

/**
 * `okf-kit docs-for <bundleDir> <path>...`: which bundle docs claim a given
 * (repo-root-relative) path as a `sources` entry, directly.
 *
 * Reuses the IDENTICAL `sources` population and shape validation
 * `sources-shape`/`sources-fresh` apply (`getValidSources`): a doc with no
 * `sources` key, or a malformed one, contributes no matches here either --
 * that shape error is `sources-shape`'s job to report, not this command's.
 *
 * Matching a `sources` entry against a given path:
 *  - exact match: the given path resolves (against `repoRoot`) to the exact
 *    same path the `sources` entry resolves to.
 *  - directory containment: when the `sources` entry resolves to a path
 *    that is a DIRECTORY on disk, a given path resolving underneath it also
 *    matches -- the same population `sources-fresh` assesses staleness for
 *    via a directory pathspec (see that rule's git-log lookup). A `sources`
 *    entry that does not exist on disk (already flagged by `sources-shape`)
 *    can only match by exact string equality, never by containment, since
 *    there is nothing to `fs.statSync` there.
 *
 * No glob support: `sources` entries are plain paths here exactly as they
 * are everywhere else in this package (`sources-shape`'s existence check is
 * a bare `fs.existsSync`, never a glob expansion), so `docs-for` matches the
 * same population `check` already validates against and nothing wider.
 *
 * Both the `sources` entries and the given paths are resolved the SAME way
 * (`path.resolve(repoRoot, ...)`), which is what normalizes a leading
 * `./`, a trailing slash, or `../`-relative spelling identically on both
 * sides before comparing.
 */
export function runDocsFor(
  bundleDir: string,
  paths: string[],
  options: DocsForOptions = {},
): DocsForResult {
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    throw new UsageError(`Bundle directory does not exist: ${bundleDir}`);
  }
  if (paths.length === 0) {
    throw new UsageError("docs-for requires at least one <path> argument");
  }
  const resolvedBundleDir = path.resolve(bundleDir);
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : detectRepoRoot(resolvedBundleDir, options.runGit);
  if (!repoRoot) {
    throw new UsageError(
      "docs-for could not determine a repo root (pass --repo-root; auto-detection via " +
        "`git rev-parse --show-toplevel` found no enclosing git work tree)",
    );
  }
  const ctx = loadBundle(resolvedBundleDir, repoRoot, options.runGit);

  const docsWithSources = ctx.docs
    .map((doc) => ({ doc, sources: getValidSources(doc.frontmatter.parsed) }))
    .filter(
      (entry): entry is { doc: BundleDoc; sources: string[] } =>
        entry.sources !== undefined,
    );

  const givenAbsPaths = paths.map((p) => path.resolve(repoRoot, p));

  const matches: DocsForMatch[] = [];
  for (const { doc, sources } of docsWithSources) {
    const matchedSources = new Set<string>();
    for (const source of sources) {
      const sourceAbs = path.resolve(repoRoot, source);
      let sourceIsDir = false;
      try {
        sourceIsDir = fs.statSync(sourceAbs).isDirectory();
      } catch {
        sourceIsDir = false;
      }
      for (const given of givenAbsPaths) {
        if (given === sourceAbs) {
          matchedSources.add(source);
        } else if (sourceIsDir && isWithinDirectory(sourceAbs, given)) {
          matchedSources.add(source);
        }
      }
    }
    if (matchedSources.size > 0) {
      matches.push({
        doc: doc.relPath,
        sources: [...matchedSources].sort(),
      });
    }
  }
  matches.sort((a, b) => a.doc.localeCompare(b.doc));
  return { bundleDir: resolvedBundleDir, matches };
}

/** Whether `target` is `dir` itself or a path underneath it. Both must already be resolved, absolute paths. */
function isWithinDirectory(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Text output: one doc per line (bundle-relative path, matching `check`'s
 * own `Finding.file` convention), followed by the `sources` entries of its
 * that matched, so a human can see WHICH source claim(s) pulled the doc in
 * without switching to `--json`. "no matches" is reported explicitly rather
 * than as silent empty output, mirroring `renderText`'s own "clean, no
 * findings" line in report.ts.
 */
export function renderDocsForText(result: DocsForResult): string {
  if (result.matches.length === 0) {
    return `okf-kit: no bundle doc claims any given path as a source, in ${result.bundleDir}\n`;
  }
  const lines = result.matches.map((m) => `${m.doc}: ${m.sources.join(", ")}`);
  return lines.join("\n") + "\n";
}

export function renderDocsForJson(result: DocsForResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
