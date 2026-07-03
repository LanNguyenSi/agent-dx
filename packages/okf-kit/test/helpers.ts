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
// without process.exit() inside cli.ts killing the test runner.
export function runCli(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}
