import type { TargetFs } from "./target-fs.js";

export interface Report {
  /** Created from scratch. */
  written: string[];
  /** Existed and was changed (marker replace, import append, --force). */
  updated: string[];
  /** Existed with the expected content; nothing to do. */
  skipped: string[];
  /** Existed with diverging content and was left untouched (no --force). */
  conflicted: string[];
  /** Human-readable notes (profile-downgrade leftovers, ...). */
  notes: string[];
}

export function emptyReport(): Report {
  return { written: [], updated: [], skipped: [], conflicted: [], notes: [] };
}

/**
 * Installs a kit-owned file. Kit-owned files are only ever overwritten with
 * --force; local edits otherwise win and are reported as conflicts. Every
 * access goes through `fs`, which refuses symbolic links in the target.
 */
export function installFile(
  fs: TargetFs,
  report: Report,
  path: string,
  content: string,
  options: { force: boolean },
): void {
  if (!fs.exists(path)) {
    fs.writeText(path, content);
    report.written.push(path);
    return;
  }
  const existing = fs.readText(path);
  if (existing === content) {
    report.skipped.push(path);
    return;
  }
  if (options.force) {
    fs.writeText(path, content);
    report.updated.push(path);
    return;
  }
  report.conflicted.push(path);
}

export const SECTION_BEGIN = "<!-- orchestrator-workflow:begin -->";
export const SECTION_END = "<!-- orchestrator-workflow:end -->";

/** Heading used when init creates AGENTS.md itself. */
export const AGENTS_MD_HEADING = "# Agent instructions";

/**
 * Creates AGENTS.md or replaces exactly the marker-fenced workflow section in
 * it. Content outside the markers is never touched. Markers only count when
 * they are a whole line, so prose merely mentioning a marker cannot shift the
 * fence; anything other than exactly one well-ordered pair is a conflict.
 */
export function upsertMarkerSection(
  fs: TargetFs,
  report: Report,
  path: string,
  section: string,
): void {
  const block = section.trimEnd();
  if (!fs.exists(path)) {
    fs.writeText(path, `${AGENTS_MD_HEADING}\n\n${block}\n`);
    report.written.push(path);
    return;
  }
  const existing = fs.readText(path);
  const lines = existing.split("\n");
  const beginLines: number[] = [];
  const endLines: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === SECTION_BEGIN) beginLines.push(index);
    if (line.trim() === SECTION_END) endLines.push(index);
  });
  if (beginLines.length === 0 && endLines.length === 0) {
    const base = existing.trimEnd();
    fs.writeText(path, base === "" ? `${block}\n` : `${base}\n\n${block}\n`);
    report.updated.push(path);
    return;
  }
  if (
    beginLines.length !== 1 ||
    endLines.length !== 1 ||
    endLines[0] < beginLines[0]
  ) {
    // A broken or duplicated fence is local damage we must not guess about.
    report.conflicted.push(path);
    return;
  }
  const replaced = [
    ...lines.slice(0, beginLines[0]),
    ...block.split("\n"),
    ...lines.slice(endLines[0] + 1),
  ].join("\n");
  if (replaced === existing) {
    report.skipped.push(path);
    return;
  }
  fs.writeText(path, replaced);
  report.updated.push(path);
}

export const CLAUDE_IMPORT_LINE = "@AGENTS.md";

/** The exact CLAUDE.md that init creates from scratch; uninstall relies on
 * recognizing this byte-identically before removing the whole file. */
export const CLAUDE_MD_BOILERPLATE = `# CLAUDE.md\n\nProject agent instructions live in AGENTS.md.\n\n${CLAUDE_IMPORT_LINE}\n`;

/**
 * Claude Code reads CLAUDE.md, not AGENTS.md. Ensure CLAUDE.md exists and
 * imports AGENTS.md so the policy section is loaded there too.
 */
export function ensureClaudeImport(
  fs: TargetFs,
  report: Report,
  path: string,
): void {
  if (!fs.exists(path)) {
    fs.writeText(path, CLAUDE_MD_BOILERPLATE);
    report.written.push(path);
    return;
  }
  const existing = fs.readText(path);
  // Claude Code resolves @-imports anywhere in the file, so an inline
  // mention like "see @AGENTS.md" already imports it.
  const hasImport = existing
    .split("\n")
    .some((line) => line.split(/\s+/).includes(CLAUDE_IMPORT_LINE));
  if (hasImport) {
    report.skipped.push(path);
    return;
  }
  const base = existing.trimEnd();
  fs.writeText(
    path,
    base === ""
      ? `${CLAUDE_IMPORT_LINE}\n`
      : `${base}\n\n${CLAUDE_IMPORT_LINE}\n`,
  );
  report.updated.push(path);
}
