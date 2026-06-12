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
 * it. Content outside the markers is never touched.
 */
export function upsertMarkerSection(
  report: Report,
  path: string,
  section: string,
): void {
  const block = section.trimEnd();
  if (!existsSync(path)) {
    write(path, `# AGENTS.md\n\n${block}\n`);
    report.written.push(path);
    return;
  }
  const existing = readFileSync(path, "utf8");
  const beginAt = existing.indexOf(SECTION_BEGIN);
  const endAt = existing.indexOf(SECTION_END);
  if (beginAt !== -1 && endAt !== -1 && endAt > beginAt) {
    const replaced =
      existing.slice(0, beginAt) +
      block +
      existing.slice(endAt + SECTION_END.length);
    if (replaced === existing) {
      report.skipped.push(path);
      return;
    }
    write(path, replaced);
    report.updated.push(path);
    return;
  }
  if (beginAt !== -1 || endAt !== -1) {
    // Half a fence is local damage we must not guess about.
    report.conflicted.push(path);
    return;
  }
  write(path, `${existing.trimEnd()}\n\n${block}\n`);
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
  const hasImport = existing
    .split("\n")
    .some((line) => line.trim() === CLAUDE_IMPORT_LINE);
  if (hasImport) {
    report.skipped.push(path);
    return;
  }
  write(path, `${existing.trimEnd()}\n\n${CLAUDE_IMPORT_LINE}\n`);
  report.updated.push(path);
}
