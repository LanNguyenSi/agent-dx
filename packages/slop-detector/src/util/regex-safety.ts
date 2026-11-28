// Load-time structural checks for the regular expressions and globs a config
// hands to the packs.
//
// The engine and every rule are synchronous, so a pattern that backtracks
// without bound stalls the whole scan (CLI, MCP server and action alike), and
// a config can be loaded from a file inside the scanned tree. There is no
// regex-engine dependency to lean on, so this module reads the pattern source
// itself and refuses the shapes that make a backtracking engine blow up:
//
//   - a repeated group whose body already contains an unbounded repeat
//     (nested quantifiers: `(a+)+`, `(.*)*`, `(\w+\s?)+`, `((ab)+)+`),
//   - backreferences (`\1`, `\k<name>`),
//   - patterns longer than `MAX_REGEX_LENGTH` characters.
//
// It is a structural check, not a proof. Residual shapes it does not detect:
// overlapping alternation under one repeat (`(a|a)*`, `(a|ab)*`), a bounded
// range under an unbounded repeat (`(a{1,5})+`), and adjacent overlapping
// repeats (`a*a*a*b`, polynomial rather than exponential). See
// `docs/configuration.md`.

/** Longest accepted regex source, in characters. */
export const MAX_REGEX_LENGTH = 512;

/**
 * A `{n,m}` upper bound above this counts as unbounded for the nesting rule
 * (both for the repeated group and for the repeat inside it). `{n,}` is
 * always unbounded.
 */
export const MAX_BOUNDED_REPEAT = 16;

/** Most `**` segments one config glob may carry. */
export const MAX_GLOB_DOUBLE_STARS = 8;

export type RegexSafetyProblem =
  | { kind: "too-long" }
  | { kind: "backreference" }
  | { kind: "nested-quantifier" };

interface Frame {
  /** True once any large repeat was seen anywhere inside this group. */
  hasLarge: boolean;
}

interface Atom {
  isGroup: boolean;
  /** For a group: a large repeat occurs somewhere inside its body. */
  hasLarge: boolean;
}

const BRACE_QUANTIFIER = /\{(\d+)(?:(,)(\d*))?\}/y;

function isLargeMax(max: number): boolean {
  return max > MAX_BOUNDED_REPEAT;
}

/**
 * Reads the quantifier that starts at `src[i]`, if there is one. `{` that does
 * not form a valid `{n}`, `{n,}` or `{n,m}` is a literal in the non-unicode
 * grammar the packs compile with, so it is not a quantifier here either.
 * Returns the highest repeat count (`Infinity` when unbounded) and the index
 * after the quantifier.
 */
function readQuantifier(
  src: string,
  i: number,
): { max: number; next: number } | null {
  const c = src[i];
  let max: number;
  let end: number;
  if (c === "*" || c === "+") {
    max = Infinity;
    end = i + 1;
  } else if (c === "?") {
    max = 1;
    end = i + 1;
  } else if (c === "{") {
    BRACE_QUANTIFIER.lastIndex = i;
    const m = BRACE_QUANTIFIER.exec(src);
    if (!m) return null;
    if (m[2] === undefined) max = Number(m[1]);
    else if (m[3] === "") max = Infinity;
    else max = Number(m[3]);
    end = i + m[0].length;
  } else {
    return null;
  }
  // A lazy `?` after the quantifier is read on the next step as a repeat of
  // at most one, which never counts as large.
  return { max, next: end };
}

/**
 * Structural verdict on a regex source that already compiles. `null` means
 * none of the refused shapes was found.
 */
export function findRegexSafetyProblem(
  pattern: string,
): RegexSafetyProblem | null {
  if (pattern.length > MAX_REGEX_LENGTH) return { kind: "too-long" };

  const stack: Frame[] = [{ hasLarge: false }];
  let last: Atom | null = null;
  let nested = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      const n = pattern[i + 1];
      if ((n >= "1" && n <= "9") || (n === "k" && pattern[i + 2] === "<")) {
        return { kind: "backreference" };
      }
      i += 2;
      last = { isGroup: false, hasLarge: false };
    } else if (c === "[") {
      // Inside a class every character is a literal except the escape
      // backslash and the closing bracket (the first `]` always closes it
      // in this grammar, `[]` is an empty class).
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        i += pattern[i] === "\\" ? 2 : 1;
      }
      i++;
      last = { isGroup: false, hasLarge: false };
    } else if (c === "(") {
      // The opener's own characters (`?:`, `?=`, `?!`, `?<=`, `?<name>`,
      // a modifier list) carry no repeat that counts as large, so they are
      // read like ordinary atoms after the `(`.
      stack.push({ hasLarge: false });
      i++;
      last = null;
    } else if (c === ")") {
      const frame = stack.length > 1 ? stack.pop()! : { hasLarge: false };
      const top = stack[stack.length - 1];
      if (frame.hasLarge) top.hasLarge = true;
      last = { isGroup: true, hasLarge: frame.hasLarge };
      i++;
    } else if (c === "|") {
      last = null;
      i++;
    } else {
      const q = readQuantifier(pattern, i);
      if (q) {
        const large = isLargeMax(q.max);
        if (large) {
          if (last?.isGroup && last.hasLarge) nested = true;
          stack[stack.length - 1].hasLarge = true;
        }
        last = null;
        i = q.next;
      } else {
        last = { isGroup: false, hasLarge: false };
        i++;
      }
    }
  }
  return nested ? { kind: "nested-quantifier" } : null;
}

/**
 * Number of `**` segments in a glob, counted the way `globToRegex` reads it
 * (left to right, a `**` consumes two stars).
 */
export function countDoubleStars(glob: string): number {
  let count = 0;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      count++;
      i++;
    }
  }
  return count;
}
