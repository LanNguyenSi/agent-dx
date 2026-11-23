/**
 * The file adapter of intake.
 *
 * `spec-gate intake file <path> --id <spec-id>` creates
 * `specs/<id>/source/` in the target repository from a local file: the raw
 * request (`ticket.md`, unless `--no-raw`) and the record of where it came
 * from (`meta.json`, shape documented in `docs/formats.md`). This module
 * reads the local file and its attachments; everything that does not depend
 * on the adapter (the secret scan, the meta model, the remote head, the
 * drift diff, the writing) lives in `src/intake/`.
 *
 * Two rules govern the whole command:
 * - Ticket content is data. It is never interpreted, no link in it is
 *   followed, nothing it names is downloaded, and the bytes are written
 *   unedited. A secret scan of the bytes before anything is written refuses
 *   files that hold credentials; the scan names the pattern and the line and
 *   never prints the value.
 * - `base_commit` and `commands_ref` are set by code only: they are the head
 *   of the remote default branch after a fetch. No option and no input file
 *   sets or overrides them.
 *
 * Every failure path writes nothing: the file checks, the secret scan, the
 * existing-directory refusal, the attachment reads and the fetch all happen
 * before the first byte is written, and a write that fails half way is
 * removed again.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  isSpecId,
  MAX_SPEC_ID_LENGTH,
  splitSourceLines,
} from "../formats/index.js";
import {
  assertScannableText,
  diffSourceLines,
  errnoCode,
  findSecret,
  gitToplevel,
  IntakeError,
  parseRecordedMeta,
  remoteBaseCommit,
  serializeMeta,
  sha256Hex,
  writeSource,
} from "../intake/index.js";
import type {
  SourceAttachment,
  SourceLineRef,
  SourceMeta,
} from "../intake/index.js";

/** Small fixed table; an extension outside it is `application/octet-stream`. */
export const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export const UNKNOWN_ATTACHMENT_TYPE = "application/octet-stream";

function attachmentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return TYPE_BY_EXTENSION[ext] ?? UNKNOWN_ATTACHMENT_TYPE;
}

/** The source must be a regular file: a symlink or a directory is an error. */
function readSourceFile(sourcePath: string): Buffer {
  const shown = JSON.stringify(sourcePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    throw new IntakeError("source-missing", `${shown} does not exist`);
  }
  if (stat.isSymbolicLink()) {
    throw new IntakeError(
      "source-not-a-file",
      `${shown} is a symlink; a regular file is required`,
    );
  }
  if (!stat.isFile()) {
    throw new IntakeError(
      "source-not-a-file",
      `${shown} is not a regular file`,
    );
  }
  try {
    return fs.readFileSync(sourcePath);
  } catch (err) {
    throw new IntakeError(
      "source-unreadable",
      `${shown} cannot be read (${errnoCode(err)})`,
    );
  }
}

/** An attachment is never copied; only its name, hash, size and type are recorded. */
function collectAttachments(paths: readonly string[]): SourceAttachment[] {
  return paths.map((p) => {
    let bytes: Buffer;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) {
        throw new IntakeError(
          "attachment-missing",
          `attachment ${JSON.stringify(p)} is not a regular file`,
        );
      }
      bytes = fs.readFileSync(p);
    } catch (err) {
      if (err instanceof IntakeError) throw err;
      throw new IntakeError(
        "attachment-missing",
        `attachment ${JSON.stringify(p)} cannot be read (${errnoCode(err)})`,
      );
    }
    return {
      name: path.basename(p),
      sha256: sha256Hex(bytes),
      size: bytes.length,
      type: attachmentType(p),
    };
  });
}

async function resolveRepoDir(repo: string | undefined): Promise<string> {
  if (repo === undefined) return gitToplevel(process.cwd());
  try {
    if (!fs.statSync(repo).isDirectory()) {
      throw new IntakeError("bad-repo", "not a directory");
    }
  } catch (err) {
    throw new IntakeError(
      "bad-repo",
      `--repo ${JSON.stringify(repo)} is not a directory${err instanceof IntakeError ? "" : ` (${errnoCode(err)})`}`,
    );
  }
  return path.resolve(repo);
}

function readRecordedMetaFile(
  metaPath: string,
  shown: string,
): ReturnType<typeof parseRecordedMeta> {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch {
    throw new IntakeError(
      "meta-missing",
      `${shown} cannot be read; run intake file first`,
    );
  }
  return parseRecordedMeta(raw, shown);
}

export interface FileIntakeOptions {
  sourcePath: string;
  id: string;
  repo?: string | undefined;
  remote: string;
  author?: string | undefined;
  attach: readonly string[];
  raw: boolean;
  check: boolean;
}

export interface IntakeRun {
  /** Text written to stdout, empty when there is nothing to say. */
  stdout: string;
  exitCode: number;
}

export async function intakeFile(
  options: FileIntakeOptions,
): Promise<IntakeRun> {
  if (!isSpecId(options.id)) {
    throw new IntakeError(
      "invalid-spec-id",
      `${JSON.stringify(options.id)} is not a spec ID: expected lower-case letters and digits in hyphen-separated groups, at most ${MAX_SPEC_ID_LENGTH} characters`,
    );
  }
  const repoDir = await resolveRepoDir(options.repo);
  const bytes = readSourceFile(options.sourcePath);
  assertScannableText(bytes, options.sourcePath);
  const text = bytes.toString("utf8");
  const secret = findSecret(text);
  if (secret) {
    throw new IntakeError(
      "secret-scan",
      `line ${secret.line} of ${JSON.stringify(options.sourcePath)} matches the ${secret.pattern} pattern; the value is not printed and nothing is written`,
    );
  }
  const split = splitSourceLines(text);
  if (!split.ok) {
    throw new IntakeError(
      split.errors[0]?.code ?? "invalid-source",
      split.errors[0]?.message ?? "the source cannot be split into lines",
    );
  }
  const lines: SourceLineRef[] = split.value.map((l) => ({
    id: l.id,
    kind: l.kind,
  }));
  const sourceDir = path.join(repoDir, "specs", options.id, "source");
  const shown = path.posix.join("specs", options.id, "source");

  if (options.check) {
    const metaPath = path.join(sourceDir, "meta.json");
    const recorded = readRecordedMetaFile(metaPath, `${shown}/meta.json`);
    if (sha256Hex(bytes) === recorded.sha256) {
      return { stdout: JSON.stringify({ status: "ok" }), exitCode: 0 };
    }
    const drift = diffSourceLines(recorded.lines, lines);
    return { stdout: JSON.stringify(drift), exitCode: 1 };
  }

  if (fs.existsSync(sourceDir)) {
    throw new IntakeError(
      "source-exists",
      `${shown} already exists; nothing was overwritten`,
    );
  }
  const attachments = collectAttachments(options.attach);
  const commit = await remoteBaseCommit(repoDir, options.remote);

  const sha256 = sha256Hex(bytes);
  const meta: SourceMeta = {
    adapter: "file",
    origin: options.sourcePath,
    fetched_at: new Date().toISOString(),
    sha256,
    trust: "untrusted",
    sections: [{ name: "body", author: options.author ?? null, sha256 }],
    attachments,
    raw: options.raw,
    lines,
    base_commit: commit,
    commands_ref: commit,
  };
  writeSource(repoDir, options.id, shown, {
    ticket: options.raw ? bytes : null,
    meta: serializeMeta(meta),
  });
  return { stdout: "", exitCode: 0 };
}
