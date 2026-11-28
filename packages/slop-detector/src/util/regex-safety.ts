// Load-time structural checks for the regular expressions and globs a config
// hands to the packs.
//
// The engine and every rule are synchronous, so a pattern that backtracks
// without bound stalls the whole scan (CLI, MCP server and action alike), and
// a config can be loaded from a file inside the scanned tree. There is no
// regex-engine dependency to lean on, so this module reads the pattern source
// itself and refuses the common nested-quantifier shapes:
//
//   - a group repeated more than `MAX_OUTER_REPEAT` times whose body holds a
//     repeat with a variable count (`(a+)+`, `(.*)*`, `(\w+\s?)+`,
//     `((ab)+)+`, `(a{1,16})+`, `(a+){3}`). A repeat counts as variable when
//     its upper count exceeds its lower count and is at least 2; a fixed
//     count (`{n}`) and `?` do not,
//   - backreferences (`\1`, `\k<name>`),
//   - patterns longer than `MAX_REGEX_LENGTH` characters.
//
// It is a structural check, not a proof, and a pattern it accepts can still
// stall a scan on a long line: overlapping alternation under one repeat
// (`(a|a)*`, `(a|ab)*`) and adjacent overlapping repeats (`a*a*a*b`, `a+a+x`)
// are not detected. See `docs/configuration.md`.

/** Longest accepted regex source, in characters. */
export const MAX_REGEX_LENGTH = 512;

/**
 * A group repeated at most this many times may hold a variable repeat
 * (`(a+){2}` is quadratic at worst); above it, or unbounded, it may not.
 */
export const MAX_OUTER_REPEAT = 2;

/** Most wildcards (`*` or `**`) one config glob may carry. */
export const MAX_GLOB_WILDCARDS = 8;

export type RegexSafetyProblem =
  | { kind: "too-long" }
  | { kind: "backreference" }
  | { kind: "nested-quantifier" };

interface Frame {
  /** True once a variable repeat was seen anywhere inside this group. */
  hasVariable: boolean;
}

interface Atom {
  isGroup: boolean;
  /** For a group: a variable repeat occurs somewhere inside its body. */
  hasVariable: boolean;
}

interface Quantifier {
  min: number;
  max: number;
  next: number;
}

const BRACE_QUANTIFIER = /\{(\d+)(?:(,)(\d*))?\}/y;

/**
 * Reads the quantifier that starts at `src[i]`, if there is one. `{` that does
 * not form a valid `{n}`, `{n,}` or `{n,m}` is a literal in the non-unicode
 * grammar the packs compile with, so it is not a quantifier here either.
 * Returns the lowest and highest repeat count (`Infinity` when unbounded) and
 * the index after the quantifier.
 */
function readQuantifier(src: string, i: number): Quantifier | null {
  const c = src[i];
  if (c === "*") return { min: 0, max: Infinity, next: i + 1 };
  if (c === "+") return { min: 1, max: Infinity, next: i + 1 };
  // A lazy `?` after a quantifier is read on the next step as a repeat of at
  // most one, which is never variable.
  if (c === "?") return { min: 0, max: 1, next: i + 1 };
  if (c !== "{") return null;
  BRACE_QUANTIFIER.lastIndex = i;
  const m = BRACE_QUANTIFIER.exec(src);
  if (!m) return null;
  const min = Number(m[1]);
  let max: number;
  if (m[2] === undefined) max = min;
  else if (m[3] === "") max = Infinity;
  else max = Number(m[3]);
  return { min, max, next: i + m[0].length };
}

/**
 * Structural verdict on a regex source that already compiles. `null` means
 * none of the refused shapes was found.
 */
export function findRegexSafetyProblem(
  pattern: string,
): RegexSafetyProblem | null {
  if (pattern.length > MAX_REGEX_LENGTH) return { kind: "too-long" };

  const stack: Frame[] = [{ hasVariable: false }];
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
      last = { isGroup: false, hasVariable: false };
    } else if (c === "[") {
      // Inside a class every character is a literal except the escape
      // backslash and the closing bracket (the first `]` always closes it
      // in this grammar, `[]` is an empty class).
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        i += pattern[i] === "\\" ? 2 : 1;
      }
      i++;
      last = { isGroup: false, hasVariable: false };
    } else if (c === "(") {
      // The opener's own characters (`?:`, `?=`, `?!`, `?<=`, `?<name>`,
      // a modifier list) carry no variable repeat, so they are read like
      // ordinary atoms after the `(`.
      stack.push({ hasVariable: false });
      i++;
      last = null;
    } else if (c === ")") {
      const frame = stack.length > 1 ? stack.pop()! : { hasVariable: false };
      const top = stack[stack.length - 1];
      if (frame.hasVariable) top.hasVariable = true;
      last = { isGroup: true, hasVariable: frame.hasVariable };
      i++;
    } else if (c === "|") {
      last = null;
      i++;
    } else {
      const q = readQuantifier(pattern, i);
      if (q) {
        if (last?.isGroup && last.hasVariable && q.max > MAX_OUTER_REPEAT) {
          nested = true;
        }
        if (q.max > q.min && q.max >= 2) {
          stack[stack.length - 1].hasVariable = true;
        }
        last = null;
        i = q.next;
      } else {
        last = { isGroup: false, hasVariable: false };
        i++;
      }
    }
  }
  return nested ? { kind: "nested-quantifier" } : null;
}

/**
 * Number of wildcards (`*` and `**`) in a glob, counted the way `globToRegex`
 * reads it (left to right, a `**` consumes two stars).
 */
export function countWildcards(glob: string): number {
  let count = 0;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*") {
      count++;
      if (glob[i + 1] === "*") i++;
    }
  }
  return count;
}
