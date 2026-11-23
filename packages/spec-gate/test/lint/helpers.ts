/**
 * Test helpers for the lint suites: a complete valid spec directory that
 * tests copy and then break one file of, and the built CLI runner.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach } from "vitest";

const execFileAsync = promisify(execFile);

export const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
export const VALID_SPEC_DIR = path.join(FIXTURES, "lint-valid", "pos", "spec");
const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function walk(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      Object.assign(out, walk(path.join(dir, entry.name), rel));
    else out[rel] = fs.readFileSync(path.join(dir, entry.name), "utf8");
  }
  return out;
}

/** The files of the valid spec directory, by relative path. */
export function validFiles(): Record<string, string> {
  return walk(VALID_SPEC_DIR);
}

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch directory under the OS temp dir, removed after the test. */
export function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-lint-"));
  roots.push(dir);
  return dir;
}

/**
 * A spec directory with the valid files, `overrides` applied: a string
 * replaces or adds a file, `null` removes it.
 */
export function specDir(overrides: Record<string, string | null> = {}): string {
  const dir = scratch();
  const files = { ...validFiles(), ...overrides };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

/** The text of one valid file with `old` replaced by `next`; throws when `old` is absent. */
export function edited(name: string, old: string, next: string): string {
  const text = validFiles()[name]!;
  if (!text.includes(old)) throw new Error(`${name} does not contain ${old}`);
  return text.replace(old, next);
}
