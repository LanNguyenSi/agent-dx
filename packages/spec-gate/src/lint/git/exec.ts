/**
 * The one place the lint starts `git`: argument list, no shell, a scrubbed
 * environment, a timeout and an output cap. The caller gets the exit status
 * and stdout; git's stderr, the argument list and every path stay inside
 * this file, so no message built from a failure can leak them.
 */
import { spawnSync } from "node:child_process";
import {
  applyGitSwitches,
  gitConfigOverrides,
} from "../../canonical/git-hardening.js";

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
 * repository), plus switches that keep the read local and exact (no replace
 * refs, no lazy fetch, no grafts).
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  applyGitSwitches(env);
  return env;
}

export interface GitRun {
  status: number;
  stdout: Buffer;
}

/**
 * Runs `git -C <cwd> <config overrides> <args>`; `timeoutMs` is the default
 * except in a test that proves the time limit. A git that cannot start, does
 * not finish in time, is stopped by a signal or writes more than the cap is
 * a `LintGitError`; a non-zero exit is not: the caller decides what an exit
 * status means for its question. A signal never becomes an exit status: a
 * killed `merge-base --is-ancestor` must not read as "not an ancestor".
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): GitRun {
  const run = spawnSync("git", ["-C", cwd, ...gitConfigOverrides(), ...args], {
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
  if (run.status === null) {
    throw new LintGitError("git-failed", "git was stopped before it finished");
  }
  return { status: run.status, stdout: run.stdout };
}
