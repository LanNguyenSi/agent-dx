// The shipped warn-only workflow template is the single source other repos
// copy their okf-staleness.yml from. These tests pin the properties the
// consuming repos rely on, so an edit that drops a flag, adds a second
// repo-specific line, or leaves the template out of the npm package fails
// here instead of silently diverging in the fleet.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

interface Step {
  name?: string;
  run?: string;
}

const steps = (
  parse(template) as { jobs: { "okf-staleness": { steps: Step[] } } }
).jobs["okf-staleness"].steps;

const checkStep = steps.find((s) => s.name === "Check bundle (warn-only)");

describe("templates/okf-staleness.yml pin", () => {
  it("states the same version in the header as the install line pins", () => {
    const header = template.match(/pinned to okf-kit\s+#?\s*(\d+\.\d+\.\d+)/);
    const install = template.match(/npm install -g okf-kit@(\d+\.\d+\.\d+)/);
    expect(header).not.toBeNull();
    expect(install).not.toBeNull();
    expect(header?.[1]).toBe(install?.[1]);
  });
});

describe("templates/okf-staleness.yml check step, executed", () => {
  // Runs the real step body under the Actions bash invocation with a stub
  // okf-kit on PATH. Needs jq, which the step itself needs.
  const runStep = (stubExit: number, stubStdout: string) => {
    const dir = mkdtempSync(join(tmpdir(), "okf-staleness-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const stub = join(bin, "okf-kit");
      writeFileSync(
        stub,
        `#!/bin/sh\nprintf '%s' '${stubStdout}'\nexit ${stubExit}\n`,
      );
      chmodSync(stub, 0o755);
      return spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-eo",
          "pipefail",
          "-c",
          checkStep?.run ?? "",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            BUNDLE_PATH: "docs/okf",
            GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
          },
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const report = (errors: number, warnings: number, findings: string) =>
    `{"summary":{"errors":${errors},"warnings":${warnings},"notices":0},"findings":[${findings}]}`;

  it("finds the check step", () => {
    expect(checkStep?.run).toBeTruthy();
  });

  it("stays green on a clean bundle (exit 0)", () => {
    expect(runStep(0, report(0, 0, "")).status).toBe(0);
  });

  it("stays green when the check exits 1 with findings (warn-only)", () => {
    const f = '{"severity":"error","ruleId":"x","file":"a.md","message":"m"}';
    expect(runStep(1, report(1, 0, f)).status).toBe(0);
  });

  it("fails red on a tool/usage error (exit 2)", () => {
    expect(runStep(2, report(0, 0, "")).status).not.toBe(0);
  });
});
