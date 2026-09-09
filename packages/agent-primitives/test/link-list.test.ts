import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  linkEntryUsageError,
  mergeLinkSources,
} from "../src/probe/link-list.js";

describe("linkEntryUsageError", () => {
  it("accepts an ordinary relative path", () => {
    expect(linkEntryUsageError("vendor")).toBeUndefined();
    expect(linkEntryUsageError("../shared-cache")).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(linkEntryUsageError("")).toBe("must be a non-empty string");
  });

  it("rejects a non-string value", () => {
    expect(linkEntryUsageError(42)).toBe("must be a non-empty string");
    expect(linkEntryUsageError(null)).toBe("must be a non-empty string");
  });

  it("rejects a $(...) command substitution", () => {
    expect(linkEntryUsageError("vendor/$(rm -rf /)")).toMatch(/\$\(/);
  });

  it("rejects a backtick", () => {
    expect(linkEntryUsageError("vendor/`rm -rf /`")).toMatch(/backtick/);
  });
});

/**
 * The three-source precedence table: defaults file, then plan, then
 * CLI, all additive and deduplicated, in every presence/overlap
 * combination that matters -- absent, present alone, and overlapping
 * with an earlier source (which must never duplicate, never drop the
 * earlier occurrence in favor of a later one, and never let a later
 * source remove an earlier one's value). One table-driven test pins
 * the whole precedence rule at once; a mutation that drops any one
 * source's contribution fails at least one row. Each row also pins the
 * PROVENANCE the winning slot keeps, since that is what decides
 * whether the link policy holds the value to its stricter
 * repository-content rule: a path both a file source and `--link` name
 * stays file-sourced.
 */
describe("mergeLinkSources: precedence table (defaults, then plan, then CLI)", () => {
  const root = path.sep + path.join("repo");
  const cwd = path.join(root, "pkg");

  interface Row {
    name: string;
    defaults: string[];
    plan: string[];
    cli: string[];
    expected: string[];
    /** Which source each expected path keeps its provenance from:
     * "defaults"/"plan" carry the file phrase, "cli" carries none. */
    expectedNamedIn: ("defaults" | "plan" | "cli")[];
  }

  const DEFAULTS_NAMED_IN = 'the "link" list of /repo/.agent-primitives.json';
  const PLAN_NAMED_IN = 'the "link" list of /repo/plan.json';

  const rows: Row[] = [
    {
      name: "all three absent",
      defaults: [],
      plan: [],
      cli: [],
      expected: [],
      expectedNamedIn: [],
    },
    {
      name: "defaults only",
      defaults: ["vendor"],
      plan: [],
      cli: [],
      expected: [path.join(root, "vendor")],
      expectedNamedIn: ["defaults"],
    },
    {
      name: "plan only",
      defaults: [],
      plan: ["shared"],
      cli: [],
      expected: [path.join(root, "shared")],
      expectedNamedIn: ["plan"],
    },
    {
      name: "CLI only",
      defaults: [],
      plan: [],
      cli: ["extra"],
      expected: [path.join(cwd, "extra")],
      expectedNamedIn: ["cli"],
    },
    {
      name: "all three, distinct paths: union of all three, in order",
      defaults: ["vendor"],
      plan: ["shared"],
      cli: ["extra"],
      expected: [
        path.join(root, "vendor"),
        path.join(root, "shared"),
        path.join(cwd, "extra"),
      ],
      expectedNamedIn: ["defaults", "plan", "cli"],
    },
    {
      name: "defaults and plan resolve to the same path: kept once, defaults wins the slot",
      defaults: ["vendor"],
      plan: ["vendor"],
      cli: [],
      expected: [path.join(root, "vendor")],
      expectedNamedIn: ["defaults"],
    },
    {
      name: "plan and CLI resolve to the same path: kept once, plan wins the slot",
      defaults: [],
      plan: ["pkg/extra"],
      cli: ["extra"],
      expected: [path.join(root, "pkg", "extra")],
      expectedNamedIn: ["plan"],
    },
    {
      name: "defaults and CLI resolve to the same path: kept once, defaults wins the slot",
      defaults: ["pkg/extra"],
      plan: [],
      cli: ["extra"],
      expected: [path.join(root, "pkg", "extra")],
      expectedNamedIn: ["defaults"],
    },
    {
      name: "all three resolve to the same path: kept exactly once",
      defaults: ["pkg/extra"],
      plan: ["pkg/extra"],
      cli: ["extra"],
      expected: [path.join(root, "pkg", "extra")],
      expectedNamedIn: ["defaults"],
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const merged = mergeLinkSources([
        { base: root, values: row.defaults, namedIn: DEFAULTS_NAMED_IN },
        { base: root, values: row.plan, namedIn: PLAN_NAMED_IN },
        { base: cwd, values: row.cli },
      ]);
      expect(merged.map((link) => link.value)).toEqual(row.expected);
      expect(
        merged.map((link) =>
          link.namedBy === undefined
            ? "cli"
            : link.namedBy.includes(PLAN_NAMED_IN)
              ? "plan"
              : "defaults",
        ),
      ).toEqual(row.expectedNamedIn);
    });
  }

  it("a file source's provenance phrase names the raw entry and the file, which is what a refusal warning has to carry", () => {
    const merged = mergeLinkSources([
      { base: root, values: ["src"], namedIn: DEFAULTS_NAMED_IN },
    ]);

    expect(merged[0].namedBy).toBe(`"src" named in ${DEFAULTS_NAMED_IN}`);
  });
});
