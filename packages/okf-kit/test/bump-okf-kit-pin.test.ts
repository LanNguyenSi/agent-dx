import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives scripts/bump-okf-kit-pin.mjs as a real subprocess against a
// throwaway fixture repo, never the actual agent-dx tree: the script
// rewrites files under `.github/workflows/` relative to its own location,
// so the only safe way to exercise it end to end is to give it its own
// tiny copy of that repo shape (see scripts/bump-okf-kit-pin.mjs's own
// doc comment for why the pin bump needs to be mechanical at all).

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT_SOURCE = readFileSync(
  join(REPO_ROOT, "scripts", "bump-okf-kit-pin.mjs"),
  "utf8",
);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(cwd: string, args: string[] = []): RunResult {
  try {
    const stdout = execFileSync(
      "node",
      [join(cwd, "scripts", "bump-okf-kit-pin.mjs"), ...args],
      { encoding: "utf8", cwd },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

function ciYml(version: string): string {
  return [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  okf-anchor-guard:",
    "    steps:",
    `        run: npm install -g okf-kit@${version}`,
    "",
  ].join("\n");
}

function staleYml(version: string): string {
  return [
    "name: okf-staleness",
    "on: [schedule]",
    "jobs:",
    "  check:",
    "    steps:",
    `        run: npm install -g okf-kit@${version}`,
    "",
  ].join("\n");
}

function scaffoldRepo(
  dir: string,
  opts: {
    version: string;
    skipCi?: boolean;
    noPinInCi?: boolean;
    ciContent?: string;
    extraWorkflow?: { name: string; content: string };
  },
): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(dir, "packages", "okf-kit"), { recursive: true });

  writeFileSync(
    join(dir, "scripts", "bump-okf-kit-pin.mjs"),
    SCRIPT_SOURCE,
    "utf8",
  );
  writeFileSync(
    join(dir, "packages", "okf-kit", "package.json"),
    JSON.stringify({ name: "okf-kit", version: opts.version }, null, 2),
    "utf8",
  );

  if (!opts.skipCi) {
    const content =
      opts.ciContent ??
      (opts.noPinInCi ? "name: CI\non: [push]\n" : ciYml(opts.version));
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), content, "utf8");
  }
  writeFileSync(
    join(dir, ".github", "workflows", "okf-staleness.yml"),
    staleYml(opts.version),
    "utf8",
  );

  if (opts.extraWorkflow) {
    writeFileSync(
      join(dir, ".github", "workflows", opts.extraWorkflow.name),
      opts.extraWorkflow.content,
      "utf8",
    );
  }
}

