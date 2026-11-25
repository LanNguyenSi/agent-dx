/**
 * Whole-file writes inside a spec directory for `propose` and `bind`: the
 * text goes to a temporary file in the same directory, created exclusively
 * (`wx`, so no existing path is followed or reused), and then takes the
 * place of the target in one step. A reader sees the old file or the new
 * one whole, never a part.
 *
 * - `replaceFile` renames over an existing regular file and keeps its
 *   permission bits (never setuid, setgid or sticky). A link at the target is
 *   refused.
 * - `createFile` links the temporary file to a name that must not exist yet,
 *   so a file that appeared in the meantime is never overwritten.
 */
import fs from "node:fs";
import path from "node:path";

export type WriteResult = { ok: true } | { ok: false; message: string };

/** The mode of a new file, before the umask. */
const DEFAULT_MODE = 0o666;

function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "unknown error";
}

function writeTemp(temp: string, text: string, mode: number): void {
  const fd = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeTemp(temp: string): void {
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // the temporary file stays; the named failure is what callers see
  }
}

function tempName(dir: string, name: string): string {
  return path.join(dir, `${name}.tmp-${process.pid}`);
}

/** Replaces the regular file `name` in `dir` with `text`. */
export function replaceFile(
  dir: string,
  name: string,
  text: string,
): WriteResult {
  const file = path.join(dir, name);
  let mode: number;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) {
      return { ok: false, message: `${name} is not a regular file` };
    }
    mode = stat.mode & 0o777;
    fs.accessSync(file, fs.constants.W_OK);
  } catch (err) {
    return { ok: false, message: `cannot write ${name}: ${errnoOf(err)}` };
  }
  const temp = tempName(dir, name);
  let created = false;
  try {
    writeTemp(temp, text, mode);
    created = true;
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (err) {
    // Only the path this run created is removed: `wx` failing means
    // something else sits at the temporary name.
    if (created || errnoOf(err) !== "EEXIST") removeTemp(temp);
    return { ok: false, message: `cannot write ${name}: ${errnoOf(err)}` };
  }
  return { ok: true };
}

/** Creates `name` in `dir` with `text`; refused when the name exists. */
export function createFile(
  dir: string,
  name: string,
  text: string,
): WriteResult {
  const file = path.join(dir, name);
  const temp = tempName(dir, name);
  try {
    writeTemp(temp, text, DEFAULT_MODE);
  } catch (err) {
    if (errnoOf(err) !== "EEXIST") removeTemp(temp);
    return { ok: false, message: `cannot write ${name}: ${errnoOf(err)}` };
  }
  try {
    fs.linkSync(temp, file);
  } catch (err) {
    removeTemp(temp);
    return {
      ok: false,
      message:
        errnoOf(err) === "EEXIST"
          ? `${name} already exists`
          : `cannot write ${name}: ${errnoOf(err)}`,
    };
  }
  removeTemp(temp);
  return { ok: true };
}
