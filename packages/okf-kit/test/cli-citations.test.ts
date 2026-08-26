import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, runCli } from "./helpers.js";

// Confirms citations-resolve findings surface through the runCli `check
// --json` path, not just via citationsResolveRule.run(ctx) directly (which
// the rest of the citations-resolve suite exercises), so a future change to
// report.ts/cli.ts wiring cannot silently drop this rule's findings from the
// CLI's JSON output.
describe("okf-kit cli citations-resolve", () => {
  it("check --json on the citations-resolve-main fixture surfaces ruleId citations-resolve", () => {
    const bundleDir = path.join(
      FIXTURES_DIR,
      "citations-resolve-main/docs/okf",
    );
    const repoRoot = path.join(FIXTURES_DIR, "citations-resolve-main");

    const result = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--json",
    ]);
    expect(result.status).toBe(0); // citations-resolve findings are warnings; no --strict here

    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ ruleId: string }>;
    };
    expect(parsed.findings.some((f) => f.ruleId === "citations-resolve")).toBe(
      true,
    );
  });

  it("check without --require-anchors never surfaces the opt-in-only rule ids on the require-anchors fixture", () => {
    const bundleDir = path.join(
      FIXTURES_DIR,
      "citations-resolve-require-anchors/docs/okf",
    );
    const repoRoot = path.join(
      FIXTURES_DIR,
      "citations-resolve-require-anchors",
    );

    const result = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--json",
    ]);

    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ message: string }>;
    };
    expect(
      parsed.findings.some((f) => f.message.includes("[anchor-required]")),
    ).toBe(false);
  });

  it("check --require-anchors surfaces anchor-required on the require-anchors fixture, and --require-anchors-allow exempts an allowlisted target", () => {
    const bundleDir = path.join(
      FIXTURES_DIR,
      "citations-resolve-require-anchors/docs/okf",
    );
    const repoRoot = path.join(
      FIXTURES_DIR,
      "citations-resolve-require-anchors",
    );

    const withoutAllow = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--require-anchors",
      "--json",
    ]);
    const withoutAllowFindings = (
      JSON.parse(withoutAllow.stdout) as {
        findings: Array<{ message: string }>;
      }
    ).findings;
    expect(
      withoutAllowFindings.some(
        (f) =>
          f.message.startsWith("`README.md:1`") &&
          f.message.includes("[anchor-required]"),
      ),
    ).toBe(true);

    const withAllow = runCli([
      "check",
      bundleDir,
      "--repo-root",
      repoRoot,
      "--require-anchors",
      "--require-anchors-allow",
      "README.md",
      "--json",
    ]);
    const withAllowFindings = (
      JSON.parse(withAllow.stdout) as { findings: Array<{ message: string }> }
    ).findings;
    expect(
      withAllowFindings.some((f) => f.message.startsWith("`README.md:1`")),
    ).toBe(false);
    // Still flagged: the allowlist only exempts README.md, not the other
    // unanchored citation into src/target.ts.
    expect(
      withAllowFindings.some(
        (f) =>
          f.message.startsWith("`src/target.ts:2`") &&
          f.message.includes("[anchor-required]"),
      ),
    ).toBe(true);
  });
});
