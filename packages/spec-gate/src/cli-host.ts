/**
 * The host construction shared by the two verbs that ask the code host
 * something: `approve-check` and `closure`. Both read the token from the
 * environment variable `GITHUB_TOKEN` and from nowhere else, both build the
 * adapter the same way, and both run their outputs past the same guard, so
 * the rules of one verb cannot drift out of the rules of the other.
 *
 * Nothing here holds or returns the token: a refusal names the input that
 * is wrong and never its value, and the guard withholds an output that
 * would hold the token as a whole.
 */
import type { GitHubHostOptions, HostAdapter } from "./host/index.js";

/** The environment variable the token is read from. */
export const TOKEN_VARIABLE = "GITHUB_TOKEN";

/**
 * The pull request number given to an adapter that is only ever asked about
 * CI runs (closure): `ciRunStatus` never uses it and the verb never calls
 * `pullRequest()`. It is the largest pull request number that stays exact,
 * so a wrong call reads a pull request that does not exist instead of a
 * real one.
 */
export const NO_PULL_REQUEST = Number.MAX_SAFE_INTEGER;

/**
 * The token of the environment, and from nowhere else: there is no option
 * for it, and an empty variable reads as no token.
 */
export function readToken(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env[TOKEN_VARIABLE] ?? "";
}

/** The host flags of a command line, as the verbs hold them. */
export interface HostFlags {
  /** `--github-repo`: `<owner>/<name>`. */
  githubRepo: string;
  /** `--api-url`, absent for the adapter's default root. */
  apiUrl?: string;
  /** `--pr` as a number; absent for a verb that has no pull request. */
  pullRequest?: number;
}

/** The adapter, or the one line that says why it could not be made. */
export type BuiltHost =
  { ok: true; host: HostAdapter } | { ok: false; message: string };

/**
 * Makes the adapter from the flags and the token through `createHost` (the
 * real `createGitHubHost` in production, a fake in tests), and turns a
 * refusal into a message instead of a throw. The adapter names the option
 * that does not fit and never its value.
 */
export function buildHost(
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  createHost: (options: GitHubHostOptions) => HostAdapter,
  flags: HostFlags,
  token: string,
): BuiltHost {
  try {
    return {
      ok: true,
      host: createHost({
        repository: flags.githubRepo,
        pullRequest: flags.pullRequest ?? NO_PULL_REQUEST,
        token,
        ...(flags.apiUrl !== undefined ? { apiUrl: flags.apiUrl } : {}),
      }),
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Whether `text` holds `token`, as it is or as a JSON text holds it. The
 * last check before anything is written or returned: an output that holds
 * the token is withheld as a whole.
 */
export function holdsToken(text: string, token: string): boolean {
  if (token === "") return false;
  const forms = [token, JSON.stringify(token).slice(1, -1)];
  return forms.some((form) => text.includes(form));
}
