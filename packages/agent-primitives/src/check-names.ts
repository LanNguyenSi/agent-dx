/** The name vocabulary shared by `verify`'s own check resolution and the
 * `.agent-primitives.json` `verify.checks` preset loader in
 * `src/probe/defaults-file.ts`. Lives beside `src/pass-regex.ts` (the
 * other seam `verify` and `probe` both read) rather than under
 * `src/verify/`, because the loader is a `probe` module: importing the
 * pattern from `src/verify/index.ts` would make `verify` and the loader a
 * real import cycle (the loader is what `verify` reads the preset with). */

/** A check name reaches `npm run <name> --silent` (and a log file name)
 * unquoted; this is the conservative allowlist every resolved name (plain
 * `-c` names, the derived names of implicit `-x` checks, `-x` keys, and a
 * `verify.checks` preset key or script name alike) must match before any
 * command is built. An `-x` key outside it is a usage error; a `-c` item
 * outside it is not a name at all and becomes an implicit `-x` under a
 * derived name (it executes as a shell command). A preset key or script
 * name outside it is a refused defaults file: nothing runs.
 *
 * The allowlist is what refuses every shell metacharacter a preset value
 * could smuggle (a space, `;`, `&`, `|`, `$`, a backtick), so a preset can
 * only ever name an npm script, never carry a command. */
export const CHECK_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** The first character of a preset's script name: a letter or a digit.
 * `CHECK_NAME_PATTERN` alone allows a leading `-` (hyphen is a name
 * character), and `npm run -x` would read `-x` as an npm flag
 * (`--workspaces`, `--if-present`), silently changing what every script
 * in the run means; a script name therefore has to start where a flag
 * cannot. */
export const PRESET_SCRIPT_FIRST_CHAR = /^[A-Za-z0-9]/;

/** A key of the JSON object a preset's `checks` (or `order`) names: a run
 * list built from `Object.keys` of such an object is only in the file's own
 * order while no key looks like an array index, since JavaScript moves
 * integer-like keys to the front in ascending numeric order. A preset that
 * means to run them in file order refuses such a key instead of silently
 * reordering the run. */
export const INTEGRAL_KEY_PATTERN = /^\d+$/;
