/**
 * Test helpers: bounded child processes and deterministic git fixtures.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program in its own process group and kills the whole group when
 * `timeoutMs` has passed, so nothing it started outlives the test.
 */
export function runBounded(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<Run> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the group is already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      killGroup();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Anything the child left in its group goes too.
      killGroup();
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** A git environment that produces the same commit object on every machine. */
function gitEnv(day: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  const date = `2000-01-${String(day).padStart(2, "0")}T00:00:00Z`;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    GIT_COMMITTER_DATE: date,
  };
}

export async function git(
  cwd: string,
  args: string[],
  day = 1,
): Promise<string> {
  const run = await runBounded(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, env: gitEnv(day), timeoutMs: 20_000 },
  );
  if (run.timedOut || run.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${run.timedOut ? "timeout" : run.code}): ${run.stderr}`,
    );
  }
  return run.stdout.trim();
}

/** One file to commit: a path in the repository and its bytes. */
export interface RepoFile {
  path: string;
  content: string | Buffer;
}

/**
 * Creates a repository with one commit per entry of `commits`; each commit
 * sets exactly the files it lists (earlier files stay). Returns the repo
 * directory and the commit ids, oldest first.
 */
export async function makeRepo(
  parent: string,
  commits: RepoFile[][],
): Promise<{ dir: string; shas: string[] }> {
  const dir = fs.mkdtempSync(path.join(parent, "repo-"));
  await git(dir, ["init", "-q"]);
  const shas: string[] = [];
  let day = 1;
  for (const files of commits) {
    for (const f of files) {
      const target = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    await git(dir, ["add", "-A"], day);
    await git(dir, ["commit", "-q", "--allow-empty", "-m", "commands"], day);
    shas.push(await git(dir, ["rev-parse", "HEAD"], day));
    day += 1;
  }
  return { dir, shas };
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const COMMANDS_FILE = ".spec-gate/commands.yaml";
