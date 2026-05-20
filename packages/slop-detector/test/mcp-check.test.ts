import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSummary, runSlopCheck } from "../src/mcp-check.js";

describe("runSlopCheck — text input", () => {
  it("flags an em-dash in prose", () => {
    const summary = runSlopCheck({
      text: "We shipped it — and it worked.",
      filename: "msg.md",
    });
    expect(
      summary.violations.find((v) => v.ruleId === "prose-slop/em-dash"),
    ).toBeDefined();
    expect(summary.filesScanned).toBe(1);
  });

  it("flags a leaked </result> tag as block severity", () => {
    const summary = runSlopCheck({
      text: "done\n</result>\n",
      filename: "msg.md",
    });
    const v = summary.violations.find(
      (x) => x.ruleId === "agent-tics/stray-result-tag",
    );
    expect(v).toBeDefined();
    expect(v?.severity).toBe("block");
    expect(summary.blockCount).toBeGreaterThan(0);
  });

  it("returns no violations for clean prose", () => {
    const summary = runSlopCheck({
      text: "Shipped the fix and ran the tests.",
      filename: "msg.md",
    });
    expect(summary.violations).toHaveLength(0);
  });

  it("honors the packs filter — code-slop only does not flag a prose em-dash", () => {
    const summary = runSlopCheck({
      text: "We shipped it — and it worked.",
      filename: "msg.md",
      packs: ["code-slop"],
    });
    expect(
      summary.violations.find((v) => v.ruleId === "prose-slop/em-dash"),
    ).toBeUndefined();
  });
});

describe("runSlopCheck — path input", () => {
  it("scans a file on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slop-mcp-"));
    try {
      const file = path.join(dir, "note.md");
      fs.writeFileSync(file, "We shipped it — and it worked.\n");
      const summary = runSlopCheck({ path: file });
      expect(
        summary.violations.find((v) => v.ruleId === "prose-slop/em-dash"),
      ).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the path does not exist", () => {
    expect(() => runSlopCheck({ path: "/nonexistent/slop-mcp/xyz" })).toThrow(
      /does not exist/,
    );
  });
});

describe("runSlopCheck — input validation", () => {
  it("throws when both text and path are given", () => {
    expect(() => runSlopCheck({ text: "x", path: "y" })).toThrow(
      /either .text. or .path./,
    );
  });

  it("throws when neither text nor path is given", () => {
    expect(() => runSlopCheck({})).toThrow(/required/);
  });
});

describe("renderSummary", () => {
  it("renders a clean scan", () => {
    const summary = runSlopCheck({
      text: "Shipped the fix and ran the tests.",
      filename: "msg.md",
    });
    expect(summary.violations).toHaveLength(0);
    expect(renderSummary(summary)).toMatch(/clean \(1 file\(s\) scanned\)/);
  });

  it("renders violations with a SEVERITY line and a tally", () => {
    const summary = runSlopCheck({
      text: "done\n</result>\n",
      filename: "msg.md",
    });
    const rendered = renderSummary(summary);
    expect(rendered).toContain("agent-tics/stray-result-tag");
    expect(rendered).toMatch(/BLOCK \d+:\d+/);
    expect(rendered).toMatch(
      /violation\(s\) \(block \d+, warn \d+, info \d+\)/,
    );
  });
});
