import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, runCli } from "./helpers.js";

// Confirms prose-line-references findings surface through the runCli
// `check --json` path (not just via proseLineReferencesRule.run(ctx)
// directly, which prose-line-references.test.ts exercises), and that the
// opt-in gate and the strict sub-flag are both wired correctly end to end
// -- mirroring cli-citations.test.ts's own reasoning for citations-resolve
// and --require-anchors.
describe("okf-kit cli prose-line-references", () => {
  const bundleDir = path.join(
    FIXTURES_DIR,
    "prose-line-references-main/docs/okf",
  );
  const repoRoot = path.join(FIXTURES_DIR, "prose-line-references-main");

  it("check without --prose-line-references never surfaces the opt-in-only rule id", () => {
    const result = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ ruleId: string }>;
    };
    expect(
      parsed.findings.some((f) => f.ruleId === "prose-line-references"),
    ).toBe(false);
  });

  it("check --prose-line-references surfaces out-of-bounds and blank-start-line findings", () => {
    const result = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--prose-line-references",
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ ruleId: string; message: string }>;
    };
    const own = parsed.findings.filter(
      (f) => f.ruleId === "prose-line-references",
    );
    expect(own.some((f) => f.message.includes("[out-of-bounds]"))).toBe(true);
    expect(own.some((f) => f.message.includes("[blank-start-line]"))).toBe(
      true,
    );
    expect(
      own.some((f) =>
        f.message.includes("[prose-line-reference-not-anchored]"),
      ),
    ).toBe(false);
  });

  it("check --prose-line-references --prose-line-references-strict additionally flags the correct reference", () => {
    const result = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--prose-line-references",
      "--prose-line-references-strict",
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ ruleId: string; message: string }>;
    };
    const own = parsed.findings.filter(
      (f) => f.ruleId === "prose-line-references",
    );
    expect(
      own.some(
        (f) =>
          f.message.startsWith("`lines 1-3`") &&
          f.message.includes("[prose-line-reference-not-anchored]"),
      ),
    ).toBe(true);
  });

  it("--prose-line-references-strict alone (without --prose-line-references) has no effect", () => {
    const result = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--prose-line-references-strict",
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ ruleId: string }>;
    };
    expect(
      parsed.findings.some((f) => f.ruleId === "prose-line-references"),
    ).toBe(false);
  });
});
