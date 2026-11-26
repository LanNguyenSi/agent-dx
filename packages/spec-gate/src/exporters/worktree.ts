/**
 * Reading one file of the work tree: a regular file at the name itself (a
 * symbolic link is refused, so a spec pull request cannot point a name at
 * content it did not commit as that name), bounded; the bytes are compared
 * as bytes and decoded fatally only for parsing, so two different byte
 * sequences never pass as one.
 */
import fs from "node:fs";
import { ExportError } from "./errors.js";
import type { ExportErrorCode } from "./errors.js";

/** The cap of the other readers of these files (`canonical/load.ts`). */
export const MAX_WORKTREE_BYTES = 4 * 1024 * 1024;

/** The text of bytes read by `readWorktreeBytes`, decoded fatally. */
export function decodeWorktreeText(bytes: Buffer, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExportError("not-utf8", `${what} is not valid UTF-8`);
  }
}

/**
 * The bytes of one work tree file: a regular file at the name itself (a
 * symbolic link is refused, so a spec pull request cannot point a name at
 * content it did not commit as that name), bounded, and never decoded, so
 * a comparison of two reads sees every byte, a byte order mark included.
 */
export function readWorktreeBytes(
  file: string,
  what: string,
  missingCode: ExportErrorCode,
): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ExportError(missingCode, `${what} does not exist`);
    }
    throw new ExportError(missingCode, `${what} cannot be read`);
  }
  if (!stat.isFile()) {
    throw new ExportError(
      "not-regular",
      `${what} must be a regular file, not a link or a directory`,
    );
  }
  if (stat.size > MAX_WORKTREE_BYTES) {
    throw new ExportError(
      "input-too-large",
      `${what} is ${stat.size} bytes, the limit is ${MAX_WORKTREE_BYTES}`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new ExportError(missingCode, `${what} cannot be read`);
  }
  return bytes;
}

/** The text of one work tree file: the bytes, decoded fatally. */
export function readWorktreeText(
  file: string,
  what: string,
  missingCode: ExportErrorCode,
): string {
  return decodeWorktreeText(readWorktreeBytes(file, what, missingCode), what);
}
