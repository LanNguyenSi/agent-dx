/**
 * The path rules of `spec-gate export --format ow`, documented in
 * `docs/export.md`. They establish one property of every briefing: no
 * entry of `allowed_changes_hint` is covered by an entry of
 * `forbidden_changes`. Inputs the rules cannot judge are refused with a
 * named error; nothing is guessed and nothing is rewritten.
 *
 * One spelling per path. Both sides are read with the same predicate
 * (`isCanonicalRepoPath`): a Non-goal `paths` entry that is not canonical
 * is `nongoal-path-not-canonical`, a binding `file` or `fixtures` entry
 * that is not canonical is `binding-path-not-canonical`. An entry that may
 * name a directory (a Non-goal entry, a `fixtures` entry) may end in one
 * `/`, which is dropped before anything is compared.
 *
 * One glob syntax. A Non-goal entry is a pattern of `*` and `**` and
 * nothing else: `?`, `[`, `]`, `{` and `}` are `nongoal-glob-unsupported`.
 * A binding entry names one path and is never a pattern: `*` or `?` in it
 * is `binding-path-glob`.
 *
 * One coverage function (`covers`). A forbidden entry covers a candidate
 * when it matches the candidate or one of the candidate's ancestor
 * directories. A literal entry matches the path it spells, so it covers
 * that path and everything below it; a glob that matches a directory
 * covers everything below that directory in the same way.
 */
import { parseYamlText } from "../formats/index.js";
import { ExportError } from "./errors.js";

/** Glob syntax a Non-goal entry may not use: export implements `*` and `**` only. */
const UNSUPPORTED_GLOB_CHARS = /[?[\]{}]/;

/** Glob syntax a binding path may not hold: a binding names one path. */
const BINDING_GLOB_CHARS = /[*?]/;

/**
 * True when `p` is in canonical repo-relative form: `/` separated segments,
 * none of them empty (so no `//`, no leading and no trailing `/`), `.` or
 * `..`, and no backslash. POSIX normalisation leaves such a path unchanged.
 */
