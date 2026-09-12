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
 * Where a link SOURCE's own containment is judged: `resolveDeepestExisting(p)`,
 * except when `p` ITSELF is a symlink whose chain does not fully resolve
 * (a dangling target, or one this process cannot stat). `fs.realpathSync`
 * throws for that case with no partial information, so
 * `resolveDeepestExisting`'s own fallback walks up from `p`'s OWN parent
 * -- exactly right for an ordinary missing path, but wrong here: it
 * silently reports `p` itself (still inside the repository, since `p` is
 * one of the three explicit `link` sources, already resolved against
 * their own base) rather than the directory the symlink actually names,
 * which may sit anywhere. Two link sources that both point outside the
 * repository then read differently by nothing but accident: one whose
 * target happens to exist resolves through `fs.realpathSync` to that
 * real, out-of-root path and is caught by the ordinary containment
 * check; one whose target is missing (or unreadable) falls back to `p`'s
 * own in-root spelling and reaches the existence check instead, which
 * then discloses -- via `link_source_not_found` vs. the containment
 * check's own `file_outside_root` -- whether something happens to sit at
 * an arbitrary path outside the repository (GitHub issue #242's
 * containment finding).
 *
 * This resolves the gap by walking the symlink chain itself, one
 * `readlinkSync` hop at a time (each relative target resolved against
 * ITS OWN directory, since a relative target's meaning depends on where
 * the link that carries it sits, not on where the chain started), until
 * a hop is not itself a symlink -- at which point `resolveDeepestExisting`
 * runs on THAT final hop, so the deepest existing ancestor reported is
 * always an ancestor of where the chain actually ends, dangling or not,
 * however many links sit in between. A single hop that merely forwards
 * to another in-root symlink (`oracle` -> `<root>/hop2` -> an outside,
 * missing target) previously lost the outside destination entirely: only
 * the FIRST hop's target (`<root>/hop2`, itself still in-root) was ever
 * run through `resolveDeepestExisting`, whose own fallback then walked up
 * from `hop2`'s in-root parent rather than from the outside target `hop2`
 * itself names, silently reporting an in-root path for a chain that in
 * fact dangles outside the repository -- the same disclosure this
 * function exists to close, just one hop further down (GitHub issue
 * #242, narrowed again). Walking the chain by hand rather than leaning on
 * `fs.realpathSync` for anything past the first hop is what fixes this:
 * every hop's target becomes the NEXT hop's own starting point, so the
 * final `resolveDeepestExisting` call always sees the chain's true end.
 *
 * The walk is capped at 32 hops. A cycle among the hops (`a` -> `b` ->
 * `a`) never terminates on its own, and neither `lstatSync` nor
 * `readlinkSync` -- unlike `fs.realpathSync` or `fs.statSync`, both of
 * which fully resolve a path and so surface the OS's own `ELOOP` for a
 * genuine cycle -- ever traverses far enough to hit that error by
 * itself, since each reads only its OWN argument without following it.
 * Hitting the cap (or an `ELOOP` raised while resolving an ancestor
 * DIRECTORY component of some hop along the way, which `lstatSync` and
 * `readlinkSync` still resolve as normal path lookup) returns `undefined`
 * rather than a best-effort path: the caller must refuse the link
 * without ever running the containment check on a half-resolved chain,
 * since disclosing "contained" vs. "not" for an unresolvable target would
 * itself be a return of the same disclosure this function exists to
 * close (see `firstLinkSourceRefusal` in `index.ts`, which falls back to
 * `linkSourceMissingMessage`'s own errno branch there instead -- the
 * SAME chain, statted whole via `fs.statSync(link.value)`, hits the
 * identical `ELOOP`/cap situation and is reported through that shared,
 * non-disclosing wording rather than through containment).
 *
 * `p` itself when it is not a symlink at all (or cannot be lstat'ed,
 * i.e. does not exist under any spelling): the ordinary resolution
 * already answers correctly there, since there is no separate "target"
 * to lose track of.
 *
 * Deliberately narrow rather than folded into `resolveDeepestExisting`
 * itself: that function has other callers (a `--file` target, a link's
 * eventual on-disk destination inside `link-policy.ts`) whose own
 * fallback behaviour -- reporting the path unresolved when it does not
 * fully exist -- is exactly what they need, and widening it here would
 * change what every one of them sees for a plain missing path, not only
 * for a link source's own containment check.
 */
const MAX_LINK_SOURCE_HOPS = 32;

/** True when `err` is a Node errno exception carrying `ELOOP`: a genuine
 * symlink cycle encountered while the OS resolves an ancestor directory
 * component of the path handed to `lstatSync`/`readlinkSync`. */
function isELOOP(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ELOOP"
  );
}

