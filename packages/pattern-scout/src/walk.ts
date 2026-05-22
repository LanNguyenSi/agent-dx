import fs from "node:fs";
import path from "node:path";

/** Directories never worth scanning for source patterns. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
  ".pytest_cache",
]);

/** Source-text extensions worth scanning for patterns. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".sh",
]);

/** Skip files larger than this (bytes): minified bundles, lockfiles, fixtures. */
const MAX_FILE_BYTES = 512 * 1024;

export interface WalkOptions {
  /** Stop yielding once this many files have been produced. */
  maxFiles?: number;
}

/**
 * Yield absolute paths of scannable text files under `root`, depth-first.
 * Unreadable directories are skipped rather than aborting the walk, so a
 * partially readable cache still produces results.
 */
export function* walkTextFiles(
  root: string,
  options: WalkOptions = {},
): Generator<string> {
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  let count = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let size: number;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      yield full;
      count += 1;
      if (count >= maxFiles) return;
    }
  }
}
