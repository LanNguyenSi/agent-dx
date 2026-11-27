import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("runSlopCheck — unknown pack", () => {
  it("throws naming the unknown pack", () => {
    expect(() =>
      runSlopCheck({ text: "hi", filename: "msg.md", packs: ["ui-slp"] }),
    ).toThrow(/unknown pack "ui-slp"/);
  });
});

describe("runSlopCheck — path input", () => {
  it("scans a file on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slop-mcp-"));
    try {
      const file = path.join(dir, "note.md");
      fs.writeFileSync(file, "We shipped it — and it worked.\n");
      const summary = runSlopCheck({ path: file }, { root: dir });
      expect(
        summary.violations.find((v) => v.ruleId === "prose-slop/em-dash"),
      ).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the path does not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slop-mcp-"));
    try {
      expect(() => runSlopCheck({ path: "missing.md" }, { root: dir })).toThrow(
        /does not exist/,
      );
      expect(() =>
        runSlopCheck({ path: "/nonexistent/slop-mcp/xyz" }, { root: dir }),
      ).toThrow(/does not exist/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSlopCheck — confinement to the root", () => {
  const SLOPPY = "We shipped it \u2014 and it worked.\n";
  const hasEmDash = (s: ReturnType<typeof runSlopCheck>) =>
    s.violations.some((v) => v.ruleId === "prose-slop/em-dash");
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "slop-mcp-root-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "in.md"), SLOPPY);
    fs.writeFileSync(path.join(outside, "out.md"), SLOPPY);
    fs.writeFileSync(path.join(outside, "slop.config.yml"), "rules: {}\n");
    fs.writeFileSync(path.join(root, "slop.config.yml"), "rules: {}\n");
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const OUT = /is outside the server's working directory/;

  it("scans an absolute path inside the root", () => {
    expect(
      hasEmDash(runSlopCheck({ path: path.join(root, "in.md") }, { root })),
    ).toBe(true);
  });

  it("scans a relative path resolved against the root", () => {
    expect(hasEmDash(runSlopCheck({ path: "in.md" }, { root }))).toBe(true);
  });

  it("refuses an absolute path outside the root", () => {
    expect(() =>
      runSlopCheck({ path: path.join(outside, "out.md") }, { root }),
    ).toThrow(OUT);
  });

  it("refuses a relative .. escape", () => {
    expect(() => runSlopCheck({ path: "../outside/out.md" }, { root })).toThrow(
      /path is outside/,
    );
  });

  it("refuses a sibling directory sharing the root's name prefix", () => {
    const sibling = path.join(base, "root2");
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "x.md"), SLOPPY);
    expect(() =>
      runSlopCheck({ path: path.join(sibling, "x.md") }, { root }),
    ).toThrow(OUT);
  });

  it("refuses an in-tree symlink to an outside file", () => {
    fs.symlinkSync(path.join(outside, "out.md"), path.join(root, "link.md"));
    expect(() => runSlopCheck({ path: "link.md" }, { root })).toThrow(OUT);
  });

  it("refuses an in-tree symlink to an outside directory", () => {
    fs.symlinkSync(outside, path.join(root, "linkdir"), "dir");
    expect(() => runSlopCheck({ path: "linkdir" }, { root })).toThrow(OUT);
    expect(() => runSlopCheck({ path: "linkdir/out.md" }, { root })).toThrow(
      OUT,
    );
  });

  it("scans an in-tree symlink to an in-tree file", () => {
    fs.symlinkSync(path.join(root, "in.md"), path.join(root, "alias.md"));
    expect(hasEmDash(runSlopCheck({ path: "alias.md" }, { root }))).toBe(true);
  });

  it("keeps the does-not-exist error for a dangling in-tree symlink", () => {
    fs.symlinkSync(path.join(root, "gone.md"), path.join(root, "dangling.md"));
    expect(() => runSlopCheck({ path: "dangling.md" }, { root })).toThrow(
      /does not exist/,
    );
  });

  it("loads a configPath inside the root", () => {
    expect(
      hasEmDash(
        runSlopCheck(
          { path: "in.md", configPath: "slop.config.yml" },
          { root },
        ),
      ),
    ).toBe(true);
  });

  it("refuses a configPath outside the root without loading it", () => {
    const outsideConfig = path.join(outside, "slop.config.yml");
    expect(() =>
      runSlopCheck({ path: "in.md", configPath: outsideConfig }, { root }),
    ).toThrow(/configPath is outside/);
    expect(() =>
      runSlopCheck(
        { text: "hi", filename: "msg.md", configPath: outsideConfig },
        { root },
      ),
    ).toThrow(/configPath is outside/);
  });

  it("refuses an invalid outside config with the containment error, not a parse error", () => {
    const bad = path.join(outside, "bad.yml");
    fs.writeFileSync(bad, "rules: [unterminated\n");
    expect(() =>
      runSlopCheck({ path: "in.md", configPath: bad }, { root }),
    ).toThrow(/configPath is outside/);
  });

  it("refuses a configPath reached through a symlink out of the root", () => {
    fs.symlinkSync(
      path.join(outside, "slop.config.yml"),
      path.join(root, "linked.yml"),
    );
    expect(() =>
      runSlopCheck({ path: "in.md", configPath: "linked.yml" }, { root }),
    ).toThrow(/configPath is outside/);
  });

  it("defaults the root to the process working directory", () => {
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(hasEmDash(runSlopCheck({ path: "in.md" }))).toBe(true);
      expect(() =>
        runSlopCheck({ path: path.join(outside, "out.md") }),
      ).toThrow(OUT);
    } finally {
      process.chdir(cwd);
    }
  });

  it("leaves text input and filename unconfined", () => {
    expect(
      hasEmDash(
        runSlopCheck(
          { text: SLOPPY, filename: "/elsewhere/never-opened.md" },
          { root },
        ),
      ),
    ).toBe(true);
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

  it("prints a warning before the clean line when the summary carries one", () => {
    // Mirrors the CLI bug this guards against: CheckSummary.warnings can be
    // populated (e.g. a typo'd entrypointGlobs pattern) even when there are
    // zero violations, and the MCP renderer must not silently drop it.
    const summary = runSlopCheck({
      text: "Shipped the fix and ran the tests.",
      filename: "msg.md",
    });
    summary.warnings = [
      'entrypointGlobs pattern "src/typo-index.ts" matched no scanned files',
    ];
    const rendered = renderSummary(summary);
    expect(rendered.split("\n")[0]).toContain("src/typo-index.ts");
    expect(rendered).toMatch(/clean \(1 file\(s\) scanned\)/);
  });

  it("prints a warning before the violation list", () => {
    const summary = runSlopCheck({
      text: "done\n</result>\n",
      filename: "msg.md",
    });
    summary.warnings = ["some warning"];
    const rendered = renderSummary(summary);
    expect(rendered.indexOf("some warning")).toBeLessThan(
      rendered.indexOf("msg.md"),
    );
  });
});

describe("renderSummary terminal escapes", () => {
  it("escapes control characters in warnings, path, rule id and message", () => {
    const summary = runSlopCheck({
      text: 'x <invoke name="a\x1b]52;c;aGk=\x07"> y\n',
      filename: "msg.md",
    });
    summary.warnings = ["w\x1b[31m"];
    summary.violations[0]!.path = "ev\x1b[2Jil\r.md";
    summary.violations[0]!.ruleId = "r\x9b";
    const rendered = renderSummary(summary);
    expect(rendered).toContain("warning: w\\x1b[31m");
    expect(rendered).toContain("ev\\x1b[2Jil\\x0d.md");
    expect(rendered).toContain("r\\u009b");
    expect(rendered).toContain("\\x1b]52;c;aGk=\\x07");
    expect(rendered).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  it("renders a clean multi-line summary byte for byte", () => {
    const summary = runSlopCheck({
      text: "done\n</result>\n",
      filename: "msg.md",
    });
    const v = summary.violations[0]!;
    expect(renderSummary(summary)).toBe(
      `msg.md\n  BLOCK ${v.line}:${v.column}  ${v.ruleId}  ${v.message}\n` +
        `1 file(s) scanned, 1 violation(s) (block 1, warn 0, info 0)`,
    );
  });
});
