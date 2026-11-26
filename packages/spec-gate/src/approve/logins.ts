/**
 * How two logins are compared. Host logins are case-insensitive, and a
 * comparison can be wrong in two directions, so there are two of them:
 *
 * - `allowlisted` answers "is this reviewer one of the approvers" and is
 *   narrow: only the ASCII letters fold. A login that merely looks like an
 *   approver (another script, a compatibility form) is not that approver.
 * - `sameAccount` answers "is this the author, or an agent identity" and is
 *   wide: Unicode compatibility forms and full case folding are ignored, and
 *   so is the `[bot]` suffix a host puts on an app's login. An account that
 *   might be the excluded one is excluded.
 *
 * Both err towards "not approved".
 */

/** A login a host may report: no whitespace, control or format character. */
const LOGIN_RE = /^[^\s\p{C}]{1,255}$/u;

export function isLogin(value: unknown): value is string {
  return typeof value === "string" && LOGIN_RE.test(value);
}

function asciiFold(login: string): string {
  return login.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The key reviews are grouped by: one account, whatever its spelling. */
export function accountKey(login: string): string {
  return login.normalize("NFKC").toUpperCase().toLowerCase();
}

const BOT_SUFFIX = "[bot]";

function wideKey(login: string): string {
  const key = accountKey(login);
  return key.endsWith(BOT_SUFFIX) ? key.slice(0, -BOT_SUFFIX.length) : key;
}

/** Whether `login` is in `approvers`: equal but for the case of ASCII letters. */
export function allowlisted(
  login: string,
  approvers: readonly string[],
): boolean {
  const key = asciiFold(login);
  return approvers.some((approver) => asciiFold(approver) === key);
}

/** Whether two logins may name one account (see the file comment). */
export function sameAccount(a: string, b: string): boolean {
  return wideKey(a) === wideKey(b);
}
