/** A failure named by a stable code; the CLI prints it and exits non-zero. */
export class IntakeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "IntakeError";
  }
}

/**
 * The errno code of a failed file system call, for a message that must not
 * carry a stack trace or the text of the underlying error.
 */
export function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}
