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
});
