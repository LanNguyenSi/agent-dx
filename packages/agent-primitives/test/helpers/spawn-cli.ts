import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * CLI tests never depend on the host beyond four binaries: node, npm, git
 * and sh.
 *
 * Every CLI test spawns through this helper, and the helper hands the
 * child an environment built from scratch: PATH is a single directory of
 * symlinks to exactly those four resolved binaries, TMPDIR is a fresh
 * directory, and nothing else is inherited (no AGENT_PRIMITIVES_* variable
 * from the developer's shell, no ripgrep or jq that happens to sit on the
 * host, no ambient log directory). Three rounds of review found host
 * coupling in these tests -- ripgrep assumed present, a `printf` escape
 * only bash understands, a timing assumption that held only on a long
 * PATH -- and each was fixed one test at a time; the environment being
 * fixed here instead is what stops the class.
 *
 * The helper also takes no timing arguments and contains no sleeps:
 * listeners are attached before the function returns, so a child that has
 * already exited by the time a caller awaits still delivers its full
 * output.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CLI_PATH = path.join(__dirname, "..", "..", "dist", "cli.js");

/** The only binaries a spawned CLI can see. */
export const FIXED_BINARIES = ["git", "node", "npm", "sh"] as const;

/**
 * Absolute, symlink-resolved location of `name`, looked up once, here, on
 * the ambient PATH. This is the single place where the host is consulted
 * at all; everything downstream sees only the fixed directory built from
 * these results.
 */
export function resolveBinary(name: string): string | undefined {
  if (name === "node") return fs.realpathSync(process.execPath);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      continue;
    }
  }
  // POSIX guarantees the shell at this path even on a host whose PATH does
  // not name it.
  if (name === "sh" && fs.existsSync("/bin/sh")) return "/bin/sh";
  return undefined;
}

function makeFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-env-"));
  process.on("exit", () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const FIXTURE_ROOT = makeFixtureRoot();

/** The one directory on a spawned CLI's PATH. */
export const FIXED_BIN_DIR = path.join(FIXTURE_ROOT, "bin");
/** The one temp directory a spawned CLI writes into. */
export const FIXED_TMPDIR = path.join(FIXTURE_ROOT, "tmp");

fs.mkdirSync(FIXED_BIN_DIR, { recursive: true });
fs.mkdirSync(FIXED_TMPDIR, { recursive: true });

for (const name of FIXED_BINARIES) {
  const resolved = resolveBinary(name);
  if (!resolved) {
    throw new Error(
      `spawn-cli helper: required binary "${name}" not found on PATH; CLI tests need exactly ${FIXED_BINARIES.join(", ")}`,
    );
  }
  fs.symlinkSync(resolved, path.join(FIXED_BIN_DIR, name));
}

/**
 * Environment handed to every spawned CLI. Built from scratch rather than
 * spread over `process.env`, so nothing about the developer's or the
 * runner's shell can reach the child.
 */
export function buildSpawnEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: FIXED_BIN_DIR,
    TMPDIR: FIXED_TMPDIR,
    ...overrides,
  };
}

export interface CliRun {
  /** The CLI process's own exit code, never a pipeline's or a shell's. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** A spawned CLI: stdin closed, stdout and stderr piped. */
type PipedCli = ChildProcessByStdio<null, Readable, Readable>;

/** Spawns the built CLI with the fixed environment and resolves, on the
 * child's own `close`, with its full stdout, full stderr, and its own exit
 * code. */
export function spawnCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CliRun> {
  const child = spawnCliRaw(args, options);
  return collect(child);
}

/** The same spawn, handing back the live child instead of a promise. */
function spawnCliRaw(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): PipedCli {
  return spawn(process.execPath, [CLI_PATH, ...args], {
    env: buildSpawnEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Attaches every listener before returning (nothing here awaits first),
 * so the result is complete whether the child is still running or has
 * already exited. */
function collect(child: PipedCli): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
