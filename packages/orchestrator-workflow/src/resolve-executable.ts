import { statSync } from "node:fs";

/**
 * Inputs of {@link resolveExecutable}. All fields are injectable so the
 * resolver can be tested for any platform without touching the file system.
 */
export interface ResolveExecutableOptions {
  /** `process.platform` value; only `"win32"` changes the lookup. */
  platform: string;
  /** Raw `PATH` value (entries separated by `;` on win32). */
  pathEnv: string | undefined;
  /** Raw `PATHEXT` value; only its `.exe` and `.com` entries are used. */
  pathExt?: string | undefined;
  /** Returns true when the absolute path names a regular file. */
  isFile: (path: string) => boolean;
}

/** Extensions `execFileSync` can start without a shell. */
const SPAWNABLE_EXTENSIONS = [".exe", ".com"];

/**
 * A win32 path that does not depend on the current directory or the current
 * drive: `X:\...` (either separator) or `\\server\share\...`. `\foo` (current
 * drive) and `C:foo` (current directory of drive C) are not fully qualified.
 */
export function isFullyQualifiedWin32(entry: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(entry) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(entry)
  );
}

/**
 * The spawnable extensions in `PATHEXT` order. Anything else in `PATHEXT`
 * (`.cmd`, `.bat`, ...) needs a shell and is ignored; an unset `PATHEXT`, or
 * one without `.exe` and `.com`, falls back to `.exe` then `.com`.
 */
function spawnableExtensions(pathExt: string | undefined): string[] {
  const picked: string[] = [];
  for (const raw of (pathExt ?? "").split(";")) {
    const ext = raw.trim().toLowerCase();
    if (SPAWNABLE_EXTENSIONS.includes(ext) && !picked.includes(ext)) {
      picked.push(ext);
    }
  }
  return picked.length > 0 ? picked : SPAWNABLE_EXTENSIONS;
}

/**
 * Resolves the command to hand to `execFileSync` (no shell).
 *
 * - Non-win32: returns `name` unchanged; the operating system's `execvp`
 *   lookup stays in charge.
 * - win32: Windows searches the current directory before `PATH`, and a
 *   relative `PATH` entry resolves against the current directory, so a
 *   repository could plant an executable there. This walks `PATH` itself,
 *   keeps only fully qualified entries (surrounding double quotes stripped,
 *   empty and relative entries skipped), tries the name with `.exe` and
 *   `.com`, and returns the first regular file as an absolute path, or
 *   `undefined` when there is none.
 */
export function resolveExecutable(
  name: string,
  opts: ResolveExecutableOptions,
): string | undefined {
  if (opts.platform !== "win32") return name;

  const extensions = spawnableExtensions(opts.pathExt);
  for (const rawEntry of (opts.pathEnv ?? "").split(";")) {
    let entry = rawEntry.trim();
    if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
      entry = entry.slice(1, -1);
    }
    if (entry.length === 0 || !isFullyQualifiedWin32(entry)) continue;
    const dir = entry.replace(/[\\/]+$/, "");
    for (const ext of extensions) {
      const candidate = `${dir}\\${name}${ext}`;
      if (opts.isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `isFile` backed by the real file system; errors count as "not a file". */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
