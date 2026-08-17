import { describe, expect, it } from "vitest";
import { auditFiles } from "../src/audit.js";
import { renderText, toJsonOutput } from "../src/render.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.jsonl",
);

// Token math (chars/4, Math.round), built on the per-tool char totals
// verified in test/audit.test.ts:
//   Bash:          charsIn 37 -> tokIn 9  (9.25),  charsOut 27 -> tokOut 7  (6.75)
//   tasks_list:    charsIn 28 -> tokIn 7  (7.00),  charsOut 13 -> tokOut 3  (3.25)
//   tasks_get:     charsIn 2  -> tokIn 1  (0.5 rounds up), charsOut 0 -> tokOut 0
// totals:  charsIn 67 -> tokIn 17 (16.75), charsOut 40 -> tokOut 10 (10.00) -> tok 27
// mcp sum: charsIn 30 -> tokIn 8  (7.5 rounds up),  charsOut 13 -> tokOut 3 -> tok 11
// pctOfTotal = 11 / 27 * 100 = 40.7407...  -> rounded to 2dp = 40.74

describe("toJsonOutput", () => {
  it("matches the hand-verified token totals and mcp share", () => {
    const result = auditFiles([FIXTURE_PATH]);
    const out = toJsonOutput(result);

    expect(out.tools).toEqual([
      { tool: "Bash", calls: 2, tokIn: 9, tokOut: 7, tokPerCall: 8 },
      {
        tool: "mcp__agent-tasks__tasks_list",
        calls: 1,
        tokIn: 7,
        tokOut: 3,
        tokPerCall: 10,
      },
      {
        tool: "mcp__agent-tasks__tasks_get",
        calls: 1,
        tokIn: 1,
        tokOut: 0,
        tokPerCall: 1,
      },
    ]);
    expect(out.totals).toEqual({ calls: 4, tokIn: 17, tokOut: 10, tok: 27 });
    expect(out.mcp).toEqual({
      calls: 2,
      tokIn: 8,
      tokOut: 3,
      tok: 11,
      pctOfTotal: 40.74,
    });
    expect(out.filesScanned).toBe(1);
    expect(out.skippedLines).toBe(1);
  });

  it("reports 0% mcp share when there are no tool calls at all", () => {
    const out = toJsonOutput({
      perTool: [],
      totals: { calls: 0, charsIn: 0, charsOut: 0 },
      mcpTotals: { calls: 0, charsIn: 0, charsOut: 0 },
      skippedLines: 0,
      filesScanned: 0,
    });
    expect(out.mcp.pctOfTotal).toBe(0);
  });
});

describe("renderText", () => {
  it("renders a header, one row per tool ranked desc, and the totals/mcp summary lines", () => {
    const result = auditFiles([FIXTURE_PATH]);
    const text = renderText(result);

    const lines = text.trim().split("\n");
    expect(lines[0]).toMatch(
      /^tool\s+calls\s+~tok_in\s+~tok_out\s+~tok\/call$/,
    );
    // Ranked Bash, tasks_list, tasks_get (see toJsonOutput test above).
    expect(lines[1]).toContain("Bash");
    expect(lines[2]).toContain("mcp__agent-tasks__tasks_list");
    expect(lines[3]).toContain("mcp__agent-tasks__tasks_get");

    expect(text).toContain("total: 4 calls, ~17 tok in, ~10 tok out, ~27 tok");
    expect(text).toContain("mcp__*: 2 calls, ~11 tok (40.7% of total)");
    expect(text).toContain("skipped 1 malformed line(s)");
    expect(text).toContain("1 transcript file(s) scanned");
  });

  it("prints a no-calls line when nothing was found", () => {
    const text = renderText({
      perTool: [],
      totals: { calls: 0, charsIn: 0, charsOut: 0 },
      mcpTotals: { calls: 0, charsIn: 0, charsOut: 0 },
      skippedLines: 0,
      filesScanned: 0,
    });
    expect(text).toContain("mcp-token-audit: no tool calls found");
  });
});
