import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateEntries,
  charsToTokens,
  parseTranscript,
} from "../src/aggregate.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.jsonl",
);

describe("charsToTokens", () => {
  it("approximates chars/4, rounded to the nearest integer", () => {
    expect(charsToTokens(0)).toBe(0);
    expect(charsToTokens(2)).toBe(1); // 0.5 rounds up
    expect(charsToTokens(37)).toBe(9); // 9.25 rounds down
    expect(charsToTokens(30)).toBe(8); // 7.5 rounds up
  });
});

describe("parseTranscript", () => {
  it("skips blank lines silently and malformed JSON lines with a count", () => {
    const raw = [
      '{"type":"user"}',
      "",
      "  ",
      "{not json}",
      '{"type":"assistant"}',
    ].join("\n");
    const { entries, skipped } = parseTranscript(raw);
    expect(entries).toHaveLength(2);
    expect(skipped).toBe(1);
  });
});

describe("aggregateEntries against test/fixtures/sample.jsonl", () => {
  // Fixture content (9 lines): a text-only assistant entry (ignored, no
  // tool blocks), three tool_use/tool_result pairs, one malformed line,
  // and one unmatched tool_use (no tool_result ever arrives for it).
  //
  // Hand-computed char counts (chars = JSON.stringify(input).length for
  // tok_in, stringified tool_result content .length for tok_out):
  //
  // tu1 Bash    input {"command":"ls -la"}         -> JSON.stringify = 20 chars
  //             result "file1\nfile2\nfile3"        -> string, 17 chars
  // tu2 mcp__agent-tasks__tasks_list
  //             input {"status":"open","limit":50} -> JSON.stringify = 28 chars
  //             result [{"type":"text","text":"5 tasks found"}]
  //                    -> text block -> "5 tasks found" = 13 chars
  // tu3 Bash    input {"command":"pwd"}             -> JSON.stringify = 17 chars
  //             result "/home/user"                 -> string, 10 chars
  // tu4 mcp__agent-tasks__tasks_get
  //             input {}                            -> JSON.stringify = 2 chars
  //             result: none (no tool_result for tu4) -> 0 chars
  //
  // Per tool (Bash gets both tu1 and tu3):
  //   Bash:   calls 2, charsIn  20+17=37, charsOut 17+10=27
  //   mcp__agent-tasks__tasks_list: calls 1, charsIn 28, charsOut 13
  //   mcp__agent-tasks__tasks_get:  calls 1, charsIn 2,  charsOut 0

  it("pairs tool_use/tool_result by id and aggregates chars per tool", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf8");
    const { entries, skipped } = parseTranscript(raw);
    expect(skipped).toBe(1); // the "{not valid json, ...}" line

    const perTool = aggregateEntries(entries);
    expect(perTool.size).toBe(3);

    expect(perTool.get("Bash")).toEqual({
      tool: "Bash",
      calls: 2,
      charsIn: 37,
      charsOut: 27,
    });
    expect(perTool.get("mcp__agent-tasks__tasks_list")).toEqual({
      tool: "mcp__agent-tasks__tasks_list",
      calls: 1,
      charsIn: 28,
      charsOut: 13,
    });
    // Unmatched tool_use (tu4): still counted as a call, charsOut stays 0.
    expect(perTool.get("mcp__agent-tasks__tasks_get")).toEqual({
      tool: "mcp__agent-tasks__tasks_get",
      calls: 1,
      charsIn: 2,
      charsOut: 0,
    });
  });
});
