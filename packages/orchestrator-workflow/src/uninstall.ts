import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isContainedRelativePath, readInstalledManifest } from "./init.js";
import {
  AGENTS_MD_HEADING,
  CLAUDE_IMPORT_LINE,
  CLAUDE_MD_BOILERPLATE,
  SECTION_BEGIN,
  SECTION_END,
} from "./writers.js";

export interface UninstallReport {
  /** Kit files removed (hash matched the install record, or --force). */
  removed: string[];
  /** Files left in place: locally edited kit files, damaged fences. */
  kept: string[];
  /** Ledger entries whose file was already gone. */
  missing: string[];
  /** Human-readable notes (run history kept, fence state, ...). */
  notes: string[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function removeAgentsSection(report: UninstallReport, path: string): void {
  if (!existsSync(path)) return;
  const existing = readFileSync(path, "utf8");
  const lines = existing.split("\n");
  const beginLines: number[] = [];
  const endLines: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === SECTION_BEGIN) beginLines.push(index);
    if (line.trim() === SECTION_END) endLines.push(index);
  });
  if (beginLines.length === 0 && endLines.length === 0) return;
  if (
    beginLines.length !== 1 ||
    endLines.length !== 1 ||
    endLines[0] < beginLines[0]
  ) {
    report.kept.push(path);
    report.notes.push(
      `${path}: marker fence is broken or duplicated; section left in place.`,
    );
    return;
  }
  const remaining = [
    ...lines.slice(0, beginLines[0]),
    ...lines.slice(endLines[0] + 1),
  ]
    .join("\n")
    .trim();
  if (remaining === "" || remaining === AGENTS_MD_HEADING) {
    // Nothing but what init itself created remains; remove the file.
    unlinkSync(path);
    report.removed.push(path);
    return;
  }
  writeFileSync(path, `${remaining}\n`, "utf8");
  report.removed.push(`${path} (workflow section)`);
}

function removeClaudeImport(report: UninstallReport, path: string): void {
  if (!existsSync(path)) return;
  const existing = readFileSync(path, "utf8");
  if (existing === CLAUDE_MD_BOILERPLATE) {
    unlinkSync(path);
    report.removed.push(path);
    return;
  }
  const lines = existing.split("\n");
  const without = lines.filter((line) => line.trim() !== CLAUDE_IMPORT_LINE);
  if (without.length === lines.length) return;
  const remaining = without.join("\n").trimEnd();
  if (remaining === "") {
    unlinkSync(path);
    report.removed.push(path);
    return;
  }
  writeFileSync(path, `${remaining}\n`, "utf8");
  report.removed.push(`${path} (@AGENTS.md import line)`);
}

/**
 * Directories init may have created, deepest first. Each is removed only
 * when empty, so directories shared with user content always survive.
 */
const PRUNE_CANDIDATES = [
  join(".ai", "workflow", "templates"),
  join(".ai", "workflow"),
  join(".ai", "runs"),
  ".ai",
  join(".claude", "skills", "orchestrator-workflow"),
  join(".claude", "skills"),
  join(".claude", "agents"),
  ".claude",
  join(".agents", "skills", "orchestrator-workflow"),
  join(".agents", "skills"),
  ".agents",
  join(".opencode", "skills", "orchestrator-workflow"),
  join(".opencode", "skills"),
  join(".opencode", "agents"),
  ".opencode",
];

export function runUninstall(options: {
  targetDir: string;
  force?: boolean;
}): UninstallReport {
  const { targetDir } = options;
  const force = options.force ?? false;
  const manifest = readInstalledManifest(targetDir);
  if (!manifest) {
    throw new Error(
      `No orchestrator-workflow install found in ${targetDir} (missing or unreadable .ai/workflow/manifest.json)`,
    );
  }
  const report: UninstallReport = {
    removed: [],
    kept: [],
    missing: [],
    notes: [],
  };

  for (const [relativePath, recordedHash] of Object.entries(manifest.files)) {
    // Defense in depth: readInstalledManifest already drops escaping keys,
    // but never unlink a path that is absolute, escapes the target, or is a
    // directory rather than a kit file.
    if (!isContainedRelativePath(relativePath)) {
      report.kept.push(relativePath);
      report.notes.push(
        `${relativePath}: manifest path is outside the target; ignored.`,
      );
      continue;
    }
    const path = join(targetDir, relativePath);
    if (!existsSync(path)) {
      report.missing.push(path);
      continue;
    }
    if (!statSync(path).isFile()) {
      report.kept.push(path);
      report.notes.push(`${path}: not a regular file; ignored.`);
      continue;
    }
    const content = readFileSync(path, "utf8");
    if (force || sha256(content) === recordedHash) {
      unlinkSync(path);
      report.removed.push(path);
    } else {
      report.kept.push(path);
      report.notes.push(
        `${path}: locally edited since install; re-run with --force to remove.`,
      );
    }
  }

  removeAgentsSection(report, join(targetDir, "AGENTS.md"));
  removeClaudeImport(report, join(targetDir, "CLAUDE.md"));

  const manifestPath = join(targetDir, ".ai", "workflow", "manifest.json");
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
    report.removed.push(manifestPath);
  }

  for (const candidate of PRUNE_CANDIDATES) {
    const path = join(targetDir, candidate);
    try {
      rmdirSync(path);
    } catch {
      // Not empty or not present; either way it stays.
    }
  }

  const runsDir = join(targetDir, ".ai", "runs");
  if (existsSync(runsDir)) {
    report.notes.push(
      `${runsDir}: run history kept; remove manually if no longer needed.`,
    );
  }

  return report;
}
