/**
 * Intake.
 *
 * `spec-gate intake file <path> --id <spec-id>` creates
 * `specs/<id>/source/` in the target repository from a local file: the raw
 * request (`ticket.md`, unless `--no-raw`) and the record of where it came
 * from (`meta.json`, shape documented in `docs/formats.md`).
 *
 * Two rules govern the whole module:
 * - Ticket content is data. It is never interpreted, no link in it is
 *   followed, nothing it names is downloaded, and the bytes are written
 *   unedited. A secret scan of the bytes before anything is written refuses
 *   files that hold credentials; the scan names the pattern and the line and
 *   never prints the value.
 * - `base_commit` and `commands_ref` are set by code only: they are the head
 *   of the remote default branch after a fetch. No option and no input file
 *   sets or overrides them. git is called only as `execFile("git", argv)`
 *   with a timeout, never through a shell.
 *
 * Every failure path writes nothing: the file checks, the secret scan, the
 * existing-directory refusal, the attachment reads and the fetch all happen
 * before the first byte is written.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  isSpecId,
  MAX_SPEC_ID_LENGTH,
  parseJsonText,
  parseSourceLineId,
  splitSourceLines,
} from "./formats/index.js";
import type { SourceLineKind } from "./formats/index.js";

const execFileAsync = promisify(execFile);

/** Every `git` call gets this timeout, in milliseconds. */
export const GIT_TIMEOUT_MS = 15_000;

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

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

export interface SecretPattern {
  /** Stable name; it is the only thing an error says about the match. */
  name: string;
  re: RegExp;
}

/**
 * Patterns that refuse a ticket file before anything is written. Each is
 * tested once, and a near-miss of every one must not trip: the GitHub token
 * body length, the AWS key length, the quoted-value length and the generic
 * assignment word set are what separate a hit from a near-miss.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  {
    name: "github-token",
    re: /(?:gh[posu]_|github_pat_)[A-Za-z0-9_]{20,}/,
  },
  { name: "slack-token", re: /xox[abpr]-/ },
  {
    name: "secret-assignment",
    re: /\b(?:password|secret|token|api_key)\b\s*[:=]\s*["'][^"']{12,}["']/i,
  },
];

export interface SecretHit {
  pattern: string;
  /** 1-based line of the file. */
  line: number;
}

