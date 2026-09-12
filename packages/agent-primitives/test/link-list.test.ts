import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  linkEntryUsageError,
  linkSourceMissingMessage,
  mergeLinkSources,
  type MergedLink,
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
        {
          base: root,
          basePhrase: "the repository root",
          values: row.defaults,
          namedIn: DEFAULTS_NAMED_IN,
          remedy:
            "create it, or remove the entry from /repo/.agent-primitives.json",
        },
        {
          base: root,
          basePhrase: "the repository root",
          values: row.plan,
          namedIn: PLAN_NAMED_IN,
          remedy: "create it, or remove the entry from /repo/plan.json",
        },
        {
          base: cwd,
          basePhrase: "the invocation cwd",
          values: row.cli,
          remedy: "create it, or drop --link",
        },
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
      {
        base: root,
        basePhrase: "the repository root",
        values: ["src"],
        namedIn: DEFAULTS_NAMED_IN,
        remedy:
          "create it, or remove the entry from /repo/.agent-primitives.json",
      },
    ]);

    expect(merged[0].namedBy).toBe(`"src" named in ${DEFAULTS_NAMED_IN}`);
  });

  it("keeps the raw entry alongside the resolved path, for a `--link` group (no `namedIn`) too", () => {
    const merged = mergeLinkSources([
      {
        base: cwd,
        basePhrase: "the invocation cwd",
        values: ["extra"],
        remedy: "create it, or drop --link",
      },
    ]);
    expect(merged[0].given).toBe("extra");
    expect(merged[0].value).toBe(path.join(cwd, "extra"));
    expect(merged[0].namedBy).toBeUndefined();
  });
});

describe("linkSourceMissingMessage", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-link-list-test-"),
    );
    tmpDirs.push(dir);
    return dir;
  }

  it("is undefined for a source that exists and is a directory", () => {
    const dir = makeTmpDir();
    const link: MergedLink = {
      value: dir,
      given: "vendor",
      basePhrase: "the invocation cwd",
      remedy: "create it, or drop --link",
    };
    expect(linkSourceMissingMessage(link)).toBeUndefined();
  });

  it("names the value as given, the resolved path, and the base for a source that does not exist", () => {
    const root = makeTmpDir();
    const missing = path.join(root, "does", "not", "exist");
    const link: MergedLink = {
      value: missing,
      given: "does/not/exist",
      basePhrase: "the invocation cwd",
      remedy: "create it, or drop --link",
    };
    const message = linkSourceMissingMessage(link);
    expect(message).toContain('"does/not/exist"');
    expect(message).toContain(missing);
    expect(message).toContain("the invocation cwd");
    expect(message).toContain("does not exist");
  });

  it("refuses a source that exists but is a plain FILE the same way, naming it distinctly from a missing path", () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    const link: MergedLink = {
      value: filePath,
      given: "not-a-dir",
      basePhrase: "the repository root",
      remedy:
        "create it, or remove the entry from /repo/.agent-primitives.json",
    };
    const message = linkSourceMissingMessage(link);
    expect(message).toContain("is not a directory");
    expect(message).not.toContain("does not exist");
  });

  it("includes the provenance phrase (`namedBy`) when the value came from repository content", () => {
    const root = makeTmpDir();
    const missing = path.join(root, "gone");
    const namedBy =
      '"gone" named in the "link" list of /repo/.agent-primitives.json';
    const link: MergedLink = {
      value: missing,
      given: "gone",
      basePhrase: "the repository root",
      remedy:
        "create it, or remove the entry from /repo/.agent-primitives.json",
      namedBy,
    };
    const message = linkSourceMissingMessage(link);
    expect(message).toContain(namedBy);
  });

  // Root bypasses directory permission bits entirely, so a `chmod 000`
  // ancestor never produces EACCES for it; skipped there rather than
  // giving a false pass.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)(
    "reports a stat failure that is NOT 'not there' (EACCES on a locked ancestor) with its own phrase naming the errno, never as 'does not exist'",
    () => {
      const root = makeTmpDir();
      const locked = path.join(root, "locked");
      fs.mkdirSync(locked);
      const target = path.join(locked, "vendor");
      fs.mkdirSync(target);
      fs.chmodSync(locked, 0o000);
      try {
        const link: MergedLink = {
          value: target,
          given: "locked/vendor",
          basePhrase: "the invocation cwd",
          remedy: "create it, or drop --link",
        };
        const message = linkSourceMissingMessage(link);
        expect(message).toBeDefined();
        expect(message).toContain("could not be checked");
        expect(message).toContain("EACCES");
        expect(message).not.toContain("does not exist");
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    },
  );

  it("is undefined for a source that is a SYMLINK resolving to an existing directory: statSync follows it, the same as a plain directory", () => {
    const root = makeTmpDir();
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir);
    const linkPath = path.join(root, "alias");
    fs.symlinkSync(realDir, linkPath);
    const link: MergedLink = {
      value: linkPath,
      given: "alias",
      basePhrase: "the invocation cwd",
      remedy: "create it, or drop --link",
    };
    expect(linkSourceMissingMessage(link)).toBeUndefined();
  });

  it("refuses a DANGLING symlink source (resolving to nothing) the same way as a plain missing path", () => {
    const root = makeTmpDir();
    const linkPath = path.join(root, "dangling");
    fs.symlinkSync(path.join(root, "nowhere-at-all"), linkPath);
    const link: MergedLink = {
      value: linkPath,
      given: "dangling",
      basePhrase: "the invocation cwd",
      remedy: "create it, or drop --link",
    };
    const message = linkSourceMissingMessage(link);
    expect(message).toContain("does not exist");
  });
});
