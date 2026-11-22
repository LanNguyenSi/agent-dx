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
  | "unterminated-fence"
  | "unknown-section"
  | "duplicate-section"
  | "unexpected-line"
  | "invalid-item-line"
  | "bad-indent"
  | "unknown-attribute"
  | "duplicate-attribute"
  | "missing-attribute"
  | "attribute-not-allowed"
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

/** Collects errors while a parser walks a document. */
export class ErrorSink {
  readonly errors: FormatError[] = [];

  /** Line attached to errors that are added without an explicit line. */
  lineHint: number | undefined;

  add(code: FormatErrorCode, path: string, message: string, line?: number) {
    const error: FormatError = { code, path, message };
    const at = line ?? this.lineHint;
    if (at !== undefined) error.line = at;
    this.errors.push(error);
  }

  get empty(): boolean {
    return this.errors.length === 0;
  }

  /** Finishes a parse: the value when no error was collected, else the errors. */
  finish<T>(value: T): ParseResult<T> {
    return this.empty ? okResult(value) : failResult(this.errors);
  }
}
