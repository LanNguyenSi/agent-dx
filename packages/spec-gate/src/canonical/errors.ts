import type { FormatError } from "../formats/index.js";

export const DIGEST_ERROR_CODES = [
  "spec-dir-invalid",
  "input-missing",
  "input-not-regular",
  "input-too-large",
  "input-not-utf8",
  "input-unreadable",
  "spec-invalid",
  "testplan-invalid",
  "repo-not-found",
  "repo-invalid",
  "git-failed",
  "commands-ref-unresolvable",
  "commands-file-missing",
  "commands-file-invalid",
  "command-ref-unknown",
] as const;

export type DigestErrorCode = (typeof DIGEST_ERROR_CODES)[number];

/** A digest could not be computed. No digest exists for the input. */
export class DigestError extends Error {
  readonly code: DigestErrorCode;
  /** The input the error is about, such as `spec.md`. */
  readonly file?: string;
  /** The format layer's errors, for `spec-invalid` and friends. */
  readonly formatErrors?: FormatError[];

  constructor(
    code: DigestErrorCode,
    message: string,
    extra: { file?: string; formatErrors?: FormatError[] } = {},
  ) {
    super(message);
    this.name = "DigestError";
    this.code = code;
    if (extra.file !== undefined) this.file = extra.file;
    if (extra.formatErrors !== undefined)
      this.formatErrors = extra.formatErrors;
  }
}

/** Plain-text report of an error, one line per format error. */
export function describeDigestError(err: DigestError): string {
  const lines = [`spec-gate digest: error [${err.code}]: ${err.message}`];
  for (const e of err.formatErrors ?? []) {
    const where = [
      err.file,
      e.path,
      e.line !== undefined ? `line ${e.line}` : "",
    ]
      .filter((p) => p !== undefined && p !== "")
      .join(" ");
    lines.push(`  [${e.code}] ${where}: ${e.message}`);
  }
  return `${lines.join("\n")}\n`;
}
