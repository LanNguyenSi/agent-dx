/**
 * The one place the lint starts `git`: argument list, no shell, a scrubbed
 * environment, a timeout and an output cap. The caller gets the exit status
 * and stdout; git's stderr, the argument list and every path stay inside
 * this file, so no message built from a failure can leak them.
 */
import { spawnSync } from "node:child_process";

export const GIT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type LintGitCode =
  | "git-failed"
  | "output-too-large"
  | "ref-invalid"
  | "ref-unresolvable"
  | "not-a-commit"
  | "no-merge-base"
  | "path-invalid"
  | "path-missing"
  | "path-not-regular"
  | "path-not-utf8"
  | "object-unreadable";

/**
 * A failed git read. `message` is fixed text per code: it never holds git's
 * stderr, an argument or a path, so it may go into a finding as it is.
 */
export class LintGitError extends Error {
  readonly code: LintGitCode;

  constructor(code: LintGitCode, message: string) {
    super(message);
    this.name = "LintGitError";
    this.code = code;
  }
}

/**
 * The environment of a git call: the caller's, without any `GIT_*`
 * variable (a leaked `GIT_DIR` would point the call at another
 * repository), plus switches that keep the read local and exact.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  // A replace ref must not swap the content of the object an id names.
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  // A partial clone must not fetch from the network during a read.
  env["GIT_NO_LAZY_FETCH"] = "1";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  return env;
}

export interface GitRun {
  status: number;
  stdout: Buffer;
}

/**
 * Runs `git -C <cwd> <args>`; `timeoutMs` is the default except in a test
 * that proves the time limit. A git that cannot start, does not finish in
 * time or writes more than the cap is a `LintGitError`; a non-zero exit is
 * not: the caller decides what an exit status means for its question.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): GitRun {
  const run = spawnSync("git", ["-C", cwd, ...args], {
    env: gitEnv(),
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code;
    if (code === "ENOBUFS") {
      throw new LintGitError(
        "output-too-large",
        "git wrote more than the lint reads",
      );
    }
    throw new LintGitError(
      "git-failed",
      "git could not be run or did not finish in time",
    );
  }
  return { status: run.status ?? 1, stdout: run.stdout };
}
