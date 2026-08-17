import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditFiles } from "../src/audit.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.jsonl",
);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-token-audit-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("auditFiles", () => {
  it("ranks tools by total chars desc and splits an mcp__* subtotal", () => {
    // See test/aggregate.test.ts for the per-tool char math this builds on:
    // Bash charsIn 37 charsOut 27 (total 64), tasks_list charsIn 28 charsOut 13
    // (total 41), tasks_get charsIn 2 charsOut 0 (total 2). So the ranking
    // is Bash, tasks_list, tasks_get.
    const result = auditFiles([FIXTURE_PATH]);

    expect(result.filesScanned).toBe(1);
    expect(result.skippedLines).toBe(1);
    expect(result.perTool.map((t) => t.tool)).toEqual([
      "Bash",
      "mcp__agent-tasks__tasks_list",
      "mcp__agent-tasks__tasks_get",
    ]);

    // totals: charsIn 37+28+2=67, charsOut 27+13+0=40, calls 2+1+1=4
    expect(result.totals).toEqual({ calls: 4, charsIn: 67, charsOut: 40 });

    // mcp subtotal: the two mcp__* tools only -> calls 2, charsIn 28+2=30,
    // charsOut 13+0=13
    expect(result.mcpTotals).toEqual({ calls: 2, charsIn: 30, charsOut: 13 });
  });

  it("merges stats across multiple files and sums skippedLines/filesScanned", () => {
    const result = auditFiles([FIXTURE_PATH, FIXTURE_PATH]);
    expect(result.filesScanned).toBe(2);
    expect(result.skippedLines).toBe(2);
    // Same fixture read twice: every per-tool count doubles.
    const bash = result.perTool.find((t) => t.tool === "Bash");
    expect(bash).toEqual({ tool: "Bash", calls: 4, charsIn: 74, charsOut: 54 });
  });

  it("skips an unreadable file without throwing, counts it in skippedFiles, and does not count it as scanned", () => {
    const missing = join(tmp, "does-not-exist.jsonl");
    const result = auditFiles([missing, FIXTURE_PATH]);
    expect(result.filesScanned).toBe(1);
    expect(result.skippedFiles).toBe(1);
    expect(result.perTool.length).toBeGreaterThan(0);
  });

  it("returns an empty result for no input files", () => {
    const result = auditFiles([]);
    expect(result.perTool).toEqual([]);
    expect(result.totals).toEqual({ calls: 0, charsIn: 0, charsOut: 0 });
    expect(result.filesScanned).toBe(0);
    expect(result.skippedLines).toBe(0);
    expect(result.skippedFiles).toBe(0);
  });

  it("tolerates a file that is entirely malformed JSONL", () => {
    const path = join(tmp, "broken.jsonl");
    writeFileSync(path, "not json at all\n{also not json\n", "utf8");
    const result = auditFiles([path]);
    expect(result.filesScanned).toBe(1);
    expect(result.skippedLines).toBe(2);
    expect(result.perTool).toEqual([]);
  });
});
