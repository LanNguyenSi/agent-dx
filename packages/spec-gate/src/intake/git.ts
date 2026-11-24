/**
 * The git calls of intake: argv only, never a shell, a scrubbed environment,
 * stdin ignored, `-C <repoDir>`, each call in its own process group with a
 * timeout that kills the whole group. No message built here carries an argv,
 * git's own stderr or a URL: a configured remote URL can hold credentials.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyGitSwitches,
  gitConfigOverrides,
} from "../canonical/git-hardening.js";
import { IntakeError } from "./errors.js";

/** Every `git` call gets this timeout, in milliseconds. */
export const GIT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * The environment of a git call: the caller's, without any `GIT_*` variable
 * (a leaked `GIT_DIR` would point the call at another repository, a leaked
 * `GIT_CONFIG_PARAMETERS` would rewrite a remote URL), plus switches that keep
 * the call non-interactive and exact (no replace refs, no lazy fetch, no
 * grafts).
 */
export function gitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  applyGitSwitches(env, { fetching: true });
  return env;
}

export type ProcessFailureKind = "spawn" | "timeout" | "output" | "signal";

/** A process that could not run to completion; `kind` says why. */
export class ProcessFailure extends Error {
  readonly kind: ProcessFailureKind;
  constructor(kind: ProcessFailureKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ProcessFailure";
  }
}

export interface ProcessRun {
  status: number;
  stdout: string;
}

export interface ProcessOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Runs `program` with an argument list and no shell, stdin ignored, in a
 * process group of its own. On a timeout or an oversized output the whole
 * group gets SIGKILL, so a grandchild cannot outlive the call. stderr is
 * drained and dropped.
 */
