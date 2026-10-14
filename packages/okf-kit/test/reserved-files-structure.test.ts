import { describe, expect, it } from "vitest";
import { reservedFilesStructureRule } from "../src/rules/reserved-files-structure.js";
import type { Finding } from "../src/types.js";
import { loadFixture } from "./helpers.js";

function findingsFor(findings: Finding[], file: string): Finding[] {
  return findings.filter((f) => f.file === file);
}

function lines(findings: Finding[]): number[] {
  return findings.map((f) => Number(/line (\d+)/.exec(f.message)?.[1] ?? -1));
}

describe("reserved-files-structure", () => {
  it("finds nothing in a bundle whose reserved-file bodies conform", () => {
    expect(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-conformant"),
      ),
    ).toEqual([]);
  });

  it("log.md: one finding per non-ISO date heading, with its line", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-log-bad-dates"),
      ),
      "log.md",
    );
    // line 1: extra text after the date; line 5: non-date level-2 heading;
    // line 9: a bare date at the wrong heading level; line 13: an impossible
    // calendar date. The conformant `## 2026-01-01` (line 17) is not reported.
    expect(lines(findings)).toEqual([1, 5, 9, 13]);
    expect(findings.every((f) => f.ruleId === "reserved-files-structure")).toBe(
      true,
    );
    expect(findings[0].message).toContain("2026-10-03 (mcp-server 0.16.0)");
    expect(findings[2].message).toContain("level 3");
  });

  it("log.md: bad-date findings are errors under v0.2 and warnings under v0.1", () => {
    const ctx = loadFixture("reserved-structure-log-bad-dates");
    ctx.specVersion = "v0.2";
    const asV02 = findingsFor(reservedFilesStructureRule.run(ctx), "log.md");
    expect(asV02.length).toBeGreaterThan(0);
    expect(asV02.every((f) => f.severity === "error")).toBe(true);

    ctx.specVersion = "v0.1";
    const asV01 = findingsFor(reservedFilesStructureRule.run(ctx), "log.md");
    expect(asV01.map((f) => f.message)).toEqual(asV02.map((f) => f.message));
    expect(asV01.every((f) => f.severity === "warning")).toBe(true);
  });

  it("log.md: a date heading not older than the previous one is named with its line", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-log-order"),
      ),
      "log.md",
    );
    // oldest-first order (line 1) then a newer date (line 5), then the same
    // date twice (line 9): both later headings are reported, naming the
    // offending heading, and the first heading is never reported.
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.message.includes("`## 2026-10-03`"))).toBe(
      true,
    );
    expect(lines(findings)).toEqual([5, 9]);
  });

  it("index.md: a free prose paragraph is one warning naming its line", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-index-prose"),
      ),
      "index.md",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(lines(findings)).toEqual([3]);
  });
});