export function isCanonicalRepoPath(p: string): boolean {
  if (p.includes("\\")) return false;
  return p
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The canonical path of an entry that may name a directory: exactly one
 * trailing `/` is dropped, and what remains must be canonical. `null` when
 * it is not.
 */
export function canonicalDirEntry(entry: string): string | null {
  const body = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return isCanonicalRepoPath(body) ? body : null;
}

/** True when `p` is canonical and holds no glob character a binding may not hold. */
export function isLiteralRepoPath(p: string): boolean {
  return isCanonicalRepoPath(p) && !BINDING_GLOB_CHARS.test(p);
}

/**
 * `literal` reads its character, `star` any run without `/`, `globstar`
 * any run. `gate` reads nothing: it is the one point in front of a
 * `globstar` that the match passes before the run starts, which is where
 * a skip over the run may leave from.
 */
export type Token =
  | { kind: "literal"; char: string }
  | { kind: "star" }
  | { kind: "globstar" }
  | { kind: "gate" };

/**
 * A compiled pattern: `tokens` in order, and `skips[i]` the states that
 * are reachable from state `i` without reading a character. State `i` is
 * "the first `i` tokens are matched"; every skip leads forward.
 */
export interface Compiled {
  tokens: Token[];
  skips: number[][];
}

/**
 * Compiles a canonical pattern. `*` is any run of characters without `/`
 * and `**` any run of characters, both possibly empty; every other
 * character stands for itself. A segment that is exactly `**` may also
 * stand for no segment at all, so that the pattern covers what every
 * common reading of it covers: `a/` + `**` + `/b` matches `a/b`, a
 * leading `**` + `/b` matches `b`, and `a/` + `**` matches `a`.
 */
function compile(pattern: string): Compiled {
  const segments = pattern
    .split("/")
    .filter((segment, i, all) => !(segment === "**" && all[i - 1] === "**"));
  const tokens: Token[] = [];
  const skips: number[][] = [];
  const skip = (from: number, to: number): void => {
    (skips[from] ??= []).push(to);
  };
  const slash = (): void => {
    tokens.push({ kind: "literal", char: "/" });
  };
  let separatorWritten = true;
  segments.forEach((segment, i) => {
    const first = i === 0;
    const last = i === segments.length - 1;
    if (segment === "**" && !(first && last)) {
      if (last) {
        // `a/**`: the separator and everything after it may be absent.
        const from = tokens.length;
        slash();
        tokens.push({ kind: "globstar" });
        skip(from, tokens.length);
        return;
      }
      // `**/b` and `a/**/b`: the directories and their closing separator
      // may be absent, both or neither. The skip leaves from the gate and
      // not from the run, so a run that has read something still needs
      // its separator.
      if (!first) slash();
      const from = tokens.length;
      tokens.push({ kind: "gate" });
      tokens.push({ kind: "globstar" });
      slash();
      skip(from, tokens.length);
      separatorWritten = true;
      return;
    }
    if (!separatorWritten) slash();
    separatorWritten = false;
    const chars = Array.from(segment);
    for (let c = 0; c < chars.length; c++) {
      if (chars[c] !== "*") {
        tokens.push({ kind: "literal", char: chars[c]! });
      } else if (chars[c + 1] === "*") {
        tokens.push({ kind: "globstar" });
        c++;
      } else {
        tokens.push({ kind: "star" });
      }
    }
  });
  return { tokens, skips };
}

/** Adds every state reachable from an active state without reading a character. */
function close(active: boolean[], compiled: Compiled): void {
  for (let i = 0; i < compiled.tokens.length; i++) {
    if (!active[i]) continue;
    if (compiled.tokens[i]!.kind !== "literal") active[i + 1] = true;
    for (const to of compiled.skips[i] ?? []) active[to] = true;
  }
}

/**
 * True when the compiled pattern matches the whole of `text`. The states
 * are advanced together, one character at a time, so the work is bounded
 * by pattern length times text length whatever the pattern looks like.
 */
function matches(compiled: Compiled, text: string): boolean {
  const end = compiled.tokens.length;
  let active: boolean[] = new Array<boolean>(end + 1).fill(false);
  active[0] = true;
  close(active, compiled);
  for (const char of Array.from(text)) {
    const next: boolean[] = new Array<boolean>(end + 1).fill(false);
    for (let i = 0; i < end; i++) {
      if (!active[i]) continue;
      const token = compiled.tokens[i]!;
      if (token.kind === "literal") {
        if (token.char === char) next[i + 1] = true;
      } else if (token.kind === "globstar") {
        next[i] = true;
      } else if (token.kind === "star") {
        if (char !== "/") next[i] = true;
      }
    }
    close(next, compiled);
    active = next;
  }
  return active[end] === true;
}

/** An entry of `forbidden_changes`, ready to be compared with a hint candidate. */
export interface ForbiddenEntry {
  /** The entry as `forbidden_changes` prints it. */
  readonly text: string;
  /** The entry without its trailing `/`, compiled for the comparison. */
  readonly compiled: Compiled;
}

/**
 * The forbidden entry of a canonical pattern, printed as `text`. The
 * caller has made sure `pattern` is canonical.
 */
function forbiddenEntry(text: string, pattern: string): ForbiddenEntry {
  return { text, compiled: compile(pattern) };
}

/**
 * The forbidden entry of one of the spec's own files: a literal path. The
 * caller has made sure the spec directory passes `isLiteralRepoPath`, so
 * the pattern holds no `*`.
 */
export function forbiddenSpecFile(rel: string): ForbiddenEntry {
  return forbiddenEntry(rel, rel);
}

/**
 * The forbidden entry of a Non-goal `paths` entry, or the refusal that
 * names why export cannot judge it. The entry is printed as written; one
 * trailing `/` is dropped for the comparison.
 */
export function forbiddenNonGoalPath(
  ngId: string,
  entry: string,
): ForbiddenEntry {
  const pattern = canonicalDirEntry(entry);
  if (pattern === null) {
    throw new ExportError(
      "nongoal-path-not-canonical",
      `${ngId}: paths entry ${JSON.stringify(entry)} is not a canonical repo-relative path: no './', '.' or '..' segment, no '//', no leading '/', at most one trailing '/', no backslash`,
    );
  }
  if (UNSUPPORTED_GLOB_CHARS.test(pattern)) {
    throw new ExportError(
      "nongoal-glob-unsupported",
      `${ngId}: paths entry ${JSON.stringify(entry)} holds '?', '[', ']', '{' or '}': export reads '*' and '**' as globs and nothing else, and does not guess what the entry covers`,
    );
  }
  return forbiddenEntry(entry, pattern);
}

/**
 * True when the forbidden entry covers the canonical candidate path: it
 * matches the candidate or one of its ancestor directories.
 */
export function covers(forbidden: ForbiddenEntry, candidate: string): boolean {
  const segments = candidate.split("/");
  for (let depth = 1; depth <= segments.length; depth++) {
    const path = segments.slice(0, depth).join("/");
    if (matches(forbidden.compiled, path)) return true;
  }
  return false;
}

/**
 * True when a hint candidate must be dropped: a forbidden entry covers it.
 * A candidate may end in one `/` (a directory), dropped for the comparison.
 */
export function isDroppedHintPath(
  candidate: string,
  forbidden: readonly ForbiddenEntry[],
): boolean {
  const path = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
  return forbidden.some((entry) => covers(entry, path));
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkBindingPath(
  tpId: string,
  field: string,
  value: string,
  mayBeDirectory: boolean,
): void {
  const strict = isCanonicalRepoPath(value) ? value : null;
  const path = mayBeDirectory ? canonicalDirEntry(value) : strict;
  if (path === null) {
    throw new ExportError(
      "binding-path-not-canonical",
      `binding ${tpId}: ${field} ${JSON.stringify(value)} is not a canonical repo-relative path: no './', '.' or '..' segment, no '//', no leading '/', no backslash, and no trailing '/' (a fixtures entry may end in one)`,
    );
  }
  if (BINDING_GLOB_CHARS.test(path)) {
    throw new ExportError(
      "binding-path-glob",
      `binding ${tpId}: ${field} ${JSON.stringify(value)} holds '*' or '?': a binding names one path, and export does not guess whether a hint entry is a path or a pattern`,
    );
  }
}

/**
 * Refuses a binding whose `file` or `fixtures` entry export cannot judge:
 * not canonical, or holding a glob character. `file` names a file and
 * takes no trailing `/`; a `fixtures` entry may end in one. Values that
 * are not strings are left to the format parser, which names them.
 */
export function assertBindingPaths(
  bindings: Iterable<readonly [string, unknown]>,
): void {
  for (const [tpId, raw] of bindings) {
    if (!isMapping(raw)) continue;
    const file = raw["file"];
    if (typeof file === "string") checkBindingPath(tpId, "file", file, false);
    const fixtures = raw["fixtures"];
    if (!Array.isArray(fixtures)) continue;
    fixtures.forEach((entry, i) => {
      if (typeof entry === "string") {
        checkBindingPath(tpId, `fixtures[${i}]`, entry, true);
      }
    });
  }
}

/**
 * `assertBindingPaths` over the text of a `bindings.yaml`, before the file
 * is validated as a format: the refusal then names the path and not
 * something else the file may also get wrong. Unparsable YAML is left to
 * the format parser.
 */
export function assertCanonicalBindingPaths(text: string): void {
  const decoded = parseYamlText(text);
  if (!decoded.ok || !isMapping(decoded.value)) return;
  assertBindingPaths(Object.entries(decoded.value));
}