export function resolveLinkSourceTarget(p: string): string | undefined {
  let current = p;
  for (let hop = 0; hop < MAX_LINK_SOURCE_HOPS; hop++) {
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(current);
    } catch (err) {
      if (isELOOP(err)) return undefined;
      return resolveDeepestExisting(current);
    }
    if (!lst.isSymbolicLink()) return resolveDeepestExisting(current);
    let rawTarget: string;
    try {
      rawTarget = fs.readlinkSync(current);
    } catch (err) {
      if (isELOOP(err)) return undefined;
      return resolveDeepestExisting(current);
    }
    current = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(current), rawTarget);
  }
  // The hop cap was reached without the chain ending: functionally the
  // same as a genuine `ELOOP`, and refused the same non-disclosing way.
  return undefined;
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
 * True when `ch` can continue the NAME of a path component: the POSIX
 * portable filename character set (`A-Z a-z 0-9 . _ -`, the characters
 * a portable filename is guaranteed to carry), plus every non-ASCII
 * character, since those are filename characters too and the shell's
 * word lexing gives none of them any meaning of its own.
 */
function continuesComponentName(ch: string): boolean {
  return /[A-Za-z0-9._-]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

/**
 * The index of the first character after the run of `\`+newline pairs
 * that starts at `index`. `sh` DELETES such a pair (a line
 * continuation) before it lexes the word, so a decision about what
 * follows a spelling is made on what follows the pair, not on the
 * pair itself.
 */
function skipLineContinuations(text: string, index: number): number {
  let i = index;
  while (text[i] === "\\" && text[i + 1] === "\n") i += 2;
  return i;
}

/**
 * True when `ch` starts an ANSI-C (`$'...'`) numeric escape that can
 * decode to a path separator: `x` (`\xHH`), `u`/`U`
 * (`\uHHHH`/`\UHHHHHHHH`) and an octal digit `0`-`7` (`\NNN`, one to
 * three digits) each name a byte or code point by its numeric value,
 * and `/` (0x2f) is reachable through any of them. A named escape like
 * `\n` or `\t` decodes to a fixed character that is never `/`, so it
 * is not included here and stays an in-word escape.
 */
function startsAnsiCNumericEscape(ch: string): boolean {
  return ch === "x" || ch === "u" || ch === "U" || (ch >= "0" && ch <= "7");
}

/**
 * True when a spelling that ends at `index` is a mention of the path
 * it spells. The rule enumerates what CONTINUES a path word, not what
 * terminates one: the match is a mention unless the text continues the
 * path word with a further NAME character there. Provenance: POSIX
 * shell word lexing, because the scanned string is handed to `sh -c`
 * (`exec.ts`) and the shell's own lexing is the contract this scan has
 * to match, plus the POSIX portable filename character set for what a
 * component name may carry.
 *
 * A path word is CONTINUED at `index` by:
 *
 * - a portable filename character (`[A-Za-z0-9._-]`), plus any
 *   non-ASCII character, since those are filename characters too --
 *   the spelling is then the prefix of a DIFFERENT path and NOT a
 *   mention;
 * - `/`, a further component: still a mention, since `<root>/pkg`
 *   names the root;
 * - `\` followed by any character other than `/`, a newline, or an
 *   ANSI-C numeric-escape starter (`x`, `u`, `U`, or an octal digit
 *   `0`-`7`, see below): an escaped character inside the SAME word,
 *   as in the sibling `<root>\ backup`, so NOT a mention;
 * - `\` followed by a newline followed by a continuation: the shell
 *   deletes the `\`+newline pair, so the decision is made on what
 *   follows the pair (`<root>\`+newline+`/pkg` is a mention,
 *   `<root>\`+newline+`-backup` is not).
 *
 * `\` followed by `/` is a SEPARATOR rather than an escaped character
 * inside the word: every POSIX shell reads `\/` as `/`, so
 * `<root>\/pkg` names `<root>/pkg` and is a mention.
 *
 * `\` followed by `x`, `u`, `U`, or an octal digit (`0`-`7`) ALSO ends
 * the word, over-refusing in the safe direction. Provenance: bash/dash
 * `$'...'` (ANSI-C) quoting decodes `\xHH` and `\uHHHH`/`\UHHHHHHHH`
 * (hex) and `\NNN` (one to three octal digits) by numeric value, and
 * `/` (0x2f) is reachable through any of the three (`\x2f`, `/`,
 * `\057`), so `$'<root>\x2fpkg'` reaches `<root>/pkg` exactly as
 * `<root>/pkg` itself does. The scan does not decode the escape --
 * that would mean modelling `$'...'` quoting in full -- so it treats
 * the whole class as a boundary instead: a spelling like
 * `$'<root>\x71pkg'` (`\x71` decodes to `q`, not a separator) is also
 * refused even though the shell reaches a SIBLING there, the same
 * over-refusal trade the rest of this rule already makes. A form this
 * does not model -- a `$'...'` escape that decodes a root CHARACTER
 * rather than the separator, e.g. `$'/x/re\x70o/pkg'`, or a
 * `\c`-style control escape, which cannot decode to a separator
 * either -- is a residual, named on `escapingRootMentions` below.
 *
 * Everything else terminates the word and therefore marks a boundary:
 * the end of the text, whitespace, either quote, every POSIX operator
 * character (`|`, `&`, `;`, `<`, `>`, `(`, `)` and a backtick), `$`,
 * and punctuation such as `,`, `=`, `:`, `#`, `!`, `*`, `?`, `{`, `}`,
 * `[`, `]` and `~`.
 *
 * Enumerating the continuations rather than the terminators is what
 * makes the decision total: a character nobody thought of lands in
 * "terminates the word", so an unforeseen spelling OVER-refuses (a
 * refusal that names itself and carries two remedies) instead of
 * silently reaching the real tree. The same trade costs a sibling
 * named with a character outside the portable set (`<root>~`, the
 * likeliest real hit -- an editor's own backup-directory convention --
 * and `<root>@2`) a false refusal. The scan also reads raw text rather
 * than shell semantics, so a mention sitting in a here-doc body, or
 * anywhere else the root's spelling occurs as DATA rather than as a
 * path the shell would actually resolve, is refused the same way; so
 * is a single-quoted `'<root>\`+newline+`/pkg'`, where the shell does
 * NOT delete the `\`+newline pair (single quotes suspend backslash
 * processing entirely) even though this scan's separator pattern
 * tolerates one there.
 *
 * The `\` rules come from the shell's lexing, and an `--env` VALUE is
 * NOT shell-processed (it reaches the child as an environment entry,
 * and a `\` inside an expanded parameter stays literal), so the same
 * widening over-refuses an env value naming a directory whose own name
 * carries a literal backslash (`<root>\/pkg` as a path, not as a
 * separator) by design; the remedies `ISOLATION_ESCAPE_ENV_FIX_HINT`
 * already names apply to it unchanged.
 *
 * This decision is ROOT-only. It used to also decide the SCRATCH-ROOT
 * spelling that the `--log-dir` exemption in `escapingRootMentions`
 * matches, gated by an `ansiCIsBoundary` parameter that widened only
 * the `\`+ANSI-C sub-rule above for the root and narrowed it for the
 * scratch match. That per-character carve-out closed
 * one shape (an ANSI-C starter right after a `--log-dir` spelling could
 * no longer manufacture an exempt region reaching past it) but left the
 * REST of this function's boundary decision wide for the scratch match
 * too: every character `continuesComponentName` does not recognize --
 * not only the true shell word enders, but also a filename-legal
 * character outside the POSIX-portable set (`@`, `~`, `,`, `=`, `{`,
 * `?`) and `$`, which starts an expansion this scan does not model --
 * still ended the scratch match there. A sibling of the log dir whose
 * name continues the log dir's own spelling with one of those
 * characters (`<root>/l@2/y.js` beside `--log-dir <root>/l`) then read
 * as ending the exemption's match at the same boundary, and the
 * exemption swallowed the sibling, and the root mention underneath it,
 * right along with the log dir itself. The scratch
 * match now has its own function, `isScratchPathBoundaryAt` below,
 * which owns the WHOLE boundary decision instead of sharing this one
 * through a parameter. That function has since been narrowed again,
 * past an enumerated "hard ender" set that still under-refused a
 * quoted sibling (see its own docblock for the current, closed rule).
 */
function isPathBoundaryAt(text: string, index: number): boolean {
  const i = skipLineContinuations(text, index);
  if (i >= text.length) return true;
  const ch = text[i];
  if (ch === "/") return true;
  if (ch === "\\") {
    // A `\`+newline pair is already skipped above, so a `\` here
    // either escapes the `/` of a separator, starts an ANSI-C numeric
    // escape that may decode to one, or escapes a character inside the
    // word. A trailing `\` escapes nothing, so the word ends.
    const next = text[i + 1];
    if (next === undefined || next === "/") return true;
    return startsAnsiCNumericEscape(next);
  }
  return !continuesComponentName(ch);
}

/**
 * The boundary decision for the SCRATCH-ROOT spelling only -- the
 * `--log-dir` value `escapingRootMentions` matches to decide its own
 * exemption -- replacing `isPathBoundaryAt`'s rule rather than sharing
 * it through a parameter (the parameter this function
 * replaces, and the shape closing it fixes, are on `isPathBoundaryAt`'s
 * own docblock). `isPathBoundaryAt`'s WIDE rule is right for the ROOT's
 * own over-refusing match: everything that is not a portable filename
 * character ends the word there, on purpose, so an unforeseen spelling
 * over-refuses instead of silently reaching the real tree. That same
 * width is wrong here, where ending the SCRATCH match validates an
 * EXEMPTION rather than a refusal, and the exemption exists for exactly
 * one shape: the isolation copy at `<log-dir>/wt-<uuid>/wt`, which
 * always continues with a FURTHER path component. The scratch match
 * therefore ends here ONLY at one of four terminators: a `/`; a
 * backslash-escaped `/` (`\/`, the same separator spelling
 * `isPathBoundaryAt` accepts); a backslash-newline pair (deleted by
 * `skipLineContinuations` before this function ever looks at `ch`)
 * followed by one of those two; or the end of the text.
 *
 * This is deliberately NOT a claim about where a shell word
 * terminates. An earlier version of this function accepted the
 * shell's own separator set (space, tab, newline, `|`, `&`, `;`, `<`,
 * `>`, `(`, `)`) on that theory, but every one of those characters is
 * also a legal filename character once quoted: a sibling directory
 * named `<log-dir> 2`, `<log-dir>&2`, `<log-dir>(2` or `<log-dir>;2`
 * reads as a complete shell word inside a double- or single-quoted
 * command (`"<log-dir> 2/y.js"`), so treating any of those characters
 * as ending the scratch match exempted the sibling -- and the root
 * mention underneath it -- right along with the log dir itself: the
 * halt this narrowing closes, `-l <root>/l` beside a test command
 * naming `node "<root>/l 2/y.js"`. No enumerable set of "hard" word
 * enders closes this, because a quote (or a bare, unquoted use of the
 * same character as a literal filename byte) makes every shell
 * separator character a legal filename character somewhere. Accepting
 * only `/`, `\/`, and end of text sidesteps the problem instead of
 * enumerating around it: none of those three spellings is ever itself
 * a filename character, so accepting them can never manufacture an
 * exempt region a sibling name rides through.
 *
 * Every other character rejects the match instead, protecting the
 * exemption with the same over-refusal trade `isPathBoundaryAt` makes
 * for the root's own direct scan: a bare `--log-dir` mention followed
 * by anything other than a further path component -- a space, an
 * operator, a quote (bare or around a continuing sibling name), or any
 * other character -- no longer validates the exemption, so the region
 * underneath it is scanned and reported like any other unexempted
 * mention. In general, a bare log-dir mention followed by ANYTHING
 * other than one of the four terminators above now over-refuses (the
 * general rule this narrowing adopts); the ANSI-C-escape and
 * bare-quoted-mention cases the previous, ender-based rule named as
 * residuals are two instances of this same general over-refusal, not
 * separate cases (README, `escapingRootMentions` below, CHANGELOG).
 */
function isScratchPathBoundaryAt(text: string, index: number): boolean {
  const i = skipLineContinuations(text, index);
  if (i >= text.length) return true;
  const ch = text[i];
  if (ch === "/") return true;
  return ch === "\\" && text[i + 1] === "/";
}

/**
 * The end index of the path word that starts before `start` and
 * continues from it, decided by the same continuation rule as
 * `isPathBoundaryAt`: name characters and `/` extend it, a `\` and the
 * character after it are one unit (a deleted `\`+newline pair, or an
 * escaped character inside the word, so the `\ ` of a space-escaped
 * path does not read as the end), and a trailing `\` escapes nothing
 * and ends it. A `\` followed by an ANSI-C numeric-escape starter
 * (`x`, `u`, `U`, or an octal digit `0`-`7`) is the same kind of
 * truncation as a trailing `\`: the reported region ends before the
 * `\`, not after the decoded byte the scan does not compute. Used to
 * report the ACTUAL region matched (the root spelling plus the path
 * text that follows it, e.g. `<root>/pkg`) instead of only the bare
 * root, which reads as if the command had named the root itself. A
 * component carrying a character outside the portable set truncates
 * the REPORTED region there; what is refused, and the remedies named
 * with it, are unaffected.
 */
function pathRegionEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined || startsAnsiCNumericEscape(next)) break;
      i += 2;
      continue;
    }
    if (ch !== "/" && !continuesComponentName(ch)) break;
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
 * A `\` immediately followed by a newline, zero or more times, as a
 * regex fragment: the shell DELETES such a pair (a line continuation)
 * before it lexes the word, so one may sit anywhere inside a separator
 * run without changing the directory the path reaches. Each repetition
 * is anchored on the `\`, so no two positions in the pattern can claim
 * the same pair.
 */
const LINE_CONTINUATIONS = String.raw`(?:\\\n)*`;

/** One separator plus any line continuations after it: a `/` that may
 * itself be backslash-escaped, since a shell reads `\/` as `/`. */
const SEPARATOR = String.raw`\\?/` + LINE_CONTINUATIONS;

/**
 * What one `/` in a spelling matches: a run of one or more separators,
 * each optionally backslash-escaped and each able to carry line
 * continuations around it, with any number of `.` ("this directory")
 * segments among them, so `<root>//pkg`, `<root>/./pkg`,
 * `<parent>\/<base>/pkg` and `<parent>\`+newline+`/<base>/pkg`, which
 * all reach the same directory as `<root>/pkg`, are matched as
 * mentions of it. A `..` segment is deliberately not in here: it names
 * a DIFFERENT directory, so accepting one would mean normalising the
 * path rather than matching its spelling (named as a residual on
 * `escapingRootMentions`).
 *
 * Matching this against a long run of separators that never completes
 * a spelling backtracks, so the scan's worst case is quadratic in the
 * length of the scanned text; the text is this run's own operator-
 * supplied `-t`/`--pre`/`--env` string, not attacker input, so no
 * length cap is imposed on it.
 */
const PATH_SEPARATOR_PATTERN =
  LINE_CONTINUATIONS +
  `(?:${SEPARATOR})+` +
  `(?:${String.raw`\.`}${LINE_CONTINUATIONS}(?:${SEPARATOR})+)*`;

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
 * advances. `isBoundaryAt` decides what ends a match: `escapingRootMentions`
 * passes `isPathBoundaryAt` for the ROOT spelling (the over-refusing
 * wide rule) and `isScratchPathBoundaryAt` for the SCRATCH-ROOT
 * spelling (the narrow rule that keeps an exempt region from being
 * manufactured past a filename-legal or expansion-starting character,
 * see that function's docblock) -- two whole, independent decisions
 * now rather than one shared rule gated by a flag.
 */
function matchedRegions(
  text: string,
  spellings: string[],
  caseInsensitive: boolean,
  isBoundaryAt: (text: string, index: number) => boolean,
): SpellingMatch[] {
  const found: SpellingMatch[] = [];
  for (const spelling of spellings) {
    if (spelling.length === 0) continue;
    const matcher = spellingMatcher(spelling, caseInsensitive);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const end = match.index + match[0].length;
      if (isBoundaryAt(text, end)) {
        found.push({ start: match.index, end });
      }
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
 * Five things shape the match itself:
 *
 * - the match needs a boundary only at its END, not at its START: a
 *   longer path that merely CONTAINS the root's spelling somewhere
 *   inside it (a bind mount or backup mirror at `/mnt/backup<root>/pkg`
 *   or `/mnt/host<root>/...`) is refused too, and the reported region
 *   begins at the root's own spelling, not at the start of the longer
 *   path;
 * - separator noise inside a spelling is tolerated, so `<root>//pkg`,
 *   `<root>/./pkg`, `<parent>\/<base>/pkg` and
 *   `<parent>\`+newline+`/<base>/pkg` are mentions of `root`
 *   (`spellingMatcher`);
 * - a match is a mention unless the text CONTINUES the path word with
 *   a further name character there (`isPathBoundaryAt`, which
 *   enumerates the continuations rather than the terminators): a
 *   further component (`<root>/pkg`, `<root>\/pkg`,
 *   `<root>\`+newline+`/pkg`) keeps it a mention, while a sibling
 *   whose name merely starts with the root (`<root>2`,
 *   `<root>-backup`, `<root>\ backup`, `<root>\`+newline+`-backup`)
 *   is NOT a mention of `root`;
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
 * The scope is a root path spelled out LITERALLY, IN A FORM THE SCAN
 * MODELS, not "every way a command can reach the real tree". Quoting
 * and backslash escaping AROUND a spelling, `=`-forms, wrappers,
 * separator noise, an ANSI-C (`$'...'`) escape that decodes to a
 * separator AT OR AFTER the end of the root's own spelling
 * (`isPathBoundaryAt`) and, where the filesystem folds case, casing
 * are covered; anything that reaches the root without spelling it out
 * in a form this scan models is a residual. The residuals KNOWN
 * TODAY, which is not a claim that they are all of them (the README's
 * `-i worktree` section carries the same list for callers): a path
 * built at run time from a shell variable this tool does not own
 * (`cd "$REPO" && ...`), a command substitution whose own text does
 * not spell the root out (`$(git rev-parse --show-toplevel)`,
 * `$(cat .repo-path)`) -- a substitution that DOES spell it, backticks
 * included, is refused like any other literal spelling, since the
 * backtick that closes it terminates the path word -- or `~`
 * expansion; a RELATIVE path that walks out of the isolation copy via
 * `..`; an absolute path that walks back INTO the root through `..`
 * (`/abs/x/../my repo`), which this scan does not normalise; a
 * spelling broken up from the INSIDE by quoting or backslash escaping
 * (`/x/re"p"o`, `/x/re\po`), or by an ANSI-C escape that decodes a
 * SEPARATOR sitting INSIDE the root's own spelling rather than at its
 * end (`$'<parent>\x2f<base>/pkg'`, where `<parent>/<base>` is the
 * root: the boundary rule only ever widens at the end of an
 * already-matched spelling, not while a match is still forming); for
 * the scratch-root EXEMPTION only, a general over-refusal
 * `isScratchPathBoundaryAt` names on its own docblock: a bare
 * `--log-dir` mention followed by anything other than the four
 * accepted terminators (`/`, `\/`, a backslash-newline pair followed
 * by one of those, or the end of the text) no longer validates the
 * scratch match as complete, so the exemption is refused rather than
 * granted, even where the shell would in fact still reach the
 * isolation copy. Practical shapes this covers: a `--log-dir` mention
 * immediately followed by a shell operator with legitimate isolation
 * traffic after it (`cd <log-dir> && node t.js`); any line ending
 * directly after the mention (LF or CRLF); a mention
 * immediately followed by a comment marker (`<log-dir>#note`); and a
 * mention used as an unquoted `PATH` segment (`PATH=<log-dir>:/usr/bin`,
 * where `:` is not a terminator either). Each of these reaches the
 * real isolation copy exactly as the shell would run it, but is
 * refused anyway, the same over-refusal trade this scan makes
 * everywhere else, applied here to protect the exemption; a spelling
 * broken up by an ANSI-C escape that decodes a root
 * CHARACTER rather than a separator (`$'/x/re\x70o/pkg'`, where
 * `\x70` decodes to `p`), or by a `\c`-style control escape, which
 * cannot decode to a separator either -- the shell reassembles each
 * of these into the root, but the scan does not model what the shell
 * decodes there; a spelling that differs only in unicode
 * normalisation (a decomposed spelling of a composed root, which a
 * filesystem may resolve to the same directory); a wrapper script
 * that itself `cd`s using a path not spelled out in the scanned
 * string; a path reaching `root` only through a symlink alias that is
 * neither `root`'s own as-given spelling nor its realpath; and a
 * repository root containing a character neither spelling represents
 * (e.g. a literal quote inside the path).
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
  // indexes the spelling the command actually used. It is matched with
  // its OWN boundary rule (`isScratchPathBoundaryAt`), narrower than the
  // root's wide one throughout, not only at the ANSI-C sub-rule: a
  // character the root's own rule would treat as ending the word but
  // that a filename may still legally carry, or that starts a shell
  // expansion this scan does not model, must not manufacture an exempt
  // region there either (see that function's docblock for the
  // regression this closes).
  const exempt =
    scratchRoot !== undefined && exemptsScratchRoot(root, scratchRoot)
      ? matchedRegions(
          text,
          pathSpellings(scratchRoot),
          ignoresCase,
          isScratchPathBoundaryAt,
        )
      : [];

  const regions: string[] = [];
  const seen = new Set<string>();
  for (const match of matchedRegions(
    text,
    pathSpellings(root),
    ignoresCase,
    isPathBoundaryAt,
  )) {
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