export function runProcess(
  program: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessRun> {
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      killGroup(child.pid);
      settle(() =>
        reject(
          new ProcessFailure(
            "timeout",
            `${program} did not finish within ${options.timeoutMs / 1000} seconds`,
          ),
        ),
      );
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        killGroup(child.pid);
        settle(() =>
          reject(
            new ProcessFailure("output", `${program} printed too much output`),
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          new ProcessFailure(
            "spawn",
            err.code === "ENOENT"
              ? `${program} is not installed or not on PATH`
              : `${program} could not be started (${err.code ?? "unknown error"})`,
          ),
        ),
      );
    });
    child.on("close", (code) => {
      settle(() => {
        if (code === null) {
          // A signal is not an exit status: it must not read as a refusal.
          reject(
            new ProcessFailure(
              "signal",
              `${program} was stopped before it finished`,
            ),
          );
          return;
        }
        resolve({
          status: code,
          stdout: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
  });
}

/**
 * One git call in `repoDir`; a failure to run is a `ProcessFailure`. The
 * calls carry the overrides every git call of the package carries, except
 * `protocol.allow=never`: intake fetches from the remote on purpose.
 */
export function runGit(
  repoDir: string,
  args: readonly string[],
): Promise<ProcessRun> {
  const overrides = gitConfigOverrides({ network: true });
  return runProcess("git", ["-C", repoDir, ...overrides, ...args], {
    env: gitEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
  });
}

/** Runs git and returns stdout, or null on a non-zero status or any failure. */
async function gitOrNull(
  repoDir: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const run = await runGit(repoDir, args);
    return run.status === 0 ? run.stdout : null;
  } catch {
    return null;
  }
}

/** Why a git call failed, without argv, stderr or any URL. */
function failureReason(err: unknown): string {
  return err instanceof ProcessFailure ? err.message : "git did not run";
}

/** The git toplevel of `cwd`, or a `no-git-toplevel` error. */
export async function gitToplevel(cwd: string): Promise<string> {
  const out = await gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  const toplevel = out?.trim() ?? "";
  if (toplevel === "") {
    throw new IntakeError(
      "no-git-toplevel",
      "the current directory is not inside a git repository; pass --repo",
    );
  }
  return toplevel;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/**
 * The remote must be the plain name of a configured remote: never a URL, a
 * path, `.`, or anything git could read as an option. Refused values are not
 * echoed.
 */
export async function requireConfiguredRemote(
  repoDir: string,
  remote: string,
): Promise<void> {
  if (!REMOTE_NAME_RE.test(remote)) {
    throw new IntakeError(
      "bad-remote",
      "--remote must be the name of a configured remote (letters, digits, '.', '_' and '-', not starting with '.' or '-'); a URL or a path is refused",
    );
  }
  const url = await gitOrNull(repoDir, [
    "config",
    "--get",
    `remote.${remote}.url`,
  ]);
  if (url === null || url.trim() === "") {
    throw new IntakeError(
      "no-remote",
      `remote ${JSON.stringify(remote)} is not configured in this repository`,
    );
  }
}

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEADS = "refs/heads/";

/**
 * The remote's default branch, read from the remote's own HEAD symref and
 * validated: it must sit under `refs/heads/`, must not start with `-` and
 * must be a valid branch name.
 */
export async function remoteDefaultBranch(
  repoDir: string,
  remote: string,
): Promise<string> {
  let out: string;
  try {
    const run = await runGit(repoDir, [
      "ls-remote",
      "--symref",
      "--end-of-options",
      remote,
      "HEAD",
    ]);
    if (run.status !== 0) {
      throw new ProcessFailure(
        "spawn",
        `git ls-remote exited with status ${run.status}`,
      );
    }
    out = run.stdout;
  } catch (err) {
    throw new IntakeError(
      "no-remote",
      `remote ${JSON.stringify(remote)} cannot be read: ${failureReason(err)}`,
    );
  }
  const m = /^ref:\s+(\S+)\s+HEAD\s*$/m.exec(out);
  if (!m) {
    throw new IntakeError(
      "no-default-branch",
      `remote ${JSON.stringify(remote)} names no default branch`,
    );
  }
  const target = m[1]!;
  const branch = target.startsWith(HEADS) ? target.slice(HEADS.length) : "";
  const named =
    branch !== "" && !branch.startsWith("-")
      ? await gitOrNull(repoDir, ["check-ref-format", "--branch", branch])
      : null;
  if (named === null || named.trim() !== branch) {
    throw new IntakeError(
      "bad-default-branch",
      `the HEAD of remote ${JSON.stringify(remote)} does not name a branch under ${HEADS}; refused`,
    );
  }
  return branch;
}

/**
 * The commit id in the content of a FETCH_HEAD written by a fetch of
 * `refs/heads/<branch>`: exactly one entry, for-merge, that describes this
 * branch.
 */
export function parseFetchHead(content: string, branch: string): string {
  const failed = (why: string): IntakeError =>
    new IntakeError(
      "fetch-failed",
      `cannot fetch ${JSON.stringify(branch)}: ${why}`,
    );
  const entries = content.split("\n").filter((l) => l !== "");
  if (entries.length !== 1) {
    throw failed(`FETCH_HEAD holds ${entries.length} entries, expected one`);
  }
  const [sha = "", mergeFlag = "", description = ""] = entries[0]!.split("\t");
  if (!COMMIT_RE.test(sha)) throw failed("FETCH_HEAD holds no commit id");
  if (mergeFlag !== "") throw failed("FETCH_HEAD entry is not for merge");
  if (!description.startsWith(`branch '${branch}' of `)) {
    throw failed("FETCH_HEAD does not describe the requested branch");
  }
  return sha;
}

/**
 * The commit at the head of `refs/heads/<branch>` on `remote`. Only the full
 * ref name is fetched, so a tag of the same name cannot be picked; no local
 * ref is written, no tag is fetched, nothing is pruned; the sha is taken from
 * the one line FETCH_HEAD holds and peeled to a commit. `--write-fetch-head`
 * is passed explicitly so a repo-local `fetch.writeFetchHEAD=false` cannot
 * leave a stale FETCH_HEAD standing in for this fetch.
 */
export async function remoteHeadCommit(
  repoDir: string,
  remote: string,
  branch: string,
): Promise<string> {
  const failed = (why: string): IntakeError =>
    new IntakeError(
      "fetch-failed",
      `cannot fetch ${JSON.stringify(branch)} from ${JSON.stringify(remote)}: ${why}`,
    );
  let fetchHead: string;
  try {
    const fetched = await runGit(repoDir, [
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-prune",
      "--refmap=",
      "--write-fetch-head",
      "--end-of-options",
      remote,
      `${HEADS}${branch}`,
    ]);
    if (fetched.status !== 0) {
      throw failed(`git fetch exited with status ${fetched.status}`);
    }
    const where = await runGit(repoDir, [
      "rev-parse",
      "--git-path",
      "FETCH_HEAD",
    ]);
    if (where.status !== 0) throw failed("FETCH_HEAD cannot be located");
    try {
      fetchHead = fs.readFileSync(
        path.resolve(repoDir, where.stdout.trim()),
        "utf8",
      );
    } catch {
      throw failed("FETCH_HEAD cannot be read");
    }
  } catch (err) {
    if (err instanceof IntakeError) throw err;
    throw failed(failureReason(err));
  }
  const sha = parseFetchHead(fetchHead, branch);
  const peeled = await gitOrNull(repoDir, [
    "rev-parse",
    "--verify",
    `${sha}^{commit}`,
  ]);
  const commit = peeled?.trim() ?? "";
  if (!COMMIT_RE.test(commit)) throw failed("the fetched object is no commit");
  return commit;
}

/** The commit `base_commit` and `commands_ref` are set to. */
export async function remoteBaseCommit(
  repoDir: string,
  remote: string,
): Promise<string> {
  await requireConfiguredRemote(repoDir, remote);
  const branch = await remoteDefaultBranch(repoDir, remote);
  return remoteHeadCommit(repoDir, remote, branch);
}
