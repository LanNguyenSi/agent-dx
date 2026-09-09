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
 * Characters that cannot continue a path component in a scanned
 * command string, so a path that ends right before one of them is
 * finished: whitespace, either quote, and the shell separators that
 * can follow a path without a space (`;`, `&`, `|`, `)`, `,`).
 * `\u0000` is in the set for the scratch-root blanking in
 * `escapingRootMentions` below, which overwrites a stripped mention
 * with a NUL run of the same length rather than deleting it (so every
 * index still lines up with the original text).
 */
const PATH_REGION_TERMINATORS = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  '"',
  "'",
  ";",
  "&",
  "|",
  ")",
  ",",
  "\u0000",
]);

/**
 * True when the character at `index` ends the path spelled just before
 * it: the end of the text, a `/` (the same directory, named with a
 * deeper component after it), or a character that cannot continue a
 * path component at all. A spelling NOT followed by one of these is
 * the prefix of a DIFFERENT path that merely starts with the same
 * characters -- a sibling `<root>2`, or `<root>-backup` -- and naming
 * one of those is not an escape into `root`.
 */
function isPathBoundaryAt(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  return ch === "/" || PATH_REGION_TERMINATORS.has(ch);
}

/**
 * The end index of the path that starts before `start` and continues
 * from it: everything up to the first terminator, treating a
 * backslash and the character after it as one escaped unit (so the
 * `\ ` inside a space-escaped path does not read as the end of the
 * path). Used to report the ACTUAL region matched (the root spelling
 * plus the path text that follows it, e.g. `<root>/pkg`) instead of
 * only the bare root, which reads as if the command had named the
 * root itself.
 */
function pathRegionEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (PATH_REGION_TERMINATORS.has(ch)) break;
    i++;
  }
  return i;
}

/**
 * `s` with every character that has a single-character lowercase form
 * replaced by it, and every other character kept as it is. Unlike a
 * plain `toLowerCase()` this is LENGTH-PRESERVING (a few code points,
 * e.g. `U+0130`, lowercase into two characters), which every index in
 * the scan below depends on: the match is found in the folded text and
 * then sliced out of the ORIGINAL text, so the caller sees the
 * spelling the command actually used.
 */
function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** `s` with the case of every letter flipped, used to probe the
 * filesystem below; characters with no other case are kept. */
function swapCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (ch !== upper && upper.length === ch.length) out += upper;
    else if (ch !== lower && lower.length === ch.length) out += lower;
    else out += ch;
  }
  return out;
}

const caseInsensitiveByDir = new Map<string, boolean>();

/**
 * True when `dir` can be reached through a differently-cased spelling
 * of its own path, measured rather than assumed: `dir` is stat'ed
 * again under the case-flipped spelling of its whole absolute path and
 * the two are compared by device and inode. macOS's default APFS
 * volume and Windows answer true here; a case-sensitive volume answers
 * false because the flipped spelling does not resolve at all (ENOENT),
 * and so does a path with no letter to flip and any other stat error
 * -- false meaning "match exactly", the conservative answer, which
 * never reports a mention the exact rule would not report anyway.
 * Memoized per resolved directory: the answer is a property of the
 * volume `dir` sits on, and the scan below asks once per channel.
 */
export function isCaseInsensitiveFilesystem(dir: string): boolean {
  const key = path.resolve(dir);
  const cached = caseInsensitiveByDir.get(key);
  if (cached !== undefined) return cached;
  let insensitive = false;
  try {
    const swapped = swapCase(key);
    if (swapped !== key) {
      const own = fs.statSync(key);
      const other = fs.statSync(swapped);
      insensitive = own.dev === other.dev && own.ino === other.ino;
    }
  } catch {
    insensitive = false;
  }
  caseInsensitiveByDir.set(key, insensitive);
  return insensitive;
}

/**
 * Whether `scratchRoot`'s spellings may be stripped from the scanned
 * text before `root` is looked for: only when the scratch root is a
 * PROPER descendant of the root, compared on both sides' realpaths the
 * way every other consumer of `isPathContained` compares.
 *
 * `isPathContained` alone is not the test, because it also answers
 * true for the root ITSELF (`path.relative` returns `""`): a
 * `--log-dir` pointed AT the repository root (or above it, which
 * `isPathContained` does reject) would then blank every mention of the
 * root out of the text and pass a command that escapes as plainly as
 * `cd '<root>/pkg' && node t.js` (round 3's own defect, reproduced 3/3
 * by that round's review). The exemption exists for the isolation copy
 * at `<log-dir>/wt-<uuid>/wt`; with `--log-dir` AT the root the
 * exemption would have to swallow the root itself, so it is not
 * granted at all and such a mention is refused, with the same two
 * remedies the message already names.
 */
function stripsScratchRoot(root: string, scratchRoot: string): boolean {
  const realRoot = resolveDeepestExisting(path.resolve(root));
  const realScratch = resolveDeepestExisting(path.resolve(scratchRoot));
  return realScratch !== realRoot && isPathContained(realRoot, realScratch);
}

