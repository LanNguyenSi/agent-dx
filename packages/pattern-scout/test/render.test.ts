import { describe, it, expect } from "vitest";
import { renderSummary } from "../src/render.js";
import type { SearchSummary } from "../src/types.js";

describe("renderSummary", () => {
  it("renders both groups, locations, and source status", () => {
    const summary: SearchSummary = {
      query: "needle",
      results: [
        {
          kind: "exemplar",
          source: "zod",
          path: "/x/a.ts",
          line: 3,
          snippet: "const a = needle;",
        },
        {
          kind: "ours",
          source: "agent-tasks",
          path: "src/b.ts",
          line: 0,
          snippet: "needle here",
        },
      ],
      exemplarCount: 1,
      oursCount: 1,
      sources: [
        { name: "opensrc", ok: true, detail: "1 hit" },
        { name: "oracle", ok: false, detail: "unreachable" },
      ],
    };
    const text = renderSummary(summary);
    expect(text).toContain('pattern-scout: "needle"');
    expect(text).toContain("exemplars (opensrc): 1 match(es)");
    expect(text).toContain("zod  /x/a.ts:3");
    expect(text).toContain("ours (codebase-oracle): 1 match(es)");
    // line 0 renders as the bare path, with no `:0` suffix
    expect(text).toContain("agent-tasks  src/b.ts");
    expect(text).not.toContain("src/b.ts:0");
    expect(text).toContain("oracle: unavailable");
  });

  it("shows 'no matches' for empty groups", () => {
    const text = renderSummary({
      query: "q",
      results: [],
      exemplarCount: 0,
      oursCount: 0,
      sources: [],
    });
    expect(text).toContain("exemplars (opensrc): no matches");
    expect(text).toContain("ours (codebase-oracle): no matches");
  });
});
