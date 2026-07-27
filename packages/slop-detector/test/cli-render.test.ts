import { describe, it, expect } from "vitest";
import { renderText } from "../src/cli-render.js";
import type { CheckSummary } from "../src/types.js";

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
      summary({ warnings: ['entrypointGlobs pattern "src/typo-index.ts" matched no scanned files'] }),
      false,
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain('entrypointGlobs pattern "src/typo-index.ts" matched no scanned files');
    expect(text).toMatch(/clean \(1 files scanned\)/);
    // The warning must come before the clean line, not after.
    expect(text.indexOf("entrypointGlobs pattern")).toBeLessThan(text.indexOf("clean ("));
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
            message: "`x` is exported but not imported by any other file in the package",
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
    expect(renderText(summary(), false)).toBe("slop-detector: clean (1 files scanned)\n");
  });
});
