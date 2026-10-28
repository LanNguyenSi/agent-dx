import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./bundle.js";
import {
  analyzeCitationDrift,
  applyEdits,
  describeLines,
  editsFor,
  resolveBaseCommit,
  type CitationVerdict,
  type DocEdit,
} from "./citation-drift.js";
import { UsageError } from "./errors.js";
import { detectRepoRoot } from "./git.js";

export interface RepointOptions {
  /** Git ref the docs' line numbers were written against. */
  base: string;
  repoRoot?: string;
  /** Rewrite the docs. Without it nothing is written and the plan is only reported. */
  write?: boolean;
}

export interface PlannedRewrite {
  /** Bundle-relative doc path. */
  doc: string;
  /** The citation as the findings label it. */
  citation: string;
  /** Repo-relative cited file. */
  file: string;
  fromStartLine: number;
  fromEndLine: number;
  toStartLine: number;
  toEndLine: number;
}

export interface RefusedCitation {
  doc: string;
  citation: string;
  file: string;
  reason: string;
}

export interface RepointResult {
  bundleDir: string;
  base: string;
  /** True when the docs were rewritten, false for the dry run. */
  written: boolean;
  rewrites: PlannedRewrite[];
  /** Citations an edit touched: reported, never rewritten. */
  refused: RefusedCitation[];
  /** Citations with no verdict (cited file new since the ref, citation written since, ...), by reason. */
  skipped: Array<{ reason: string; count: number }>;
  /** Citations whose text still sits at the cited lines. */
  unchanged: number;
  exitCode: number;
}

/**
 * `okf-kit repoint <bundleDir> --base <ref> [--write]`: re-points every line
 * citation (full, continuation, extension and short-form) whose cited text
 * moved since `<ref>` and can be located by shifting through the hunks of
 * `git diff -U0 <ref>` (see `src/citation-drift.ts`). A citation an edit
 * touched is refused and listed. Only the digits of the line numbers are
 * rewritten: no timestamp, no frontmatter, no log entry.
 *
 * Exit code: 0 when nothing is refused, 1 when at least one citation needs
 * manual handling (rewrites are still written under `--write`).
 */
export function runRepoint(
  bundleDir: string,
  options: RepointOptions,
): RepointResult {
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    throw new UsageError(`Bundle directory does not exist: ${bundleDir}`);
  }
  const resolvedBundleDir = path.resolve(bundleDir);
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : detectRepoRoot(resolvedBundleDir);
  if (!repoRoot) {
    throw new UsageError(
      "repoint needs a git work tree: the bundle is not inside one (pass --repo-root)",
    );
  }
  const base = resolveBaseCommit(repoRoot, options.base);
  const ctx = loadBundle(resolvedBundleDir, repoRoot);
  const verdicts = analyzeCitationDrift(
    { root: repoRoot, bundleDir: resolvedBundleDir, docs: ctx.docs },
    base,
  );

  const rewrites: PlannedRewrite[] = [];
  const refused: RefusedCitation[] = [];
  const skipped = new Map<string, number>();
  const editsByDoc = new Map<string, DocEdit[]>();
  let unchanged = 0;
  for (const verdict of verdicts as CitationVerdict[]) {
    const { citation } = verdict;
    if (verdict.status === "ok") {
      unchanged++;
    } else if (verdict.status === "skipped") {
      skipped.set(verdict.reason, (skipped.get(verdict.reason) ?? 0) + 1);
    } else if (verdict.status === "changed") {
      refused.push({
        doc: citation.docRelPath,
        citation: citation.label,
        file: verdict.file,
        reason: verdict.reason,
      });
    } else {
      rewrites.push({
        doc: citation.docRelPath,
        citation: citation.label,
        file: verdict.file,
        fromStartLine: citation.startLine,
        fromEndLine: citation.endLine,
        toStartLine: verdict.newStartLine ?? citation.startLine,
        toEndLine: verdict.newEndLine ?? citation.endLine,
      });
      const edits = editsByDoc.get(citation.docRelPath) ?? [];
      edits.push(...editsFor(verdict));
      editsByDoc.set(citation.docRelPath, edits);
    }
  }

  if (options.write) {
    for (const doc of ctx.docs) {
      const edits = editsByDoc.get(doc.relPath);
      if (!edits || edits.length === 0) continue;
      const updated = applyEdits(doc.raw, edits);
      fs.writeFileSync(path.join(resolvedBundleDir, doc.relPath), updated);
    }
  }

  return {
    bundleDir: resolvedBundleDir,
    base: options.base,
    written: Boolean(options.write),
    rewrites,
    refused,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
    unchanged,
    exitCode: refused.length > 0 ? 1 : 0,
  };
}

export function renderRepointText(result: RepointResult): string {
  const lines: string[] = [];
  const verb = result.written ? "re-pointed" : "would re-point";
  for (const r of result.rewrites) {
    lines.push(
      `${verb} ${r.doc}: \`${r.citation}\` ${describeLines(r.fromStartLine, r.fromEndLine)} -> ${describeLines(r.toStartLine, r.toEndLine)}`,
    );
  }
  for (const r of result.refused) {
    lines.push(`MANUAL ${r.doc}: \`${r.citation}\`: ${r.reason}`);
  }
  const skippedCount = result.skipped.reduce((n, s) => n + s.count, 0);
  lines.push(
    `${result.rewrites.length} ${result.written ? "re-pointed" : "to re-point (dry run, pass --write to rewrite)"}, ${result.refused.length} need manual handling, ${result.unchanged} unchanged, ${skippedCount} skipped (base ${result.base})`,
  );
  return lines.join("\n") + "\n";
}

export function renderRepointJson(result: RepointResult): string {
  return (
    JSON.stringify(
      {
        bundleDir: result.bundleDir,
        base: result.base,
        written: result.written,
        rewrites: result.rewrites,
        refused: result.refused,
        skipped: result.skipped,
        unchanged: result.unchanged,
      },
      null,
      2,
    ) + "\n"
  );
}
