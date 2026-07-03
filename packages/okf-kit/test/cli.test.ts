import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "./helpers.js";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CLI = path.join(PKG_ROOT, "dist", "cli.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Spawns the built CLI as a real subprocess so exit codes can be asserted
// without process.exit() inside cli.ts killing the test runner.
function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("okf-kit cli", () => {
  it("exits 0 on a valid bundle", () => {
    const result = run(["check", path.join(FIXTURES_DIR, "valid-bundle")]);
    expect(result.status).toBe(0);
  });

  it("exits 1 on a bundle with a broken link", () => {
    const result = run(["check", path.join(FIXTURES_DIR, "broken-link")]);
    expect(result.status).toBe(1);
  });

  it("exits 0 on the absolute-link fixture without --strict", () => {
    const result = run(["check", path.join(FIXTURES_DIR, "absolute-link")]);
    expect(result.status).toBe(0);
  });

  it("exits 1 on the absolute-link fixture with --strict", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "absolute-link"),
      "--strict",
    ]);
    expect(result.status).toBe(1);
  });

  it("emits parsable JSON with summary counts", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "broken-link"),
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      bundleDir: string;
      findings: unknown[];
      summary: { errors: number; warnings: number; notices: number };
    };
    expect(parsed.summary).toEqual({ errors: 1, warnings: 0, notices: 0 });
    expect(parsed.findings).toHaveLength(1);
  });

  it("exits 2 when the bundle directory does not exist", () => {
    const result = run(["check", path.join(FIXTURES_DIR, "does-not-exist")]);
    expect(result.status).toBe(2);
  });

  it("exits 2 on an unknown option, distinct from exit 1 (bundle has findings)", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "valid-bundle"),
      "--bogus",
    ]);
    expect(result.status).toBe(2);
  });

  it("exits 2 when the bundleDir argument is missing", () => {
    const result = run(["check"]);
    expect(result.status).toBe(2);
  });

  it("exits 1 on a broken link with a quoted title", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "broken-link-titled"),
    ]);
    expect(result.status).toBe(1);
  });

  it("exits 1 on a broken link in angle-bracket form", () => {
    const result = run(["check", path.join(FIXTURES_DIR, "broken-link-angle")]);
    expect(result.status).toBe(1);
  });

  interface JsonReport {
    findings: Array<{ ruleId: string }>;
  }

  it("includes frontmatter-required in --json findings for the missing-frontmatter fixture (exit 1)", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "missing-frontmatter"),
      "--json",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as JsonReport;
    expect(
      parsed.findings.some((f) => f.ruleId === "frontmatter-required"),
    ).toBe(true);
  });

  it("includes reserved-files-bare in --json findings for the frontmatter-on-reserved fixture (exit 1)", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "frontmatter-on-reserved"),
      "--json",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as JsonReport;
    expect(
      parsed.findings.some((f) => f.ruleId === "reserved-files-bare"),
    ).toBe(true);
  });

  it("includes sources-shape in --json findings for the bad-sources-shape fixture (exit 1)", () => {
    const result = run([
      "check",
      path.join(FIXTURES_DIR, "bad-sources-shape"),
      "--json",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as JsonReport;
    expect(parsed.findings.some((f) => f.ruleId === "sources-shape")).toBe(
      true,
    );
  });
});
