// Filesystem-facing discovery: default project directories and the
// transcript files within them. Kept separate from aggregate.ts (pure
// parsing) so the parsing/aggregation logic can be unit-tested without
// touching disk.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** All `~/.claude/projects/*` directories, one per Claude Code project. */
export function defaultProjectDirs(): string[] {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
    .sort();
}

/**
 * List `*.jsonl` transcript files directly under each of `projectDirs`.
 * When `days` is given, only files whose mtime falls within the last
 * `days` days are included. A project directory that does not exist or
 * cannot be read is skipped, not fatal, so a stale --projectDir argument
 * does not abort the whole run.
 */
export function findTranscriptFiles(
  projectDirs: string[],
  days?: number,
): string[] {
  const cutoffMs =
    days === undefined ? undefined : Date.now() - days * MS_PER_DAY;
  const files: string[] = [];
  for (const dir of projectDirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const full = join(dir, entry.name);
      if (cutoffMs !== undefined) {
        try {
          if (statSync(full).mtimeMs < cutoffMs) continue;
        } catch {
          continue;
        }
      }
      files.push(full);
    }
  }
  return files.sort();
}

export function readTranscriptFile(path: string): string {
  return readFileSync(path, "utf8");
}
