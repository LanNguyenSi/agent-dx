import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Report {
  /** Created from scratch. */
  written: string[];
  /** Existed and was changed (marker replace, import append, --force). */
  updated: string[];
  /** Existed with the expected content; nothing to do. */
  skipped: string[];
  /** Existed with diverging content and was left untouched (no --force). */
  conflicted: string[];
}

export function emptyReport(): Report {
  return { written: [], updated: [], skipped: [], conflicted: [] };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * Installs a kit-owned file. Kit-owned files are only ever overwritten with
 * --force; local edits otherwise win and are reported as conflicts.
 */
export function installFile(
  report: Report,
  path: string,
  content: string,
  options: { force: boolean },
): void {
  if (!existsSync(path)) {
    write(path, content);
    report.written.push(path);
    return;
  }
  const existing = readFileSync(path, "utf8");
  if (existing === content) {
    report.skipped.push(path);
    return;
  }
  if (options.force) {
    write(path, content);
    report.updated.push(path);
    return;
  }
  report.conflicted.push(path);
}

export const SECTION_BEGIN = "<!-- orchestrator-workflow:begin -->";
export const SECTION_END = "<!-- orchestrator-workflow:end -->";

/**
 * Creates AGENTS.md or replaces exactly the marker-fenced workflow section in
 * it. Content outside the markers is never touched. Markers only count when
 * they are a whole line, so prose merely mentioning a marker cannot shift the
 * fence; anything other than exactly one well-ordered pair is a conflict.
 */
export function upsertMarkerSection(
  report: Report,
  path: string,
  section: string,
): void {
  const block = section.trimEnd();
  if (!existsSync(path)) {
    write(path, `# Agent instructions\n\n${block}\n`);
    report.written.push(path);
    return;
  }
  const existing = readFileSync(path, "utf8");
  const lines = existing.split("\n");
  const beginLines: number[] = [];
  const endLines: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === SECTION_BEGIN) beginLines.push(index);
    if (line.trim() === SECTION_END) endLines.push(index);
  });
  if (beginLines.length === 0 && endLines.length === 0) {
    const base = existing.trimEnd();
    write(path, base === "" ? `${block}\n` : `${base}\n\n${block}\n`);
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
  write(path, replaced);
  report.updated.push(path);
}

export const CLAUDE_IMPORT_LINE = "@AGENTS.md";

/**
 * Claude Code reads CLAUDE.md, not AGENTS.md. Ensure CLAUDE.md exists and
 * imports AGENTS.md so the policy section is loaded there too.
 */
export function ensureClaudeImport(report: Report, path: string): void {
  if (!existsSync(path)) {
    write(
      path,
      `# CLAUDE.md\n\nProject agent instructions live in AGENTS.md.\n\n${CLAUDE_IMPORT_LINE}\n`,
    );
    report.written.push(path);
    return;
  }
  const existing = readFileSync(path, "utf8");
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
  write(
    path,
    base === ""
      ? `${CLAUDE_IMPORT_LINE}\n`
      : `${base}\n\n${CLAUDE_IMPORT_LINE}\n`,
  );
  report.updated.push(path);
}
