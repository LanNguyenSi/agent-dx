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

// Drives scripts/bump-okf-kit-pin.mjs (task 7d17996d) as a real subprocess
// against a throwaway fixture repo, never the actual agent-dx tree: the
// script rewrites files under `.github/workflows/` relative to its own
// location, so the only safe way to exercise it end to end is to give it
// its own tiny copy of that repo shape (see scripts/bump-okf-kit-pin.mjs's
// own doc comment for why the pin bump needs to be mechanical at all).

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
  opts: { version: string; skipCi?: boolean; noPinInCi?: boolean },
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
    writeFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      opts.noPinInCi ? "name: CI\non: [push]\n" : ciYml(opts.version),
      "utf8",
    );
  }
  writeFileSync(
    join(dir, ".github", "workflows", "okf-staleness.yml"),
    staleYml(opts.version),
    "utf8",
  );
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

    const ci = readFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const stale = readFileSync(
      join(dir, ".github", "workflows", "okf-staleness.yml"),
      "utf8",
    );
    expect(ci).toContain("npm install -g okf-kit@0.9.1");
    expect(ci).not.toContain("okf-kit@0.9.0");
    expect(stale).toContain("npm install -g okf-kit@0.9.1");
    expect(stale).not.toContain("okf-kit@0.9.0");
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
    const ci = readFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(ci).toContain("npm install -g okf-kit@0.9.1");
  });

  it("is idempotent: a second run once pins already match the target changes nothing and still exits 0", () => {
    scaffoldRepo(dir, { version: "0.9.0" });

    const first = runScript(dir, ["0.9.1"]);
    expect(first.status).toBe(0);

    const ciAfterFirst = readFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const staleAfterFirst = readFileSync(
      join(dir, ".github", "workflows", "okf-staleness.yml"),
      "utf8",
    );

    const second = runScript(dir, ["0.9.1"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(
      ".github/workflows/ci.yml: okf-kit@0.9.1 -> okf-kit@0.9.1",
    );

    const ciAfterSecond = readFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const staleAfterSecond = readFileSync(
      join(dir, ".github", "workflows", "okf-staleness.yml"),
      "utf8",
    );
    expect(ciAfterSecond).toBe(ciAfterFirst);
    expect(staleAfterSecond).toBe(staleAfterFirst);
  });

  it("exits non-zero and names the file when a target workflow has no pin line to rewrite", () => {
    scaffoldRepo(dir, { version: "0.9.0", noPinInCi: true });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(".github/workflows/ci.yml");

    // The file that DID have a pin line still gets rewritten; a missing
    // pin in one file must not silently swallow a real bump in another.
    const stale = readFileSync(
      join(dir, ".github", "workflows", "okf-staleness.yml"),
      "utf8",
    );
    expect(stale).toContain("npm install -g okf-kit@0.9.1");
  });

  it("exits non-zero and names the file when the ci.yml file is missing entirely", () => {
    scaffoldRepo(dir, { version: "0.9.0", skipCi: true });

    const result = runScript(dir, ["0.9.1"]);

    expect(result.status).not.toBe(0);
  });
});
