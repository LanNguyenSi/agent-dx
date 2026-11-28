/**
 * What the command line parser may write to stderr about an option's value.
 *
 * `spec-gate` takes no secret from an option, but a person can still put one
 * there by mistake (`--token=ghp_...`), and the parser's error line quotes
 * the offending argument. `maskOptionValues` is the one place that rewrites
 * those lines, so that an option's name stays visible and its value never
 * reaches the error output. It runs on the text of one error; it never sees
 * help or version output.
 */

/** What stands in for a value that was removed. */
export const REDACTED = "<redacted>";

/**
 * An unknown option that carried its value in the same argument:
 * `error: unknown option '--name=value'`, optionally followed by the
 * parser's `(Did you mean ...?)` line. The value runs up to the last quote
 * in front of that suggestion or the end, so a quote inside it does not end
 * the match early.
 */
const UNKNOWN_OPTION_WITH_VALUE =
  /^(error: unknown option '-[^=\n]*=)[\s\S]*('(?:\n\(Did you mean [^\n]*\))?\n?)$/;

/**
 * A value the parser refused for a known option on the command line
 * (`argument 'v' is invalid`, `--name=v` and `--name v` alike).
 */
const INVALID_OPTION_ARGUMENT =
  /^(error: option '[^'\n]*' argument ')[\s\S]*(' is invalid\.[^\n]*\n?)$/;

/** The same for a value that came from the environment. */
const INVALID_OPTION_ENV_VALUE =
  /^(error: option '[^'\n]*' value ')[\s\S]*(' from env '[^'\n]*' is invalid\.[^\n]*\n?)$/;

/**
 * Returns `text` with the value of every option that the parser quotes in
 * it replaced by `<redacted>`. The option's name, the rest of the line, the
 * suggestion and the allowed choices stay. A bare word before a verb name is
 * reported by the parser as an unknown command and is not touched: masking
 * it would hide every typo, so the token belongs in `GITHUB_TOKEN` only.
 * Text without a quoted option value comes back unchanged.
 */
export function maskOptionValues(text: string): string {
  if (text.startsWith("error: unknown option '")) {
    return text.replace(UNKNOWN_OPTION_WITH_VALUE, `$1${REDACTED}$2`);
  }
  return text
    .replace(INVALID_OPTION_ARGUMENT, `$1${REDACTED}$2`)
    .replace(INVALID_OPTION_ENV_VALUE, `$1${REDACTED}$2`);
}