/**
 * Every mention of `root` in `text`: each region of `text` that starts
 * with one of `root`'s spellings (see `pathSpellings`), ends at a path
 * boundary, and does not resolve under `scratchRoot` instead. The
 * returned strings are the matched REGIONS as the text spells them
 * (the root spelling plus any deeper path text after it, e.g.
 * `<root>/pkg`), deduplicated, empty when `root` is not mentioned at
 * all.
 *
 * Three things narrow the plain substring test:
 *
 * - a match must be followed by a path boundary (`isPathBoundaryAt`),
 *   so a sibling `<root>2` is NOT a mention of `root`;
 * - on a case-insensitive filesystem (measured, see
 *   `isCaseInsensitiveFilesystem`; `caseInsensitive` overrides the
 *   measurement, for tests) both sides are case-folded, so a miscased
 *   but literal spelling that the filesystem resolves to the same
 *   directory is matched too; on a case-sensitive filesystem the match
 *   stays exact, since a miscased spelling there names a different
 *   path;
 * - every occurrence of `scratchRoot`'s own spellings is blanked out
 *   of the scanned text first, but ONLY when the scratch root is a
 *   proper descendant of `root` (`stripsScratchRoot`) and only where
 *   the occurrence itself ends at a path boundary -- so a `--log-dir`
 *   pointed inside the repository (the one case an absolute path under
 *   `root` legitimately names the isolation copy itself, at
 *   `<scratchRoot>/wt-<uuid>/wt`) does not read as an escape, while
 *   `<scratchRoot>rc/x.js`, an unrelated path that merely starts with
 *   those characters, is left in the text and still reported.
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
 * drops along with the tokenizer it belonged to); a path the shell
 * expands into the root only at run time, `~` expansion included
 * (`cd ~/git/repo && ...` never spells the root out); and a repository
 * root containing a character neither spelling represents (e.g. a
 * literal quote inside the path).
 */
export function escapingRootMentions(
  text: string,
  root: string,
  scratchRoot?: string,
  caseInsensitive?: boolean,
): string[] {
  const folds =
    caseInsensitive ?? isCaseInsensitiveFilesystem(path.resolve(root));
  const fold = (s: string): string => (folds ? foldCase(s) : s);

  // The scan runs over the FOLDED text and every index is used to slice
  // the original `text`, which only works because `foldCase` and the
  // blanking below both preserve length exactly.
  let scanned = fold(text);
  if (scratchRoot !== undefined && stripsScratchRoot(root, scratchRoot)) {
    for (const spelling of pathSpellings(scratchRoot)) {
      const needle = fold(spelling);
      if (needle.length === 0) continue;
      let from = 0;
      while (true) {
        const at = scanned.indexOf(needle, from);
        if (at === -1) break;
        const end = at + needle.length;
        if (isPathBoundaryAt(scanned, end)) {
          scanned =
            scanned.slice(0, at) +
            "\u0000".repeat(needle.length) +
            scanned.slice(end);
        }
        from = end;
      }
    }
  }

  const regions: string[] = [];
  const seen = new Set<string>();
  for (const spelling of pathSpellings(root)) {
    const needle = fold(spelling);
    if (needle.length === 0) continue;
    let from = 0;
    while (true) {
      const at = scanned.indexOf(needle, from);
      if (at === -1) break;
      const end = at + needle.length;
      from = end;
      if (!isPathBoundaryAt(scanned, end)) continue;
      const region = text.slice(at, pathRegionEnd(text, end));
      if (seen.has(region)) continue;
      seen.add(region);
      regions.push(region);
    }
  }
  return regions;
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
 * The remedy text of the `test_command_escapes_isolation` refusal
 * message for the two COMMAND channels (`-t` and `--pre`), appended
 * after the offending channel(s) and matched region(s): the two fixes
 * (a relative invocation, or `--isolation inplace`) and the
 * runner-binary clause naming `--link`. Exported so its own
 * load-bearing fragments (`--isolation inplace`, `--link`) can be
 * pinned directly, rather than only indirectly through a probe
 * scenario that happens to trigger this message.
 */
export const ISOLATION_ESCAPE_FIX_HINT =
  "Run the command as a relative command from the package directory " +
  "(a relative invocation resolved inside the copy), or pass " +
  "--isolation inplace. An absolute path to a runner binary under the " +
  "root is refused for the same reason; name it relatively, or pass " +
  "its directory to --link so the copy carries it too.";

/**
 * The remedy text for an `--env NAME=VALUE` match, which the command
 * hint above does not fit: an env VALUE is not a command, so "run the
 * command as a relative command" names nothing the caller can do to
 * it, and `--link` is about a runner binary the value need not be.
 * A legitimate directory under the repository root (a cache or output
 * directory, `--env CACHE_DIR=<root>/.cache`) is refused by the same
 * rule, since the tool cannot tell it apart from a path that pulls the
 * run back into the real tree; both share the same two remedies, so
 * they are named here rather than left to the reader.
 */
export const ISOLATION_ESCAPE_ENV_FIX_HINT =
  "Pass the value as a path relative to the package directory (both " +
  "--pre and the test command run with the isolation copy's package " +
  "directory as their cwd, so a relative value resolves inside the " +
  "copy), or pass --isolation inplace. A cache or output directory " +
  "under the root (--env CACHE_DIR=<root>/.cache) is refused by the " +
  "same rule and takes the same two fixes.";
