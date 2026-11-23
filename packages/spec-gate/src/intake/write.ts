import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { errnoCode, IntakeError } from "./errors.js";

export interface SourceFiles {
  /** `ticket.md` content, or null when it is not written (`--no-raw`). */
  ticket: Buffer | null;
  /** The serialised `meta.json`. */
  meta: string;
}

function writeFailed(what: string, err: unknown): IntakeError {
  return new IntakeError(
    "write-failed",
    `cannot write ${what} (${errnoCode(err)}); nothing was left behind`,
  );
}

/** Writes `data` under a temporary name, then renames it into place. */
function writeAtomic(dir: string, name: string, data: Buffer | string): void {
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, data, { flag: "wx" });
    fs.renameSync(tmp, path.join(dir, name));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Creates `<repoDir>/specs/<id>/source/` and writes its files. The parent
 * directories are created first; `source/` itself is created without
 * `recursive`, so an existing one (also one that appeared since an earlier
 * check, or a dangling symlink) is `source-exists` and never touched.
 * `ticket.md` is written first and `meta.json` last, each through a
 * temporary name and a rename. If anything fails, everything this call
 * created is removed again.
 */
export function writeSource(
  repoDir: string,
  id: string,
  shown: string,
  files: SourceFiles,
): void {
  const specsDir = path.join(repoDir, "specs");
  const idDir = path.join(specsDir, id);
  const sourceDir = path.join(idDir, "source");
  const createdParents: string[] = [];
  const makeParent = (dir: string): void => {
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir);
    createdParents.push(dir);
  };
  const cleanup = (): void => {
    for (const dir of createdParents.reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // not empty or already gone: leave it
      }
    }
  };
  try {
    makeParent(specsDir);
    makeParent(idDir);
  } catch (err) {
    cleanup();
    throw writeFailed(path.posix.join("specs", id), err);
  }
  try {
    fs.mkdirSync(sourceDir);
  } catch (err) {
    cleanup();
    if (errnoCode(err) === "EEXIST") {
      throw new IntakeError(
        "source-exists",
        `${shown} already exists; nothing was overwritten`,
      );
    }
    throw writeFailed(shown, err);
  }
  try {
    if (files.ticket !== null)
      writeAtomic(sourceDir, "ticket.md", files.ticket);
    writeAtomic(sourceDir, "meta.json", files.meta);
  } catch (err) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    cleanup();
    throw writeFailed(shown, err);
  }
}
