/**
 * The ambient `GIT_*_PATHSPECS` switches change how git reads every
 * pathspec it is handed (glob, no-glob, case-insensitive, literal). A git
 * child that passes its own pathspecs must not inherit them: they conflict
 * with an explicit `--literal-pathspecs` (git exits non-zero), and they make
 * a `:(literal)` or glob pathspec match something other than what the caller
 * wrote, so a listing or a grep can come back empty and read as "nothing
 * there".
 */
export const PATHSPEC_ENV_VARS = [
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
] as const;

/** A copy of the process environment without the four pathspec switches;
 * every other variable is kept as is. */
export function withoutPathspecEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PATHSPEC_ENV_VARS) delete env[name];
  return env;
}

/**
 * Ambient variables that choose WHICH repository, work tree, index or
 * object store a git child operates on. A command that runs git with an
 * explicit `-C <dir>` must not inherit them: `GIT_DIR` or `GIT_WORK_TREE`
 * from the calling environment (a git hook, a wrapper script) would make
 * the child act on a different repository than the one named, and for a
 * command that adds and removes worktrees that is a write to the wrong
 * place.
 */
export const REPO_SELECTION_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

/**
 * The environment for a git child that is pointed at one repository by
 * `-C`: the process environment without the pathspec switches and without
 * the repository-selection variables, and with terminal prompts disabled
 * so a credential request fails instead of waiting on a terminal nobody
 * is watching. Other `GIT_*` variables (notably `GIT_CONFIG_*`) are kept.
 */
export function withoutRepoSelectionEnv(): NodeJS.ProcessEnv {
  const env = withoutPathspecEnv();
  for (const name of REPO_SELECTION_ENV_VARS) delete env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
