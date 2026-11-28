import { IntakeError } from "./errors.js";

/** The timeout of every git call of intake when neither flag nor environment sets one. */
export const DEFAULT_GIT_TIMEOUT_SECONDS = 15;
/** The environment variable that sets the git timeout, in seconds. */
export const GIT_TIMEOUT_ENV = "SPEC_GATE_GIT_TIMEOUT";
export const MIN_GIT_TIMEOUT_SECONDS = 1;
export const MAX_GIT_TIMEOUT_SECONDS = 3600;

function parseSeconds(raw: string, source: string): number {
  const seconds = /^(?:0|[1-9][0-9]{0,3})$/.test(raw)
    ? Number(raw)
    : Number.NaN;
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_GIT_TIMEOUT_SECONDS ||
    seconds > MAX_GIT_TIMEOUT_SECONDS
  ) {
    throw new IntakeError(
      "bad-git-timeout",
      `${source} must be a whole number of seconds from ${MIN_GIT_TIMEOUT_SECONDS} to ${MAX_GIT_TIMEOUT_SECONDS}, written in plain decimal digits`,
    );
  }
  return seconds;
}

/**
 * The timeout of every git call of one run, in milliseconds. The flag wins
 * over the environment variable, which wins over the default; a source that
 * is set but empty or out of range is refused (the value is not echoed), and
 * the environment is not read at all when the flag is given.
 */
export function resolveGitTimeoutMs(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (flag !== undefined) return parseSeconds(flag, "--git-timeout") * 1000;
  const fromEnv = env[GIT_TIMEOUT_ENV];
  if (fromEnv !== undefined) {
    return parseSeconds(fromEnv, GIT_TIMEOUT_ENV) * 1000;
  }
  return DEFAULT_GIT_TIMEOUT_SECONDS * 1000;
}