function readWorkflow(dir: string, name: string): string {
  return readFileSync(join(dir, ".github", "workflows", name), "utf8");
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bump-okf-kit-pin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bump-okf-kit-pin.mjs", () => {
  it("rewrites the pin line in both ci.yml and okf-staleness.yml to the target version", () => {
    scaffoldRepo(dir, { version: "0.9.0" });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      ".github/workflows/ci.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
    );
    expect(result.stdout).toContain(
      ".github/workflows/okf-staleness.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
    );

    const ci = readWorkflow(dir, "ci.yml");
    const stale = readWorkflow(dir, "okf-staleness.yml");
    expect(ci).toContain("npm install -g okf-kit@0.9.1");
    expect(ci).not.toContain("okf-kit@0.9.0");
    expect(stale).toContain("npm install -g okf-kit@0.9.1");
    expect(stale).not.toContain("okf-kit@0.9.0");
  });

  it("rewrites two install pins in the same file, both occurrences", () => {
    const twoPins = [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  okf-anchor-guard:",
      "    steps:",
      "        run: npm install -g okf-kit@0.9.0",
      "  okf-anchor-guard-2:",
      "    steps:",
      "        run: npm install -g okf-kit@0.9.0",
      "",
    ].join("\n");
    scaffoldRepo(dir, { version: "0.9.0", ciContent: twoPins });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).toBe(0);
    const occurrences = result.stdout
      .split("\n")
      .filter((line) => line.includes(".github/workflows/ci.yml:"));
    expect(occurrences).toHaveLength(2);
    for (const line of occurrences) {
      expect(line).toBe(
        ".github/workflows/ci.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
      );
    }

    const ci = readWorkflow(dir, "ci.yml");
    expect(ci).not.toContain("okf-kit@0.9.0");
    expect(ci.match(/okf-kit@0\.9\.1/g)).toHaveLength(2);
  });

  it("rewrites an npx-form pin", () => {
    const npxForm = [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  check:",
      "    steps:",
      "        run: npx okf-kit@0.9.0 check docs/okf",
      "",
    ].join("\n");
    scaffoldRepo(dir, { version: "0.9.0", ciContent: npxForm });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      ".github/workflows/ci.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
    );
    const ci = readWorkflow(dir, "ci.yml");
    expect(ci).toContain("npx okf-kit@0.9.1 check docs/okf");
    expect(ci).not.toContain("okf-kit@0.9.0");
  });

  it("rewrites a pin in a workflow file outside the two named ones", () => {
    scaffoldRepo(dir, {
      version: "0.9.0",
      extraWorkflow: {
        name: "extra-check.yml",
        content: [
          "name: extra",
          "on: [push]",
          "jobs:",
          "  check:",
          "    steps:",
          "        run: npm install -g okf-kit@0.9.0",
          "",
        ].join("\n"),
      },
    });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      ".github/workflows/extra-check.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
    );
    const extra = readWorkflow(dir, "extra-check.yml");
    expect(extra).toContain("npm install -g okf-kit@0.9.1");
  });

  it("leaves a comment mention of okf-kit@<version> untouched (negative control)", () => {
    scaffoldRepo(dir, { version: "0.9.0" });
    const withComment = [
      "name: okf-staleness",
      "on: [schedule]",
      "jobs:",
      "  check:",
      "    steps:",
      "        # Exact pin: okf-kit@0.3.0 on npm is a deprecated silent no-op",
      "        run: npm install -g okf-kit@0.9.0",
      "",
    ].join("\n");
    writeFileSync(
      join(dir, ".github", "workflows", "okf-staleness.yml"),
      withComment,
      "utf8",
    );

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).toBe(0);
    const stale = readWorkflow(dir, "okf-staleness.yml");
    expect(stale).toContain(
      "# Exact pin: okf-kit@0.3.0 on npm is a deprecated silent no-op",
    );
    expect(stale).toContain("npm install -g okf-kit@0.9.1");
  });

  it("defaults the target version to packages/okf-kit/package.json's version when no argument is given", () => {
    scaffoldRepo(dir, { version: "0.9.0" });
    // Bump package.json ahead of the workflow pins, as a real release does.
    writeFileSync(
      join(dir, "packages", "okf-kit", "package.json"),
      JSON.stringify({ name: "okf-kit", version: "0.9.1" }, null, 2),
      "utf8",
    );

    const result = runScript(dir);

    expect(result.status).toBe(0);
    const ci = readWorkflow(dir, "ci.yml");
    expect(ci).toContain("npm install -g okf-kit@0.9.1");
  });

  it("is idempotent: a second run once pins already match the target changes nothing and still exits 0", () => {
    scaffoldRepo(dir, { version: "0.9.0" });

    const first = runScript(dir, ["0.9.1"]);
    expect(first.status).toBe(0);

    const ciAfterFirst = readWorkflow(dir, "ci.yml");
    const staleAfterFirst = readWorkflow(dir, "okf-staleness.yml");

    const second = runScript(dir, ["0.9.1"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(
      ".github/workflows/ci.yml: okf-kit@0.9.1 -> okf-kit@0.9.1",
    );

    const ciAfterSecond = readWorkflow(dir, "ci.yml");
    const staleAfterSecond = readWorkflow(dir, "okf-staleness.yml");
    expect(ciAfterSecond).toBe(ciAfterFirst);
    expect(staleAfterSecond).toBe(staleAfterFirst);
  });

  it("--dry-run prints old -> new for every occurrence and writes nothing", () => {
    scaffoldRepo(dir, { version: "0.9.0" });
    const ciBefore = readWorkflow(dir, "ci.yml");
    const staleBefore = readWorkflow(dir, "okf-staleness.yml");

    const result = runScript(dir, ["--dry-run", "0.9.1"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      ".github/workflows/ci.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
    );
    expect(result.stdout).toContain(
      ".github/workflows/okf-staleness.yml: okf-kit@0.9.0 -> okf-kit@0.9.1",
    );

    expect(readWorkflow(dir, "ci.yml")).toBe(ciBefore);
    expect(readWorkflow(dir, "okf-staleness.yml")).toBe(staleBefore);
  });

  it("rejects an unrecognized flag and writes nothing", () => {
    scaffoldRepo(dir, { version: "0.9.0" });
    const ciBefore = readWorkflow(dir, "ci.yml");
    const staleBefore = readWorkflow(dir, "okf-staleness.yml");

    const result = runScript(dir, ["--bogus"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--bogus");
    expect(readWorkflow(dir, "ci.yml")).toBe(ciBefore);
    expect(readWorkflow(dir, "okf-staleness.yml")).toBe(staleBefore);
  });

  it("rejects an empty-string version argument and writes nothing", () => {
    scaffoldRepo(dir, { version: "0.9.0" });
    const ciBefore = readWorkflow(dir, "ci.yml");
    const staleBefore = readWorkflow(dir, "okf-staleness.yml");

    const result = runScript(dir, [""]);

    expect(result.status).not.toBe(0);
    expect(readWorkflow(dir, "ci.yml")).toBe(ciBefore);
    expect(readWorkflow(dir, "okf-staleness.yml")).toBe(staleBefore);
  });

  it("rejects a version carrying build metadata (+build) and writes nothing", () => {
    scaffoldRepo(dir, { version: "0.9.0" });
    const ciBefore = readWorkflow(dir, "ci.yml");
    const staleBefore = readWorkflow(dir, "okf-staleness.yml");

    // The parity guard's capture class cannot read a `+` back, so a pin
    // written with build metadata would report success and still leave
    // the guard red; the script refuses the version instead.
    const result = runScript(dir, ["0.9.2+build.1"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
    expect(readWorkflow(dir, "ci.yml")).toBe(ciBefore);
    expect(readWorkflow(dir, "okf-staleness.yml")).toBe(staleBefore);
  });

  it("exits non-zero when no okf-kit pin exists anywhere under .github/workflows/", () => {
    scaffoldRepo(dir, { version: "0.9.0", noPinInCi: true });
    writeFileSync(
      join(dir, ".github", "workflows", "okf-staleness.yml"),
      "name: okf-staleness\non: [schedule]\n",
      "utf8",
    );

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pin found");
  });

  it("exits non-zero and names the file when a target workflow has no pin line to rewrite", () => {
    scaffoldRepo(dir, { version: "0.9.0", noPinInCi: true });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(".github/workflows/ci.yml");

    // The file that DID have a pin line still gets rewritten; a missing
    // pin in one file must not silently swallow a real bump in another.
    const stale = readWorkflow(dir, "okf-staleness.yml");
    expect(stale).toContain("npm install -g okf-kit@0.9.1");
  });

  it("exits non-zero and names the file when the ci.yml file is missing entirely, and writes nothing", () => {
    scaffoldRepo(dir, { version: "0.9.0", skipCi: true });
    const staleBefore = readWorkflow(dir, "okf-staleness.yml");

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(".github/workflows/ci.yml");
    // Missing a required file must fail before anything is written, not
    // rewrite whatever files do exist and only fail on the missing one.
    expect(readWorkflow(dir, "okf-staleness.yml")).toBe(staleBefore);
  });
});
