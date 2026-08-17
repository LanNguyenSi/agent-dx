// Spawns the built CLI as a real subprocess (against dist/cli.js) so exit
// codes and stderr can be asserted without process.exit() inside cli.ts
// killing the test runner. Mirrors the pattern in
// packages/okf-kit/test/helpers.ts (execFileSync against dist/cli.js) and
// packages/orchestrator-workflow/test/init.test.ts (spawnSync). Requires a
// build (`npm run build`) to have run first; wired up via the `pretest`
// script in package.json so `npm test` alone is sufficient.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "dist", "cli.js");
const FIXTURES_DIR = join(PKG_ROOT, "test", "fixtures");
const FAULT_TOLERANT_DIR = join(FIXTURES_DIR, "fault-tolerant");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("mcp-token-audit cli", () => {
  it("exits 2 with a stderr message on an invalid --days value", () => {
    const result = runCli([FIXTURES_DIR, "--days", "not-a-number"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'mcp-token-audit: --days expects a positive number, got "not-a-number"',
    );
    expect(result.stdout).toBe("");
  });

  it("exits 0 and emits parsable --json output with the known fixture totals", () => {
    const result = runCli([FIXTURES_DIR, "--json"]);
    expect(result.status, result.stderr).toBe(0);

    const parsed = JSON.parse(result.stdout);
    // Same fixture (test/fixtures/sample.jsonl) and hand-verified totals as
    // test/render.test.ts's toJsonOutput test.
    expect(parsed.filesScanned).toBe(1);
    expect(parsed.skippedLines).toBe(1);
    expect(parsed.skippedFiles).toBe(0);
    expect(parsed.totals).toEqual({ calls: 4, tokIn: 17, tokOut: 10, tok: 27 });
    expect(parsed.mcp).toEqual({
      calls: 2,
      tokIn: 8,
      tokOut: 3,
      tok: 11,
      pctOfTotal: 40.74,
    });
  });

  it("runs to completion on a transcript with a bare-null line and a non-array message.content, instead of crashing the whole run", () => {
    // Regression coverage for the aggregate.ts fault-tolerance fix: both
    // lines are valid JSON but the wrong shape (see
    // test/fixtures/fault-tolerant/session.jsonl and
    // test/aggregate.test.ts). Before the fix, either line threw and took
    // the entire CLI process down instead of exiting cleanly.
    const result = runCli([FAULT_TOLERANT_DIR, "--json"]);
    expect(result.status, result.stderr).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.filesScanned).toBe(1);
    expect(parsed.skippedLines).toBe(0); // both malformed-shape lines are valid JSON
    expect(parsed.skippedFiles).toBe(0);
    expect(parsed.tools).toEqual([
      { tool: "Bash", calls: 1, tokIn: 4, tokOut: 3, tokPerCall: 7 },
    ]);
    expect(parsed.totals).toEqual({ calls: 1, tokIn: 4, tokOut: 3, tok: 7 });
  });
});
