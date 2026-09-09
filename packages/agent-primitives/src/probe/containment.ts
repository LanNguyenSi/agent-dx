import fs from "node:fs";
import path from "node:path";

/**
 * Walks up from `startDir` looking for a `.git` entry (directory or
 * file, the latter for a linked worktree) and returns that directory;
 * `undefined` when none is found before the filesystem root. Mirrors
 * doctor's own `isInsideGitWorkTree` walk, but returns the root path
 * instead of a boolean, since containment needs the root itself.
 */
export function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === root) return undefined;
    dir = path.dirname(dir);
  }
}

/** The containment root for a probe run from `cwd`: the git work-tree
 * root when `cwd` is inside one, else `cwd` itself. */
export function containmentRoot(cwd: string): string {
  return findGitRoot(cwd) ?? path.resolve(cwd);
}

/** True when `absTarget` resolves to `root` itself or a path underneath
 * it. Both inputs must already be absolute, resolved paths. */
export function isPathContained(root: string, absTarget: string): boolean {
  const rel = path.relative(root, absTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves `p` to its realpath. When `p` itself does not exist yet (a
 * missing `--file`, or a marker naming a target that has since been
 * deleted), resolves as much of the path as does exist (walking up to the
 * deepest existing ancestor) and re-appends the missing tail verbatim,
 * instead of returning `p` unresolved: a symlinked ancestor (macOS's
 * `/tmp` -> `/private/tmp`, or any symlinked checkout path) would
 * otherwise make `isPathContained` compare a resolved root against an
 * unresolved file path, so the same file reads as inside the root under
 * one spelling and outside it under another. Falls back to `p` itself
 * only when nothing above it resolves either (the filesystem root, or a
 * whole ancestor chain that does not exist).
 *
 * Both consumers of `isPathContained` must pass paths through this
 * function on both sides, or the comparison is spelling-dependent again:
 * `probe`'s containment and lock/marker key, and `doctor`'s stale-marker
 * check.
 */
export function resolveDeepestExisting(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p; // filesystem root
    return path.join(resolveDeepestExisting(parent), path.basename(p));
  }
}

/**
 * Every spelling of `p` the isolation-escape scan (`escapingRootMentions`
 * below) recognizes as "the same path": `p` itself resolved
 * (`path.resolve`), its realpath (`resolveDeepestExisting`, in case `p`
 * is itself reached through a symlink or has a symlinked ancestor -- the
 * two can differ), and for each of those the variant with every space
 * backslash-escaped (`\ `), the shell's own way of embedding a space in
 * an unquoted token. A quoted spelling (`'/abs/my repo'`, `"/abs/my
 * repo"`) needs no entry of its own: quoting wraps a substring, it does
 * not change it, so the plain (unescaped) spelling with a real space
 * still occurs inside a quoted run built from it.
 */
function pathSpellings(p: string): string[] {
  const resolved = path.resolve(p);
  const real = resolveDeepestExisting(resolved);
  const spellings = new Set<string>();
  for (const spelling of [resolved, real]) {
    spellings.add(spelling);
    spellings.add(spelling.replace(/ /g, "\\ "));
  }
  return [...spellings];
}

/**
 * Every spelling of `root` (see `pathSpellings`) that occurs in `text`
 * as a literal substring, after first removing every occurrence of
 * `scratchRoot`'s own spellings from `text` (when `scratchRoot` is
 * given) -- so a `--log-dir` pointed inside the repository (the one
 * case an absolute path under `root` legitimately names the isolation
 * copy itself, at `<scratchRoot>/wt-<uuid>/wt`) does not read as an
 * escape. Returns every root spelling that matched (usually one; more
 * than one only when `text` happens to spell the path two different
 * ways), empty when `root` does not occur in `text` at all.
 *
 * `setup.ts` refuses `-i worktree`'s test command, `--pre`, and the
 * VALUE half of every `--env NAME=VALUE` against this: a SUBSTRING
 * rule rather than a token/shell parse. Rounds 1 and 2 of task
 * 5bf16459 were both tokenizers, and each round's reviewer found a
 * fresh quoting/escaping/wrapper shape the tokenizer had not
 * enumerated -- a quoted absolute path containing whitespace, a
 * `--key=/abs` form, `--pre` never scanned at all, then
 * `sh -c "cd /abs && ..."` read as one opaque quoted token and a
 * backslash-escaped space splitting a single path into two
 * non-existent fragments. An absolute path under `root` contains
 * `root` as a substring under EVERY quoting, escaping, `=`-form or
 * wrapper that can surround it, so this rule needs no shape
 * enumeration to be exhaustive for a literal absolute path -- unlike a
 * path outside `root`, which never contains it, so nothing outside the
 * root is ever flagged.
 *
 * Known residuals (see README): a path reached only through a shell
 * variable this tool does not own (`cd "$REPO" && ...`) or a command
 * substitution (`$(...)`); a RELATIVE path that walks out of the
 * isolation copy via `..`; a wrapper script that itself `cd`s using a
 * path not spelled out in the scanned string; a path reaching `root`
 * only through a symlink alias that is neither `root`'s own as-given
 * spelling nor its realpath (only those two, and their space-escaped
 * variants, are recognized here -- a third, unrelated symlink pointing
 * at the same target is invisible to a substring scan, unlike round
 * 1/2's per-token realpath resolution, which this rule deliberately
 * drops along with the tokenizer it belonged to); and a repository
 * root containing a character neither spelling represents (e.g. a
 * literal quote inside the path).
 */
export function escapingRootMentions(
  text: string,
  root: string,
  scratchRoot?: string,
): string[] {
  let scanned = text;
  if (scratchRoot !== undefined) {
    for (const spelling of pathSpellings(scratchRoot)) {
      scanned = scanned.split(spelling).join("");
    }
  }
  return pathSpellings(root).filter((spelling) => scanned.includes(spelling));
}

/**
 * The three channels `setup.ts` scans with `escapingRootMentions`, and
 * the label each one's mention is reported under in the
 * `test_command_escapes_isolation` refusal message. Shared between the
 * message builder and its own pin (`test/probe-refusal-contract.test.ts`)
 * so the two cannot drift apart.
 */
export const ISOLATION_ESCAPE_CHANNEL_LABEL = {
  testCommand: "the test command (-t)",
  pre: "--pre",
  env: (name: string): string => `--env ${name}`,
} as const;

/**
 * The fixed remedy text of the `test_command_escapes_isolation` refusal
 * message, appended after the offending channel(s) and matched
 * spelling(s): the two fixes (a relative invocation, or
 * `--isolation inplace`) and the runner-binary clause naming `--link`.
 * Exported so its own load-bearing fragments (`--isolation inplace`,
 * `--link`) can be pinned directly, rather than only indirectly through
 * a probe scenario that happens to trigger this message.
 */
export const ISOLATION_ESCAPE_FIX_HINT =
  "Run the command as a relative command from the package directory " +
  "(a relative invocation resolved inside the copy), or pass " +
  "--isolation inplace. An absolute path to a runner binary under the " +
  "root is refused for the same reason; name it relatively, or pass " +
  "its directory to --link so the copy carries it too.";
