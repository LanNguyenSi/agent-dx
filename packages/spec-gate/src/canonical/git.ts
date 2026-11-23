/**
 * Reads from a git repository, and nothing else: `rev-parse`, `cat-file`
 * and `ls-tree`. The program is `git`, started with an argument list and no
 * shell. The package never runs anything the repository holds.
 */
import { spawnSync } from "node:child_process";
import type { CommandSet, FormatError } from "../formats/index.js";
import { parseCommandSet } from "../formats/index.js";
import { COMMIT_RE } from "../formats/validate.js";
import { DigestError } from "./errors.js";

/** The one path in the repository the digest reads, at `commands_ref`. */
export const COMMANDS_PATH = ".spec-gate/commands.yaml";

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface GitRun {
  status: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * The environment of a git call: the caller's, without any `GIT_*`
 * variable (a leaked `GIT_DIR` would point the call at another
 * repository), plus switches that keep the read local and exact.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  // A replace ref must not swap the content of the object a sha names.
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  // A partial clone must not fetch from the network during a read.
  env["GIT_NO_LAZY_FETCH"] = "1";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  return env;
}

function git(cwd: string, args: string[]): GitRun {
  const run = spawnSync("git", ["-C", cwd, ...args], {
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code;
    const why =
      code === "ENOENT"
        ? "git is not installed or not on PATH"
        : code === "ETIMEDOUT"
          ? `git did not finish within ${GIT_TIMEOUT_MS / 1000} seconds`
          : code === "ENOBUFS"
            ? `git wrote more than ${MAX_OUTPUT_BYTES} bytes, which is more than the digest reads`
            : run.error.message;
    throw new DigestError("git-failed", why);
  }
  return {
    status: run.status ?? 1,
    stdout: run.stdout,
    stderr: run.stderr.toString("utf8").trim(),
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** The top level of the work tree that holds `dir`. */
export function repoToplevel(dir: string): string {
  const run = git(dir, ["rev-parse", "--show-toplevel"]);
  const top = run.stdout.toString("utf8").trim();
  if (run.status !== 0 || top === "") {
    throw new DigestError(
      "repo-not-found",
      `${dir} is not inside a git work tree (${firstLine(run.stderr) || "no top level"}); pass --repo <path>`,
    );
  }
  return top;
}

/** Throws unless `repo` is a git repository. */
export function assertRepo(repo: string): void {
  const run = git(repo, ["rev-parse", "--git-dir"]);
  if (run.status !== 0) {
    throw new DigestError(
      "repo-invalid",
      `${repo} is not a git repository (${firstLine(run.stderr) || "git refused it"})`,
    );
  }
}

/**
 * Throws `commands-ref-unresolvable` unless `ref` is a full commit id:
 * 40 or 64 lower-case hex digits. A branch name, `HEAD` or a tag name moves
 * and would give the digest an input that is not fixed.
 */
function requireCommitId(ref: string): void {
  if (!COMMIT_RE.test(ref)) {
    throw new DigestError(
      "commands-ref-unresolvable",
      `commands_ref ${JSON.stringify(ref)} is not a full commit id (40 or 64 lower-case hex digits)`,
    );
  }
}

/**
 * Throws `commands-ref-unresolvable` unless `ref` is the id of a commit
 * object in `repo`. The id of an annotated tag is refused: it names the tag
 * object, not the commit.
 */
export function assertCommit(repo: string, ref: string): void {
  requireCommitId(ref);
  // A failed `cat-file` writes nothing to stdout, so the type test covers it.
  const run = git(repo, ["cat-file", "-t", ref]);
  if (run.stdout.toString("utf8").trim() !== "commit") {
    throw new DigestError(
      "commands-ref-unresolvable",
      `commands_ref ${ref} is not a commit available in ${repo}`,
    );
  }
  // The type check alone accepts an abbreviation that git resolves, such as
  // a 40-digit prefix in a SHA-256 repository: the id must be the full id of
  // the repository's own object format.
  const full = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (full.status !== 0 || full.stdout.toString("utf8").trim() !== ref) {
    throw new DigestError(
      "commands-ref-unresolvable",
      `commands_ref ${ref} is not the full commit id in the object format of ${repo}`,
    );
  }
}

/** The modes of a regular file in a git tree. */
const FILE_MODES = new Set(["100644", "100755"]);

/**
 * The object id of the blob that holds `.spec-gate/commands.yaml` in the
 * tree of the commit `ref`, looked up from the top of the repository however
 * `repo` is spelled (`--full-tree`). The entry must be a regular file (mode 100644
 * or 100755): a link would bind the text of the link, not the file it
 * points at, and a submodule or a tree is not a file at all.
 */
function commandsBlobId(repo: string, ref: string): string {
  const run = git(repo, [
    "ls-tree",
    "-z",
    "--full-tree",
    ref,
    "--",
    COMMANDS_PATH,
  ]);
  if (run.status !== 0) {
    throw new DigestError(
      "git-failed",
      `could not read the tree of ${ref} (${firstLine(run.stderr) || "git refused it"}); the object may not be available locally, and the digest never fetches`,
    );
  }
  const entries = run.stdout
    .toString("utf8")
    .split("\0")
    .filter((e) => e !== "");
  const missing = () =>
    new DigestError(
      "commands-file-missing",
      `${COMMANDS_PATH} does not exist as a file at commands_ref ${ref}`,
      { file: COMMANDS_PATH },
    );
  if (entries.length !== 1) throw missing();
  const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t/.exec(entries[0]!);
  if (!m) {
    throw new DigestError(
      "git-failed",
      `git ls-tree wrote an entry the digest does not understand for ${COMMANDS_PATH} at ${ref}`,
    );
  }
  // Mode 100644 and 100755 are always blobs; a link, a submodule and a tree
  // have other modes.
  if (!FILE_MODES.has(m[1]!)) {
    throw new DigestError(
      "commands-file-missing",
      `${COMMANDS_PATH} at commands_ref ${ref} is not a regular file (git mode ${m[1]}, type ${m[2]}); a link, a submodule and a directory are refused`,
      { file: COMMANDS_PATH },
    );
  }
  return m[3]!;
}

/**
 * The text of `.spec-gate/commands.yaml` at the commit `ref`, read from the
 * object database. The working tree and the branch heads are never read.
 */
export function readCommandsFile(repo: string, ref: string): string {
  assertCommit(repo, ref);
  const blobId = commandsBlobId(repo, ref);
  const blob = git(repo, ["cat-file", "blob", blobId]);
  if (blob.status !== 0) {
    throw new DigestError(
      "git-failed",
      `could not read ${COMMANDS_PATH} at ${ref} (${firstLine(blob.stderr) || "git refused it"}); the object may not be available locally, and the digest never fetches`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob.stdout);
  } catch {
    throw new DigestError(
      "commands-file-invalid",
      `${COMMANDS_PATH} at commands_ref ${ref} is not valid UTF-8`,
      { file: COMMANDS_PATH },
    );
  }
}

/** Parses the commands file at `ref`; a format error is a `commands-file-invalid`. */
export function readCommandSet(repo: string, ref: string): CommandSet {
  const text = readCommandsFile(repo, ref);
  const parsed = parseCommandSet(text);
  if (!parsed.ok) {
    throw new DigestError(
      "commands-file-invalid",
      `${COMMANDS_PATH} at commands_ref ${ref} is not valid`,
      { file: COMMANDS_PATH, formatErrors: parsed.errors as FormatError[] },
    );
  }
  return parsed.value;
}
