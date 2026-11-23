/**
 * The only place lint touches the file system for reading: one hardened
 * reader for every file of a spec directory.
 *
 * A read refuses a link and anything that is not a regular file, caps the
 * size, and decodes UTF-8 fatally. It never throws and never puts an
 * absolute path into a message, because the report is machine-independent.
 */
import fs from "node:fs";
import path from "node:path";

/** More than the format layer accepts (1 MiB of characters, up to 3 bytes each); the digest reader uses the same cap. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const FILE_ERROR_CODES = [
  "input-missing",
  "input-unreadable",
  "input-not-regular",
  "input-too-large",
  "input-not-utf8",
] as const;
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

export type FileRead =
  | { ok: true; text: string }
  | { ok: false; code: FileErrorCode; message: string };

function errno(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "unknown error";
}

function fail(code: FileErrorCode, message: string): FileRead {
  return { ok: false, code, message };
}

/**
 * Reads `rel` (`/` separated, below `dir`) as text. Every directory above
 * the file must be a real directory, not a link.
 */
export function readSpecFile(dir: string, rel: string): FileRead {
  const parts = rel.split("/");
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (errno(err) === "ENOENT") {
        return fail("input-missing", `${rel} does not exist`);
      }
      return fail("input-unreadable", `${rel} cannot be read: ${errno(err)}`);
    }
    if (!stat.isDirectory()) {
      return fail(
        "input-not-regular",
        `${rel} must be below a real directory, not a link or a file`,
      );
    }
  }
  const file = path.join(current, parts[parts.length - 1]!);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (errno(err) === "ENOENT") {
      return fail("input-missing", `${rel} does not exist`);
    }
    return fail("input-unreadable", `${rel} cannot be read: ${errno(err)}`);
  }
  if (!stat.isFile()) {
    return fail(
      "input-not-regular",
      `${rel} must be a regular file, not a link or a directory`,
    );
  }
  if (stat.size > MAX_FILE_BYTES) {
    return fail(
      "input-too-large",
      `${rel} is ${stat.size} bytes, the limit is ${MAX_FILE_BYTES}`,
    );
  }
  let bytes: Buffer;
  try {
    // No link is followed at the open either: a path swapped for a link
    // after the checks above fails here instead of being read.
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) {
        return fail(
          "input-unreadable",
          `${rel} changed while it was being read`,
        );
      }
      bytes = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return fail("input-unreadable", `${rel} cannot be read: ${errno(err)}`);
  }
  try {
    // Fatal decoding: invalid bytes must not collapse to U+FFFD.
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return fail("input-not-utf8", `${rel} is not valid UTF-8`);
  }
}
