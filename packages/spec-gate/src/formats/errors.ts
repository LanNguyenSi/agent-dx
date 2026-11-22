/**
 * Structured results shared by every format parser.
 *
 * A parser takes text (or an already decoded value) and returns a
 * `ParseResult`. It never throws on bad input and never touches the file
 * system or the network.
 */

export type FormatErrorCode =
  // input handling
  | "input-too-large"
  | "too-many-errors"
  | "empty-document"
  | "invalid-yaml"
  | "invalid-json"
  | "duplicate-key"
  | "yaml-alias"
  | "yaml-tag"
  | "blank-line"
  // generic shape
  | "wrong-type"
  | "missing-field"
  | "unknown-field"
  | "invalid-value"
  | "empty-value"
  | "duplicate-value"
  // field layers and kinds
  | "wrong-layer-field"
  | "field-not-allowed-for-kind"
  // ids
  | "invalid-id"
  | "duplicate-id"
  | "retired-id-live"
  | "id-section-mismatch"
  // test plan and bindings
  | "covers-empty"
  | "covers-invalid-id"
  | "invalid-selector"
  // spec.md grammar
  | "missing-frontmatter"
  | "unterminated-frontmatter"
  | "unknown-section"
  | "duplicate-section"
  | "context-heading-lookalike"
  | "unexpected-line"
  | "invalid-item-line"
  | "bad-indent"
  | "unknown-attribute"
  | "duplicate-attribute"
  | "missing-attribute"
  | "attribute-not-allowed"
  | "forbidden-character"
  // questions
  | "unknown-question"
  | "unknown-option"
  | "duplicate-answer"
  | "recommended-not-allowed"
  // config and commands
  | "shell-string"
  | "selector-embedded"
  | "selector-as-program"
  | "selector-in-discovery"
  | "multiple-selector-commands"
  | "unknown-placeholder"
  | "discovery-required"
  // evidence
  | "ci-run-required"
  | "ci-run-not-allowed"
  | "command-required";

export interface FormatError {
  /** Stable machine-readable code. */
  code: FormatErrorCode;
  /**
   * Dotted location inside the document: `$` for the root, a row or line
   * ID (`TP-1.kind`, `AC-2.owner`) where one exists, `[n]` for the n-th
   * (0-based) array element otherwise.
   */
  path: string;
  /** Human-readable explanation. Names the field, row and kind where they apply. */
  message: string;
  /** 1-based line in the input, where the format is line oriented. */
  line?: number;
}

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; errors: FormatError[] };

export function okResult<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function failResult<T>(errors: FormatError[]): ParseResult<T> {
  return { ok: false, errors };
}

/**
 * How many errors of one capped code a document lists. A text can repeat
 * the same fault on every line; past this number the list would only grow.
 */
export const MAX_ERRORS_PER_CODE = 100;

/** The codes that are capped: the two that a single line can raise. */
export const CAPPED_CODES = [
  "forbidden-character",
  "context-heading-lookalike",
] as const;

/** The one entry that stands for every error of `code` past the limit. */
export function tooManyErrors(
  code: FormatErrorCode,
  total: number,
): FormatError {
  return {
    code: "too-many-errors",
    path: "$",
    message: `${total} ${code} errors in total; the first ${MAX_ERRORS_PER_CODE} are listed`,
  };
}

/** Collects errors while a parser walks a document. */
export class ErrorSink {
  readonly errors: FormatError[] = [];

  /** Line attached to errors that are added without an explicit line. */
  lineHint: number | undefined;

  /**
   * Where a forbidden character was already reported: per path, the lines,
   * with `null` for a report without a line.
   */
  private readonly forbiddenAt = new Map<string, Set<number | null>>();

  /** Per capped code: how many errors were added, and the error that says so. */
  private readonly capped = new Map<
    FormatErrorCode,
    { total: number; overflow?: FormatError }
  >();

  add(code: FormatErrorCode, path: string, message: string, line?: number) {
    const at = line ?? this.lineHint;
    // One forbidden-character error per path and line: a value can be seen
    // by the line check and by a field check, and says the same thing twice.
    if (
      code === "forbidden-character" &&
      this.repeatsForbidden(path, at ?? null)
    ) {
      return;
    }
    // A capped code is listed up to the limit. From the next one on, a
    // single `too-many-errors` entry carries the running total.
    if ((CAPPED_CODES as readonly FormatErrorCode[]).includes(code)) {
      const count = this.capped.get(code) ?? { total: 0 };
      this.capped.set(code, count);
      count.total += 1;
      if (count.total > MAX_ERRORS_PER_CODE) {
        const summary = tooManyErrors(code, count.total);
        if (count.overflow) count.overflow.message = summary.message;
        else {
          count.overflow = summary;
          this.errors.push(summary);
        }
        return;
      }
    }
    const error: FormatError = { code, path, message };
    if (at !== undefined) error.line = at;
    this.errors.push(error);
  }

  /**
   * True when `path` already has a report for this line. A report without
   * a line repeats, and is repeated by, any report on its path. The lookup
   * does not grow with the number of errors, so a text with a forbidden
   * character on every line is still handled in linear time.
   */
  private repeatsForbidden(path: string, at: number | null): boolean {
    const seen = this.forbiddenAt.get(path);
    if (seen === undefined) {
      this.forbiddenAt.set(path, new Set([at]));
      return false;
    }
    if (at === null || seen.has(null) || seen.has(at)) return true;
    seen.add(at);
    return false;
  }

  get empty(): boolean {
    return this.errors.length === 0;
  }

  /** Finishes a parse: the value when no error was collected, else the errors. */
  finish<T>(value: T): ParseResult<T> {
    return this.empty ? okResult(value) : failResult(this.errors);
  }
}
