import { createHash } from "node:crypto";
import { join } from "node:path";

import { isContainedRelativePath, readInstalledManifest } from "./init.js";
import {
  AGENTS_MD_HEADING,
  CLAUDE_IMPORT_LINE,
  CLAUDE_MD_BOILERPLATE,
  SECTION_BEGIN,
  SECTION_END,
} from "./writers.js";
import { SymlinkRefusedError, TargetFs } from "./target-fs.js";

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

function removeAgentsSection(
  fs: TargetFs,
  report: UninstallReport,
  path: string,
): void {
  if (!fs.exists(path)) return;
  const existing = fs.readText(path);
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
    fs.removeFile(path);
    report.removed.push(path);
    return;
  }
  fs.writeText(path, `${remaining}\n`);
  report.removed.push(`${path} (workflow section)`);
}

function removeClaudeImport(
  fs: TargetFs,
  report: UninstallReport,
  path: string,
): void {
  if (!fs.exists(path)) return;
  const existing = fs.readText(path);
  if (existing === CLAUDE_MD_BOILERPLATE) {
    fs.removeFile(path);
    report.removed.push(path);
    return;
  }
  const lines = existing.split("\n");
  const without = lines.filter((line) => line.trim() !== CLAUDE_IMPORT_LINE);
  if (without.length === lines.length) return;
  const remaining = without.join("\n").trimEnd();
  if (remaining === "") {
    fs.removeFile(path);
    report.removed.push(path);
    return;
  }
  fs.writeText(path, `${remaining}\n`);
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
  join(".claude", "skills", "orchestrator-workflow", "references"),
  join(".claude", "skills", "orchestrator-workflow"),
  join(".claude", "skills"),
  join(".claude", "agents"),
  ".claude",
  join(".agents", "skills", "orchestrator-workflow", "references"),
  join(".agents", "skills", "orchestrator-workflow"),
  join(".agents", "skills"),
  ".agents",
  join(".codex", "agents"),
  ".codex",
  join(".opencode", "skills", "orchestrator-workflow", "references"),
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
  const fs = new TargetFs(targetDir);
  const manifestPath = join(targetDir, ".ai", "workflow", "manifest.json");

  // Refuse the whole run before the first removal when any path it would
  // touch is, or lies below, a symbolic link; a half-removed install is
  // worse than a refused one. The manifest's own path was checked by
  // `readInstalledManifest` above, and every operation below checks again.
  for (const relativePath of Object.keys(manifest.files)) {
    if (isContainedRelativePath(relativePath)) {
      fs.assertSafe(join(targetDir, relativePath));
    }
  }
  fs.assertSafe(join(targetDir, "AGENTS.md"));
  fs.assertSafe(join(targetDir, "CLAUDE.md"));

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
    const kind = fs.kind(path);
    if (kind === undefined) {
      report.missing.push(path);
      continue;
    }
    if (kind !== "file") {
      report.kept.push(path);
      report.notes.push(`${path}: not a regular file; ignored.`);
      continue;
    }
    const content = fs.readText(path);
    if (force || sha256(content) === recordedHash) {
      fs.removeFile(path);
      report.removed.push(path);
    } else {
      report.kept.push(path);
      report.notes.push(
        `${path}: locally edited since install; re-run with --force to remove.`,
      );
    }
  }

  removeAgentsSection(fs, report, join(targetDir, "AGENTS.md"));
  removeClaudeImport(fs, report, join(targetDir, "CLAUDE.md"));

  if (fs.exists(manifestPath)) {
    fs.removeFile(manifestPath);
    report.removed.push(manifestPath);
  }

  for (const candidate of PRUNE_CANDIDATES) {
    const path = join(targetDir, candidate);
    try {
      fs.removeDir(path);
    } catch (error) {
      if (error instanceof SymlinkRefusedError) {
        // The kit never creates a link, so there is nothing of ours to prune
        // there; leave it alone and say so.
        report.notes.push(
          `${path}: is or lies below a symbolic link; not pruned.`,
        );
      }
      // Otherwise not empty or not present; either way it stays.
    }
  }

  const runsDir = join(targetDir, ".ai", "runs");
  let runsDirExists = false;
  try {
    runsDirExists = fs.exists(runsDir);
  } catch (error) {
    // A linked runs directory was left alone above; nothing more to note.
    if (!(error instanceof SymlinkRefusedError)) throw error;
  }
  if (runsDirExists) {
    report.notes.push(
      `${runsDir}: run history kept; remove manually if no longer needed.`,
    );
  }

  return report;
}
