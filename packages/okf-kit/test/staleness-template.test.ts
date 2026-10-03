// The shipped warn-only workflow template is the single source other repos
// copy their okf-staleness.yml from. These tests pin the properties the
// consuming repos rely on, so an edit that drops a flag, adds a second
// repo-specific line, or leaves the template out of the npm package fails
// here instead of silently diverging in the fleet.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const template = read("../templates/okf-staleness.yml");
const pkg = JSON.parse(read("../package.json")) as { files: string[] };

describe("templates/okf-staleness.yml", () => {
  it("is shipped in the npm package", () => {
    expect(pkg.files).toContain("templates");
  });

  it("names itself as generated from the template, not as a pattern to keep in sync", () => {
    expect(template).toMatch(/GENERATED FROM THE OKF-KIT TEMPLATE/);
    expect(template).not.toMatch(/keep them\s+# in sync/);
  });

  it("carries exactly two repo-specific lines: default branch and bundle path", () => {
    const markers = template.match(/REPO-SPECIFIC \(\d of 2\)/g) ?? [];
    expect(markers).toHaveLength(2);
    expect(template).toMatch(/^ {4}branches: \[[\w-]+\]$/m);
    expect(template).toMatch(/^ {6}BUNDLE_PATH: \S+$/m);
  });

  it("installs exactly one exact semver pin", () => {
    const pins =
      template.match(/npm install -g okf-kit@(\d+\.\d+\.\d+)\b/g) ?? [];
    expect(pins).toHaveLength(1);
  });

  it("runs the check with --require-anchors against BUNDLE_PATH and stays warn-only", () => {
    expect(template).toContain(
      'okf-kit check --json --require-anchors "${BUNDLE_PATH}" > okf-report.json',
    );
    expect(template).not.toMatch(/^\s*okf-kit check[^\n]*--strict/m);
    // Only a tool/usage error (anything but 0 or 1) may fail the job.
    expect(template).toContain(
      'if [ "${code}" -ne 0 ] && [ "${code}" -ne 1 ]; then',
    );
    expect(template.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("uses a full checkout so sources-fresh sees real history", () => {
    expect(template).toMatch(/fetch-depth: 0/);
  });
});
