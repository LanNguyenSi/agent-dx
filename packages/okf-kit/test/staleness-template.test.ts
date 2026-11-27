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
  readdirSync,
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
const pkg = JSON.parse(read("../package.json")) as {
  files: string[];
  version: string;
};

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

  it("bounds the job with timeout-minutes", () => {
    const job = (
      parse(template) as {
        jobs: { "okf-staleness": { "timeout-minutes"?: number } };
      }
    ).jobs["okf-staleness"];
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("uses a full checkout so sources-fresh sees real history", () => {
    expect(template).toMatch(/fetch-depth: 0/);
  });
});

interface Step {
  name?: string;
  shell?: string;
  run?: string;
}

const steps = (
  parse(template) as { jobs: { "okf-staleness": { steps: Step[] } } }
).jobs["okf-staleness"].steps;

const checkStep = steps.find((s) => s.name === "Check bundle (warn-only)");
const installStep = steps.find((s) => s.name === "Install okf-kit (exact pin)");
const assertStep = steps.find(
  (s) => s.name === "Assert CLI version equals the pin",
);

describe("shipped templates pin actions by commit", () => {
  const dir = new URL("../templates/", import.meta.url);
  it("every uses: line is a 40-hex SHA with a version comment", () => {
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    let seen = 0;
    for (const f of files) {
      const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
      for (const line of lines) {
        if (!/^\s*-?\s*uses:/.test(line)) continue;
        seen += 1;
        expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("templates/okf-staleness.yml pin", () => {
  it("states the same version in the header as the install line pins", () => {
    const header = template.match(/pinned to okf-kit\s+#?\s*(\d+\.\d+\.\d+)/);
    const install = template.match(/npm install -g okf-kit@(\d+\.\d+\.\d+)/);
    expect(header).not.toBeNull();
    expect(install).not.toBeNull();
    expect(header?.[1]).toBe(install?.[1]);
  });

  it("install pin equals the version this package publishes as", () => {
    // The header-vs-install test above lets a whole template pin a version
    // package.json never published; this ties the pin to the package's own
    // version, the way .github/workflows/ci.yml derives its pin.
    const install = template.match(/npm install -g okf-kit@(\d+\.\d+\.\d+)/);
    expect(install).not.toBeNull();
    expect(install?.[1]).toBe(pkg.version);
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

describe("templates/okf-staleness.yml install step, executed", () => {
  it("finds the install step and runs it under shell: bash", () => {
    expect(installStep?.run).toBeTruthy();
    expect(installStep?.shell).toBe("bash");
  });

  it("runs the pinned install command once and exports the pin to GITHUB_ENV", () => {
    // Stub npm on PATH: no install happens, but the argv the step passes to
    // npm and the GITHUB_ENV append are the real ones, replayed under the
    // Actions bash invocation.
    const dir = mkdtempSync(join(tmpdir(), "okf-staleness-install-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const npmArgs = join(dir, "npm-args");
      const githubEnv = join(dir, "github_env");
      writeFileSync(
        join(bin, "npm"),
        `#!/bin/sh\nprintf '%s\\n' "$*" > '${npmArgs}'\nexit 0\n`,
      );
      chmodSync(join(bin, "npm"), 0o755);
      const res = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-eo",
          "pipefail",
          "-c",
          installStep?.run ?? "",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            GITHUB_ENV: githubEnv,
          },
        },
      );
      expect(res.status).toBe(0);
      expect(readFileSync(npmArgs, "utf8").trim()).toBe(
        `install -g okf-kit@${pkg.version} --no-audit --no-fund`,
      );
      expect(readFileSync(githubEnv, "utf8")).toBe(
        `OKF_KIT_PIN=${pkg.version}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("templates/okf-staleness.yml assert step, executed", () => {
  // Stub okf-kit on PATH printing `printed` on stdout; `pin` is exported as
  // OKF_KIT_PIN only when given, so omitting it replays the unset case.
  const runAssert = (printed: string, pin?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "okf-staleness-assert-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const stub = join(bin, "okf-kit");
      writeFileSync(stub, `#!/bin/sh\nprintf '%s' '${printed}'\nexit 0\n`);
      chmodSync(stub, 0o755);
      const env: Record<string, string> = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      };
      if (pin !== undefined) env.OKF_KIT_PIN = pin;
      return spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-eo",
          "pipefail",
          "-c",
          assertStep?.run ?? "",
        ],
        { cwd: dir, encoding: "utf8", env },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("finds the assert step", () => {
    expect(assertStep?.run).toBeTruthy();
  });

  it("passes and prints the version when the CLI prints the pin", () => {
    const res = runAssert(pkg.version, pkg.version);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`okf-kit ${pkg.version}`);
  });

  it("fails with ::error and exit 1 when the CLI prints a different version", () => {
    const res = runAssert("9.9.9", pkg.version);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("::error");
    expect(res.stdout).toContain("9.9.9");
    expect(res.stdout).toContain(pkg.version);
  });

  it("fails with ::error and exit 1 when the CLI prints nothing", () => {
    const res = runAssert("", pkg.version);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("::error");
    // The empty-output branch's own message: the mismatch branch printing
    // the pin instead must not satisfy this test.
    expect(res.stdout).toContain("printed no output");
  });

  it("fails with ::error and exit 1 when the CLI prints nothing and OKF_KIT_PIN is unset", () => {
    // The empty-output branch on its own: with the pin unset the only
    // branch that can exit 1 here is the empty-output one, so this pins
    // that branch's condition and its exit, not the mismatch branch's.
    const res = runAssert("");
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("::error");
    expect(res.stdout).toContain("printed no output");
  });

  it("fails with ::error and exit 1 when OKF_KIT_PIN is unset", () => {
    const res = runAssert(pkg.version);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("::error");
    expect(res.stdout).toContain("OKF_KIT_PIN");
  });
});
