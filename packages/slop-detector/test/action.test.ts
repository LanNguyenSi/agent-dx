import { describe, expect, it } from "vitest";
import {
  escapeData,
  escapeProperty,
  exceedsThreshold,
  formatAnnotation,
  parseSummary,
  parseThreshold,
  selectChangedFiles,
} from "../src/action/run.js";
import type { Severity, Violation } from "../src/types.js";

function violation(
  severity: Severity,
  over: Partial<Violation> = {},
): Violation {
  return {
    ruleId: "some-rule",
    pack: "agent-tics",
    severity,
    path: "docs/a.md",
    line: 3,
    column: 5,
    endLine: 3,
    endColumn: 9,
    message: "bad thing",
    rationale: "because",
    matched: "x",
    ...over,
  };
}

const summaryOf = (...sev: Severity[]) => ({
  violations: sev.map((s) => violation(s)),
});

describe("formatAnnotation", () => {
  it("maps each severity to its own workflow command", () => {
    expect(formatAnnotation(violation("block"))).toBe(
      "::error file=docs/a.md,line=3,col=5,endLine=3,endColumn=9,title=agent-tics/some-rule::bad thing",
    );
    expect(formatAnnotation(violation("warn"))).toBe(
      "::warning file=docs/a.md,line=3,col=5,endLine=3,endColumn=9,title=agent-tics/some-rule::bad thing",
    );
    expect(formatAnnotation(violation("info"))).toBe(
      "::notice file=docs/a.md,line=3,col=5,endLine=3,endColumn=9,title=agent-tics/some-rule::bad thing",
    );
  });

  it("does not double the pack prefix of a qualified rule id", () => {
    const out = formatAnnotation(
      violation("block", { ruleId: "agent-tics/leak" }),
    );
    expect(out).toContain("title=agent-tics/leak::");
  });

  it("omits absent end positions", () => {
    const out = formatAnnotation(
      violation("block", { endLine: undefined, endColumn: undefined }),
    );
    expect(out).toBe(
      "::error file=docs/a.md,line=3,col=5,title=agent-tics/some-rule::bad thing",
    );
  });

  it("escapes properties and message", () => {
    const out = formatAnnotation(
      violation("warn", { path: "a,b:c.md", message: "50%\nnext" }),
    );
    expect(out).toContain("file=a%2Cb%3Ac.md,");
    expect(out.endsWith("::50%25%0Anext")).toBe(true);
  });

  it("makes absolute paths repo-relative", () => {
    const out = formatAnnotation(
      violation("block", { path: "/work/repo/src/x.md" }),
      "/work/repo",
    );
    expect(out).toContain("file=src/x.md,");
  });
});

describe("escaping", () => {
  it("escapeData handles percent, CR and LF", () => {
    expect(escapeData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
    expect(escapeData("line1\nline2")).toBe("line1%0Aline2");
  });

  it("escapeProperty also handles colon and comma", () => {
    expect(escapeProperty("a:b,c%\n")).toBe("a%3Ab%2Cc%25%0A");
  });
});

describe("exceedsThreshold", () => {
  it("block-only summary trips every threshold", () => {
    const s = summaryOf("block");
    expect(exceedsThreshold(s, "block")).toBe(true);
    expect(exceedsThreshold(s, "warn")).toBe(true);
    expect(exceedsThreshold(s, "info")).toBe(true);
  });

  it("warn-only summary does not trip block, trips warn and info", () => {
    const s = summaryOf("warn");
    expect(exceedsThreshold(s, "block")).toBe(false);
    expect(exceedsThreshold(s, "warn")).toBe(true);
    expect(exceedsThreshold(s, "info")).toBe(true);
  });

  it("info-only summary trips only the info threshold", () => {
    const s = summaryOf("info");
    expect(exceedsThreshold(s, "block")).toBe(false);
    expect(exceedsThreshold(s, "warn")).toBe(false);
    expect(exceedsThreshold(s, "info")).toBe(true);
  });

  it("an empty summary never trips", () => {
    expect(exceedsThreshold(summaryOf(), "info")).toBe(false);
  });

  it("rejects an unknown threshold with a clear message", () => {
    expect(() => parseThreshold("error")).toThrow(/invalid severity-threshold/);
    expect(() => exceedsThreshold(summaryOf("block"), "nope")).toThrow(
      /expected one of block, warn, info/,
    );
  });
});

describe("parseSummary", () => {
  it("parses a CheckSummary", () => {
    const s = parseSummary(JSON.stringify({ filesScanned: 1, violations: [] }));
    expect(s.violations).toEqual([]);
  });

  it("rejects non-JSON output", () => {
    expect(() => parseSummary("Error: boom")).toThrow(/not valid JSON/);
  });

  it("rejects JSON without violations", () => {
    expect(() => parseSummary("{}")).toThrow(/no violations array/);
  });
});

describe("selectChangedFiles", () => {
  const present = new Set(["a.md", "docs/b.md", "src/c.ts"]);
  const exists = (f: string) => present.has(f);

  it("drops files that no longer exist", () => {
    expect(
      selectChangedFiles(["a.md", "gone.md", "docs/b.md"], exists),
    ).toEqual(["a.md", "docs/b.md"]);
  });

  it("restricts to the scan path", () => {
    expect(selectChangedFiles(["a.md", "docs/b.md"], exists, "docs")).toEqual([
      "docs/b.md",
    ]);
    expect(selectChangedFiles(["docs2/x.md"], () => true, "docs")).toEqual([]);
  });

  it("de-duplicates and skips blanks", () => {
    expect(selectChangedFiles(["a.md", "", "a.md", "./a.md"], exists)).toEqual([
      "a.md",
    ]);
  });
});
