/**
 * Process-local git settings for every git command a probe owns. Git may
 * otherwise start background maintenance after a command such as worktree
 * add or apply, leaving a concurrent process to touch the probe's scratch
 * repository while it is being inspected or removed.
 */
export const PROBE_GIT_CONFIG_ARGS = [
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
] as const;

/** Prepends the probe-wide git settings to one explicit git argv. */
export function probeGitArgv(args: readonly string[]): string[] {
  return [...PROBE_GIT_CONFIG_ARGS, ...args];
}
