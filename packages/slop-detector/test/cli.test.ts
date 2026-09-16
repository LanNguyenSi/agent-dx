import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Exercises the real CLI end to end: `node --import tsx src/cli.ts`,
// not the built `dist/cli.js`, so the suite doesn't depend on a prior
// `npm run build` having run. `--import tsx` is the same mechanism the
// package's own `npm run dev` script already uses.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(packageRoot, "src", "cli.ts");

function runCli(
  args: string[],
  opts: { input?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    {
      cwd: packageRoot,
      input: opts.input ?? "",
      encoding: "utf8",
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cli-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cli check [paths...]", () => {
  it("scans two positional paths, both counted", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "F1 landed in review round 2.\n");
    fs.writeFileSync(path.join(tmp, "b.md"), "F2a fixed per review.\n");
    const { stdout, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      path.join(tmp, "b.md"),
      "--pack",
      "review-slop",
    ]);
    expect(stdout).toMatch(/2 files scanned/);
    expect(stdout).toContain("F1");
    expect(stdout).toContain("F2a");
    expect(status).toBe(1); // block findings present
  });

  it("scans two positional paths when --pack comes first (pack-first ordering)", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "F1 landed in review round 2.\n");
    fs.writeFileSync(path.join(tmp, "b.md"), "F2a fixed per review.\n");
    const { stdout, status } = runCli([
      "check",
      "--pack",
      "review-slop",
      path.join(tmp, "a.md"),
      path.join(tmp, "b.md"),
    ]);
    expect(stdout).toMatch(/2 files scanned/);
    expect(stdout).toContain("F1");
    expect(stdout).toContain("F2a");
    expect(status).toBe(1);
  });

  it("a single positional path still works (pre-existing behavior)", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "no tokens here.\n");
    const { stdout, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      "--pack",
      "review-slop",
    ]);
    expect(stdout).toMatch(/1 files scanned/);
    expect(status).toBe(0);
  });

  it("errors with exit 2 when --stdin-path is given alongside a real path", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "no tokens here.\n");
    const { stderr, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      "--stdin-path",
      "COMMIT_MSG",
      "--pack",
      "review-slop",
    ]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--stdin-path only applies when reading stdin/);
  });

  it("reads stdin and scans it when no path is given", () => {
    const { stdout, status } = runCli(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      { input: "Fixes F1 and F2a from review round 2.\n" },
    );
    expect(stdout).toMatch(/1 files scanned/);
    expect(stdout).toContain("F1");
    expect(status).toBe(1);
  });
});
