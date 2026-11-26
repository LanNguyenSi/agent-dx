/**
 * Reading one file of the work tree: a regular file at the name itself (a
 * symbolic link is refused, so a spec pull request cannot point a name at
 * content it did not commit as that name), bounded, decoded fatally so two
 * different byte sequences never read as the same text.
 */
import fs from "node:fs";
import { ExportError } from "./errors.js";
import type { ExportErrorCode } from "./errors.js";

/** The cap of the other readers of these files (`canonical/load.ts`). */
export const MAX_WORKTREE_BYTES = 4 * 1024 * 1024;

export function readWorktreeText(
  file: string,
  what: string,
  missingCode: ExportErrorCode,
): string {
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExportError("not-utf8", `${what} is not valid UTF-8`);
  }
}
