import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * A `git` stand-in for the tests that pin how the package behaves on a
 * git whose `worktree list` differs from the one the host has: every
 * call is handed to the real git, except the `worktree list` shapes each
 * mode names. Written as a POSIX `sh` script, so it runs the same under
 * dash as under bash, and placed at the front of `PATH` by
 * `withPathPrepended`, which is how every git spawn in this package
 * (the `runArgv` seam and doctor's own synchronous spawn) resolves the
 * binary.
 */

/** The real git on the ambient PATH, by absolute path: what every shim
 * written here delegates to. */
export function realGitPath(): string {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "git");
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("git-shim helper: git not found on PATH");
}

export type GitShimMode =
  /** A `worktree list` call carrying `-z` fails the way a git older
   * than 2.36 fails it: exit status 129 and the unknown-switch text on
   * stderr. Every other call, `worktree list --porcelain` without `-z`
   * included, reaches the real git. */
  | "reject-z"
  /** Every `worktree list` call fails (exit status 128), whatever its
   * options: a registry that cannot be read in any form. Every other
   * call reaches the real git. */
  | "no-worktree-list";

/** Writes the executable `git` script for `mode` into `binDir` and
 * returns its path. */
export function writeGitShim(binDir: string, mode: GitShimMode): string {
  const real = realGitPath();
  const inList =
    mode === "reject-z"
      ? [
          '    if [ "$a" = "-z" ]; then',
          "      printf '%s\\n' \"error: unknown switch \\`z'\" >&2",
          "      printf '%s\\n' 'usage: git worktree list [--porcelain]' >&2",
          "      exit 129",
          "    fi",
        ]
      : [];
  const onList =
    mode === "no-worktree-list"
      ? [
          "    printf '%s\\n' 'fatal: shimmed: git worktree list is unavailable' >&2",
          "    exit 128",
        ]
      : [];
  const script = [
    "#!/bin/sh",
    "# Test shim; see test/helpers/git-shim.ts.",
    "seen_worktree=0",
    "seen_list=0",
    'for a in "$@"; do',
    '  if [ "$seen_list" = 1 ]; then',
    ...inList,
    "    :",
    '  elif [ "$seen_worktree" = 1 ] && [ "$a" = "list" ]; then',
    "    seen_list=1",
    ...onList,
    '  elif [ "$a" = "worktree" ]; then',
    "    seen_worktree=1",
    "  fi",
    "done",
    `exec "${real}" "$@"`,
    "",
  ].join("\n");
  const shimPath = path.join(binDir, "git");
  fs.writeFileSync(shimPath, script);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

/** Runs `fn` with `binDir` at the front of `process.env.PATH`, restoring
 * PATH afterwards whatever `fn` did. */
export async function withPathPrepended<T>(
  binDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${saved ?? ""}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}