/** The first secret in the text, or null. The matched value is not kept. */
export function findSecret(text: string): SecretHit | null {
  const lines = text.split(/\r\n|\n|\r/);
  for (const [i, line] of lines.entries()) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) return { pattern: p.name, line: i + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

export interface SourceSection {
  name: string;
  author: string | null;
  sha256: string;
}

export interface SourceAttachment {
  name: string;
  sha256: string;
  size: number;
  type: string;
}

export interface SourceLineRef {
  id: string;
  kind: SourceLineKind;
}

export interface SourceMeta {
  adapter: "file";
  origin: string;
  fetched_at: string;
  sha256: string;
  trust: "untrusted";
  sections: SourceSection[];
  attachments: SourceAttachment[];
  raw: boolean;
  lines: SourceLineRef[];
  base_commit: string;
  commands_ref: string;
}

/** Key order as listed in `docs/formats.md`, 2-space JSON, trailing newline. */
export function serializeMeta(meta: SourceMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Drift (`--check`)
// ---------------------------------------------------------------------------

export interface DriftResult {
  status: "source-drift";
  changed_lines: { old: string; new: string }[];
  added: string[];
  removed: string[];
}

/**
 * Diff of the recorded line IDs against the current ones, aligned by
 * position. A position present in both with different IDs is a changed
 * line; an old position gone is removed; a new position is added. The
 * lists are in position order.
 */
export function diffSourceLines(
  oldLines: readonly SourceLineRef[],
  newLines: readonly SourceLineRef[],
): DriftResult {
  const atPosition = (
    lines: readonly SourceLineRef[],
    what: string,
  ): Map<number, string> => {
    const byPos = new Map<number, string>();
    for (const l of lines) {
      const parsed = parseSourceLineId(l.id);
      if (!parsed.ok) {
        throw new IntakeError(
          "meta-invalid",
          `${JSON.stringify(l.id)} in ${what} is not a source line ID`,
        );
      }
      byPos.set(parsed.value.position, l.id);
    }
    return byPos;
  };
  const oldByPos = atPosition(oldLines, "meta.json");
  const newByPos = atPosition(newLines, "the file");
  const changed_lines: { old: string; new: string }[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const positions = [...new Set([...oldByPos.keys(), ...newByPos.keys()])];
  positions.sort((a, b) => a - b);
  for (const pos of positions) {
    const old = oldByPos.get(pos);
    const next = newByPos.get(pos);
    if (old !== undefined && next !== undefined) {
      if (old !== next) changed_lines.push({ old, new: next });
    } else if (old !== undefined) {
      removed.push(old);
    } else if (next !== undefined) {
      added.push(next);
    }
  }
  return { status: "source-drift", changed_lines, added, removed };
}

function readRecordedMeta(
  metaPath: string,
  shown: string,
): {
  sha256: string;
  lines: SourceLineRef[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch {
    throw new IntakeError(
      "meta-missing",
      `${shown} cannot be read; run intake file first`,
    );
  }
  const parsed = parseJsonText(raw);
  if (!parsed.ok) {
    throw new IntakeError(
      "meta-invalid",
      `${shown} is not strict JSON: ${parsed.errors[0]?.message ?? ""}`,
    );
  }
  const value = parsed.value as { sha256?: unknown; lines?: unknown };
  if (typeof value.sha256 !== "string" || !Array.isArray(value.lines)) {
    throw new IntakeError(
      "meta-invalid",
      `${shown} holds no sha256 string or no lines array`,
    );
  }
  const lines: SourceLineRef[] = [];
  for (const entry of value.lines) {
    const l = entry as { id?: unknown; kind?: unknown };
    if (typeof l?.id !== "string" || typeof l?.kind !== "string") {
      throw new IntakeError(
        "meta-invalid",
        `${shown} has a lines entry that is not { id, kind }`,
      );
    }
    lines.push({ id: l.id, kind: l.kind as SourceLineKind });
  }
  return { sha256: value.sha256, lines };
}

// ---------------------------------------------------------------------------
// File checks
// ---------------------------------------------------------------------------

/** The source must be a regular file: a symlink or a directory is an error. */
function readSourceFile(sourcePath: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    throw new IntakeError(
      "source-missing",
      `${JSON.stringify(sourcePath)} does not exist`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new IntakeError(
      "source-not-a-file",
      `${JSON.stringify(sourcePath)} is a symlink; a regular file is required`,
    );
  }
  if (!stat.isFile()) {
    throw new IntakeError(
      "source-not-a-file",
      `${JSON.stringify(sourcePath)} is not a regular file`,
    );
  }
  return fs.readFileSync(sourcePath);
}

/** An attachment is never copied; only its name, hash, size and type are recorded. */
function collectAttachments(paths: readonly string[]): SourceAttachment[] {
  return paths.map((p) => {
    let bytes: Buffer;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) throw new Error("not a regular file");
      bytes = fs.readFileSync(p);
    } catch (err) {
      throw new IntakeError(
        "attachment-missing",
        `attachment ${JSON.stringify(p)} cannot be read: ${(err as Error).message}`,
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

// ---------------------------------------------------------------------------
// git (execFile with an argv list only, each call with a timeout)
// ---------------------------------------------------------------------------

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: repoDir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

async function resolveRepoDir(repo: string | undefined): Promise<string> {
  if (repo !== undefined) {
    try {
      if (!fs.statSync(repo).isDirectory()) throw new Error("not a directory");
    } catch (err) {
      throw new IntakeError(
        "bad-repo",
        `--repo ${JSON.stringify(repo)} is not a directory: ${(err as Error).message}`,
      );
    }
    return path.resolve(repo);
  }
  try {
    const stdout = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const toplevel = stdout.trim();
    if (toplevel === "") throw new Error("empty output");
    return toplevel;
  } catch {
    throw new IntakeError(
      "no-git-toplevel",
      `the current directory is not inside a git repository; pass --repo`,
    );
  }
}

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The remote's default branch, read from the remote's own HEAD symref. */
async function remoteDefaultBranch(
  repoDir: string,
  remote: string,
): Promise<string> {
  let out: string;
  try {
    out = await git(repoDir, ["ls-remote", "--symref", remote, "HEAD"]);
  } catch (err) {
    throw new IntakeError(
      "no-remote",
      `remote ${JSON.stringify(remote)} cannot be read: ${firstLine((err as Error).message)}`,
    );
  }
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\b/m.exec(out);
  if (!m) {
    throw new IntakeError(
      "no-default-branch",
      `remote ${JSON.stringify(remote)} names no default branch`,
    );
  }
  return m[1]!;
}

/** The commit a fetch of `branch` from `remote` lands on. */
async function remoteHeadCommit(
  repoDir: string,
  remote: string,
  branch: string,
): Promise<string> {
  try {
    await git(repoDir, ["fetch", remote, branch]);
    const out = await git(repoDir, ["rev-parse", "FETCH_HEAD"]);
    const commit = out.trim().split(/\s+/)[0] ?? "";
    if (!COMMIT_RE.test(commit)) throw new Error(`FETCH_HEAD is ${commit}`);
    return commit;
  } catch (err) {
    throw new IntakeError(
      "fetch-failed",
      `cannot fetch ${JSON.stringify(branch)} from ${JSON.stringify(remote)}: ${firstLine((err as Error).message)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

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
    const recorded = readRecordedMeta(metaPath, `${shown}/meta.json`);
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
  const branch = await remoteDefaultBranch(repoDir, options.remote);
  const commit = await remoteHeadCommit(repoDir, options.remote, branch);

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
  fs.mkdirSync(sourceDir, { recursive: true });
  if (options.raw) {
    fs.writeFileSync(path.join(sourceDir, "ticket.md"), bytes);
  }
  fs.writeFileSync(path.join(sourceDir, "meta.json"), serializeMeta(meta));
  return { stdout: "", exitCode: 0 };
}
