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
