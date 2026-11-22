import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
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

describe("spec-gate CLI", () => {
  it("--version prints the package.json version and exits 0", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
  });

  it("--help exits 0 and names the program", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Usage: ${pkg.name}`);
  });

  it("an unknown option exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["--nope"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown option");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  it("an unknown command exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["frobnicate"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("too many arguments");
    expect(run.stderr).toContain("Usage: spec-gate");
  });
});
