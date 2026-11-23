/**
 * Reads from a git repository, and nothing else: `rev-parse` and
 * `cat-file`. The program is `git`, started with an argument list and no
 * shell. The package never runs anything the repository holds.
 */
import { spawnSync } from "node:child_process";
import type { CommandSet, FormatError } from "../formats/index.js";
import { parseCommandSet } from "../formats/index.js";
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

/** Throws `commands-ref-unresolvable` unless `ref` names a commit in `repo`. */
export function assertCommit(repo: string, ref: string): void {
  const run = git(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (run.status !== 0) {
    throw new DigestError(
      "commands-ref-unresolvable",
      `commands_ref ${ref} is not a commit in ${repo}`,
    );
  }
}

/**
 * The text of `.spec-gate/commands.yaml` at the commit `ref`, read from the
 * object database. The working tree and the branch heads are never read.
 */
export function readCommandsFile(repo: string, ref: string): string {
  const spec = `${ref}:${COMMANDS_PATH}`;
  const type = git(repo, ["cat-file", "-t", spec]);
  if (type.status !== 0 || type.stdout.toString("utf8").trim() !== "blob") {
    throw new DigestError(
      "commands-file-missing",
      `${COMMANDS_PATH} does not exist as a file at commands_ref ${ref}`,
      { file: COMMANDS_PATH },
    );
  }
  const blob = git(repo, ["cat-file", "blob", spec]);
  if (blob.status !== 0) {
    throw new DigestError(
      "git-failed",
      `could not read ${spec}: ${firstLine(blob.stderr)}`,
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
