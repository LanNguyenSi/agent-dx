import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../src/bundle.js";
import type { BundleContext } from "../src/types.js";

export const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CLI = path.join(PKG_ROOT, "dist", "cli.js");

export function loadFixture(name: string, repoRoot?: string): BundleContext {
  return loadBundle(path.join(FIXTURES_DIR, name), repoRoot);
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Spawns the built CLI as a real subprocess so exit codes can be asserted
// without process.exit() inside cli.ts killing the test runner. `cwd`
// defaults to this package's root; pass it explicitly to exercise
// cwd-relative behavior (e.g. `init`'s default `docs/okf` target).
export function runCli(args: string[], cwd: string = PKG_ROOT): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

/**
 * Spawns the built CLI with an explicit `TZ`, so a check's verdict can be
 * compared across two machine timezones inside one test run.
 *
 * A SUBPROCESS is the only form that actually works here: Node resolves the
 * process timezone once and caches it, so assigning `process.env.TZ` inside
 * the already-running test process leaves `Date.parse`'s local-time
 * interpretation on whatever zone the runner started in -- a test written
 * that way would pass under every `TZ` without ever exercising a second
 * one.
 */
export function runCliWithTz(args: string[], tz: string): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    if (typeof e.stdout !== "string") throw err;
    return {
      status: e.status ?? 1,
      stdout: e.stdout,
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

export const CLI_PATH = CLI;
