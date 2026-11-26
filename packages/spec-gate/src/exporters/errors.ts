/**
 * The one error type of `spec-gate export`. Every refusal carries a code:
 * the CLI line is `spec-gate: export: <code>: <message>` on stderr with
 * exit code 2, so a caller can branch on the name and not on the sentence.
 */
export type ExportErrorCode =
  | "usage"
  | "spec-dir-invalid"
  | "repo-invalid"
  | "ref-invalid"
  | "ref-unresolvable"
  | "path-invalid"
  | "git-failed"
  | "not-proposed"
  | "not-merged"
  | "not-regular"
  | "not-utf8"
  | "input-missing"
  | "input-too-large"
  | "spec-invalid"
  | "testplan-invalid"
  | "bindings-invalid"
  | "binding-path-not-canonical"
  | "digest-failed"
  | "return-unreadable"
  | "return-parse"
  | "return-shape";

export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}
