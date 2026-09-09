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
]);

/**
 * True when the character at `index` ends the path spelled just before
 * it: the end of the text, a `/` (the same directory, named with a
 * deeper component after it), a `\` that escapes such a `/` (every
 * POSIX shell reads `\/` as `/`, so `<root>\/pkg` names `<root>/pkg`),
 * or a character that cannot continue a path component at all. A
 * spelling NOT followed by one of these is the prefix of a DIFFERENT
 * path that merely starts with the same characters -- a sibling
 * `<root>2`, or `<root>-backup` -- and naming one of those is not an
 * escape into `root`.
 *
 * A bare `\` is deliberately NOT a boundary: the escaped space of
 * `<root>\ backup` is part of a sibling's name, not a separator, so
 * treating `\` itself as a boundary would report that sibling as a
 * mention of `root`. Only the `\` of a `\/` pair ends the spelling.
 */
function isPathBoundaryAt(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === "\\" && text[index + 1] === "/") return true;
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
 * `s` with every regular-expression metacharacter escaped, so a
 * spelling matches only itself: a repository root may contain any of
 * them (`/x/re.po`, `/x/a+b`, `/x/pkg (old)`, `/x/[wip]`), and an
 * unescaped `.` would match any character at that position (a sibling
 * `/x/reXpo` reading as a mention of `/x/re.po`), while an unescaped
 * `(` or `[` would not compile at all.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * What one `/` in a spelling matches: a run of one or more separators,
 * each optionally backslash-escaped, with any number of `.` ("this
 * directory") segments among them, so `<root>//pkg`, `<root>/./pkg`
 * and `<parent>\/<base>/pkg`, which all reach the same directory as
 * `<root>/pkg`, are matched as mentions of it. The `\` is optional
 * because a shell reads `\/` as `/`, so an escaped separator INSIDE
 * the root prefix spells the root just as the bare one does. A `..`
 * segment is deliberately not in here: it names a DIFFERENT directory,
 * so accepting one would mean normalising the path rather than
 * matching its spelling (named as a residual on
 * `escapingRootMentions`).
 *
 * Matching this against a long run of separators that never completes
 * a spelling backtracks, so the scan's worst case is quadratic in the
 * length of the scanned text; the text is this run's own operator-
 * supplied `-t`/`--pre`/`--env` string, not attacker input, so no
 * length cap is imposed on it.
 */
const PATH_SEPARATOR_PATTERN = "(?:\\\\?/)+(?:\\.(?:\\\\?/)+)*";

/**
 * A matcher for one spelling: every character matched literally
 * (`escapeRegExp`) except the separators, which tolerate the noise
 * above. Global, so `matchedRegions` can walk every occurrence, and
 * case-insensitive when the root's filesystem resolves a miscased
 * spelling to the same directory -- which lets the scan run over the
 * ORIGINAL text, so every index it reports is an index into the
 * spelling the command actually used.
 */
function spellingMatcher(spelling: string, caseInsensitive: boolean): RegExp {
  const source = spelling
    .split("/")
    .map(escapeRegExp)
    .join(PATH_SEPARATOR_PATTERN);
  return new RegExp(source, caseInsensitive ? "gi" : "g");
}

/** One occurrence of a spelling in the scanned text. */
interface SpellingMatch {
  start: number;
  end: number;
}

/**
 * Every occurrence of any of `spellings` in `text` that ends at a path
 * boundary, spelling by spelling and, within one spelling, left to
 * right. Each spelling is an absolute path, so its matcher always
 * consumes at least the leading separator and the walk always
 * advances.
 */
function matchedRegions(
  text: string,
  spellings: string[],
  caseInsensitive: boolean,
): SpellingMatch[] {
  const found: SpellingMatch[] = [];
  for (const spelling of spellings) {
    if (spelling.length === 0) continue;
    const matcher = spellingMatcher(spelling, caseInsensitive);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const end = match.index + match[0].length;
      if (isPathBoundaryAt(text, end)) found.push({ start: match.index, end });
    }
  }
  return found;
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
 * Whether mentions of `scratchRoot` may be exempted from the scan for
 * `root`: only when the scratch root is a PROPER descendant of the
 * root, compared on both sides' realpaths the way every other consumer
 * of `isPathContained` compares.
 *
 * `isPathContained` alone is not the test, because it also answers
 * true for the root ITSELF (`path.relative` returns `""`): a
 * `--log-dir` pointed AT the repository root (or above it, which
 * `isPathContained` does reject) would then exempt every mention of
 * the root and pass a command that escapes as plainly as
 * `cd '<root>/pkg' && node t.js`. The exemption exists for the
 * isolation copy at `<log-dir>/wt-<uuid>/wt`; with `--log-dir` AT the
 * root the exemption would have to swallow the root itself, so it is
 * not granted at all and such a mention is refused, with the same two
 * remedies the message already names.
 */
function exemptsScratchRoot(root: string, scratchRoot: string): boolean {
  const realRoot = resolveDeepestExisting(path.resolve(root));
  const realScratch = resolveDeepestExisting(path.resolve(scratchRoot));
  return realScratch !== realRoot && isPathContained(realRoot, realScratch);
}

/**
 * Every mention of `root` in `text`: each region of `text` that spells
 * `root` literally (see `pathSpellings` for the spellings recognized
 * and `spellingMatcher` for the separator noise tolerated inside one),
 * ends at a path boundary, and does not sit inside a mention of
 * `scratchRoot`. The returned strings are the matched REGIONS as the
 * text spells them (the root spelling plus any deeper path text after
 * it, e.g. `<root>/pkg`), deduplicated, empty when `root` is not
 * mentioned at all.
 *
 * `setup.ts` refuses `-i worktree`'s test command, `--pre`, and the
 * VALUE half of every `--env NAME=VALUE` against this. The rule reads
 * the raw text instead of tokenising it or parsing a shell command: an
 * absolute path under `root` spells `root` out whatever quoting,
 * escaping, `=`-form or wrapper surrounds it, and a path outside
 * `root` never spells it, so nothing outside the root is flagged.
 * Four things shape the match itself:
 *
 * - separator noise inside a spelling is tolerated, so `<root>//pkg`,
 *   `<root>/./pkg` and `<parent>\/<base>/pkg` are mentions of `root`
 *   (`spellingMatcher`);
 * - a match must be followed by a path boundary (`isPathBoundaryAt`),
 *   which an escaped separator is (`<root>\/pkg`) and a bare
 *   backslash is not, so a sibling `<root>2` or `<root>\ backup` is
 *   NOT a mention of `root`;
 * - on a case-insensitive filesystem (measured, see
 *   `isCaseInsensitiveFilesystem`; `caseInsensitive` overrides the
 *   measurement, for tests) the match ignores case, so a miscased but
 *   literal spelling that the filesystem resolves to the same
 *   directory is matched too; on a case-sensitive filesystem the match
 *   stays exact, since a miscased spelling there names a different
 *   path;
 * - a match that starts inside a mention of `scratchRoot` is skipped,
 *   but ONLY when the scratch root is a proper descendant of `root`
 *   (`exemptsScratchRoot`) and only where that scratch mention itself
 *   ends at a path boundary -- so a `--log-dir` pointed inside the
 *   repository (the one case an absolute path under `root`
 *   legitimately names the isolation copy itself, at
 *   `<scratchRoot>/wt-<uuid>/wt`) does not read as an escape, while
 *   `<scratchRoot>rc/x.js`, an unrelated path that merely starts with
 *   those characters, is still reported.
 *
 * The scope is a LITERALLY SPELLED root path, not "every way a command
 * can reach the real tree". Quoting and backslash escaping AROUND a
 * spelling, `=`-forms, wrappers, separator noise and, where the
 * filesystem folds case, casing are covered; anything that reaches the
 * root without spelling it out that way is a residual. The residuals
 * KNOWN TODAY, which is not a claim that they are all of them (the
 * README's `-i worktree` section carries the same list for callers):
 * a path built at run time from a shell variable this tool does not
 * own (`cd "$REPO" && ...`), a command substitution (`$(...)`), or `~`
 * expansion; a RELATIVE path that walks out of the isolation copy via
 * `..`; an absolute path that walks back INTO the root through `..`
 * (`/abs/x/../my repo`), which this scan does not normalise; a
 * spelling broken up from the INSIDE by quoting or backslash escaping
 * (`/x/re"p"o`, `/x/re\po`), which the shell rejoins into the root but
 * the scanned text never carries as one run of characters; a spelling
 * that differs only in unicode normalisation (a decomposed spelling of
 * a composed root, which a filesystem may resolve to the same
 * directory); a wrapper script that itself `cd`s using a path not
 * spelled out in the scanned string; a path reaching `root` only
 * through a symlink alias that is neither `root`'s own as-given
 * spelling nor its realpath; and a repository root containing a
 * character neither spelling represents (e.g. a literal quote inside
 * the path).
 */
export function escapingRootMentions(
  text: string,
  root: string,
  scratchRoot?: string,
  caseInsensitive?: boolean,
): string[] {
  const ignoresCase =
    caseInsensitive ?? isCaseInsensitiveFilesystem(path.resolve(root));

  // The scratch root is matched with the SAME construction as the root
  // and its matches are SKIPPED rather than removed from the text: the
  // scan runs over the original `text` throughout, so every index below
  // indexes the spelling the command actually used.
  const exempt =
    scratchRoot !== undefined && exemptsScratchRoot(root, scratchRoot)
      ? matchedRegions(text, pathSpellings(scratchRoot), ignoresCase)
      : [];

  const regions: string[] = [];
  const seen = new Set<string>();
  for (const match of matchedRegions(text, pathSpellings(root), ignoresCase)) {
    if (exempt.some((e) => match.start >= e.start && match.start < e.end)) {
      continue;
    }
    const region = text.slice(match.start, pathRegionEnd(text, match.end));
    if (seen.has(region)) continue;
    seen.add(region);
    regions.push(region);
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
