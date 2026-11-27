import { describe, it, expect } from "vitest";
import { renderText } from "../src/cli-render.js";
import type { CheckSummary, Violation } from "../src/types.js";

function summary(overrides: Partial<CheckSummary> = {}): CheckSummary {
  return {
    filesScanned: 1,
    violations: [],
    blockCount: 0,
    warnCount: 0,
    infoCount: 0,
    ...overrides,
  };
}

describe("cli-render/renderText", () => {
  it("prints a warning before the clean line when there are no violations", () => {
    // This is the exact case that let an unwired renderer through before:
    // CheckSummary.warnings was populated correctly by checkFiles, but the
    // CLI's text renderer never looked at the field, so a typo'd
    // entrypointGlobs pattern printed only "clean" with no hint anything
    // was wrong.
    const text = renderText(
      summary({
        warnings: [
          'entrypointGlobs pattern "src/typo-index.ts" matched no scanned files',
        ],
      }),
      false,
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain(
      'entrypointGlobs pattern "src/typo-index.ts" matched no scanned files',
    );
    expect(text).toMatch(/clean \(1 files scanned\)/);
    // The warning must come before the clean line, not after.
    expect(text.indexOf("entrypointGlobs pattern")).toBeLessThan(
      text.indexOf("clean ("),
    );
  });

  it("prints a warning before the violation list when there are violations", () => {
    const text = renderText(
      summary({
        warnings: ["some warning"],
        violations: [
          {
            ruleId: "code-slop/unused-export",
            pack: "code-slop",
            severity: "warn",
            path: "a.ts",
            line: 1,
            column: 1,
            message:
              "`x` is exported but not imported by any other file in the package",
            rationale: "unused",
            matched: "x",
          },
        ],
        warnCount: 1,
      }),
      false,
    );
    expect(text.indexOf("some warning")).toBeLessThan(text.indexOf("a.ts"));
  });

  it("prints no warning line at all when there are none", () => {
    const text = renderText(summary(), false);
    expect(text).not.toContain("warning");
    expect(text).toMatch(/clean \(1 files scanned\)/);
  });

  it("still renders the clean line and the violation tally as before (no format change beyond the warning prefix)", () => {
    expect(renderText(summary(), false)).toBe(
      "slop-detector: clean (1 files scanned)\n",
    );
  });
});

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    ruleId: "agent-tics/stray-invoke-tag",
    pack: "agent-tics",
    severity: "block",
    path: "a.md",
    line: 1,
    column: 2,
    message: "Stray tag",
    rationale: "Because.",
    matched: "x",
    ...overrides,
  };
}

describe("cli-render/renderText terminal escapes", () => {
  const cases: Array<[string, string, string]> = [
    ["OSC 52", "\x1b]52;c;aGk=\x07", "\\x1b]52;c;aGk=\\x07"],
    ["CSI", "\x1b[2J", "\\x1b[2J"],
    ["lone ESC", "\x1b", "\\x1b"],
    ["C1 CSI", "\x9b2J", "\\u009b2J"],
    ["DEL", "\x7f", "\\x7f"],
    ["CR", "ok\rEVIL", "ok\\x0dEVIL"],
  ];

  for (const [name, raw, escaped] of cases) {
    it(`escapes ${name} in a message`, () => {
      const text = renderText(
        summary({
          violations: [violation({ message: `m ${raw} m` })],
          blockCount: 1,
        }),
        false,
      );
      expect(text).toContain(`m ${escaped} m`);
      expect(text).not.toContain(raw);
    });
  }

  it("escapes control characters in a path", () => {
    const text = renderText(
      summary({
        violations: [violation({ path: "evil\x1b[2J\rname.md" })],
        blockCount: 1,
      }),
      false,
    );
    expect(text).toContain("\nevil\\x1b[2J\\x0dname.md\n");
    expect(text).not.toMatch(/[\x1b\r]/);
  });

  it("escapes control characters in a warning, a rule id and a rationale", () => {
    const text = renderText(
      summary({
        warnings: ["w\x1b[31m"],
        violations: [violation({ ruleId: "r\x07", rationale: "why\x1b[2J" })],
        blockCount: 1,
      }),
      true,
    );
    expect(text).toContain("warning: w\\x1b[31m\n");
    expect(text).toContain("  r\\x07  ");
    expect(text).toContain("↪ why\\x1b[2J\n");
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it("renders a clean multi-line summary byte for byte", () => {
    const text = renderText(
      summary({
        warnings: ["glob matched nothing"],
        violations: [
          violation({ path: "a.md", message: "First\nsecond line\ttabbed" }),
          violation({ path: "a.md", line: 3, message: "Second" }),
          violation({ path: "b.md", severity: "warn", message: "Third" }),
        ],
        filesScanned: 2,
        blockCount: 2,
        warnCount: 1,
      }),
      true,
    );
    expect(text).toBe(
      "slop-detector: warning: glob matched nothing\n" +
        "\na.md\n" +
        "  BLOCK 1:2  agent-tics/stray-invoke-tag  First\nsecond line\ttabbed\n" +
        "    ↪ Because.\n" +
        "  BLOCK 3:2  agent-tics/stray-invoke-tag  Second\n" +
        "    ↪ Because.\n" +
        "\nb.md\n" +
        "  WARN  1:2  agent-tics/stray-invoke-tag  Third\n" +
        "    ↪ Because.\n" +
        "\n2 files scanned, 3 violations (block 2, warn 1, info 0)\n",
    );
  });
});
