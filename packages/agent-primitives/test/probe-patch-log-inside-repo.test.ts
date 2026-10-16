import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchGitEnv } from "../src/git-env.js";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import { listPatchTouchedPaths } from "../src/probe/mutant.js";

/**
 * A git-style patch (`a/<path>` and `b/<path>` headers, paths relative to
 * the repository root) for a file in a subdirectory, with the probe's log
 * directory INSIDE the checkout (the `-l .ap-logs` shape). The dry run and
 * the `--file` derivation run `git apply` in a scratch directory under the
 * log directory; git used to discover the enclosing checkout from there and
 * skip every patch path outside the scratch directory's subtree, so the
 * apply exited 0 having changed nothing.
 */

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function unused(n) {",
  "  return n * 2;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

const tmpDirs: string[] = [];
let savedLockDir: string | undefined;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-patch-inside-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

function useLockDir(): void {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  process.env.AGENT_PRIMITIVES_LOCK_DIR = makeTmpDir();
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repository whose `pkg/` subdirectory holds the fixture and its test,
 * like a monorepo package. */
function initMonorepo(): string {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "diff.noprefix", "false"]);
  git(repo, ["config", "diff.mnemonicPrefix", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(repo, "pkg"));
  fs.writeFileSync(path.join(repo, "pkg", "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "pkg", "fixture.test.js"), FIXTURE_TEST_JS);
  fs.writeFileSync(path.join(repo, "pkg", "other.js"), "module.exports = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return repo;
}

function writePatch(lines: string[]): string {
  const patchPath = path.join(makeTmpDir(), "mutant.patch");
  fs.writeFileSync(patchPath, lines.join("\n") + "\n");
  return patchPath;
}

/** `return n > 0;` -> `return false;` in `pkg/fixture.js`, paths relative
 * to the repository root. */
function fixturePatchLines(): string[] {
  const lines = FIXTURE_JS.split("\n");
  return [
    "diff --git a/pkg/fixture.js b/pkg/fixture.js",
    "index 0000000..0000000 100644",
    "--- a/pkg/fixture.js",
    "+++ b/pkg/fixture.js",
    "@@ -1,3 +1,3 @@",
    ` ${lines[0]}`,
    `-${lines[1]}`,
    "+  return false;",
    ` ${lines[2]}`,
  ];
}

function otherPatchLines(): string[] {
  return [
    "diff --git a/pkg/other.js b/pkg/other.js",
    "index 0000000..0000000 100644",
    "--- a/pkg/other.js",
    "+++ b/pkg/other.js",
    "@@ -1 +1 @@",
    "-module.exports = 1;",
    "+module.exports = 2;",
  ];
}

function options(
  repo: string,
  patchPath: string,
  overrides: Partial<ProbeOptions>,
): ProbeOptions {
  return {
    cwd: path.join(repo, "pkg"),
    file: "fixture.js",
    form: "patch",
    patchPath,
    testCommand: "node fixture.test.js",
    isolation: "inplace",
    expect: "fail",
    logDir: path.join(repo, "pkg", ".ap-logs"),
    ...overrides,
  };
}

describe("probe(): -p patch with the log directory inside the checkout", () => {
  for (const isolation of ["inplace", "worktree"] as const) {
    it(`applies, kills and restores a root-relative patch for a subdirectory file (${isolation})`, async () => {
      useLockDir();
      const repo = initMonorepo();
      const patchPath = writePatch(fixturePatchLines());

      const result = await probe(options(repo, patchPath, { isolation }));

      expect(result.warnings).toEqual([]);
      expect(result.status).toBe("killed");
      expect(result.mutant?.form).toBe("patch");
      expect(result.mutant?.line).toBe(2);
      expect(result.mutant?.before).toBe("  return n > 0;");
      expect(result.mutant?.after).toBe("  return false;");
      expect(result.mutation_probe?.restored_verified).toBe(true);
      expect(
        fs.readFileSync(path.join(repo, "pkg", "fixture.js"), "utf8"),
      ).toBe(FIXTURE_JS);
    });
  }

  it("derives --file from the patch when the log directory is inside the checkout", async () => {
    useLockDir();
    const repo = initMonorepo();
    const patchPath = writePatch(fixturePatchLines());

    const result = await probe(
      options(repo, patchPath, {
        file: undefined,
        cwd: repo,
        testCommand: "node pkg/fixture.test.js",
      }),
    );

    expect(result.status).toBe("killed");
    expect(result.mutant?.file).toBe(path.join(repo, "pkg", "fixture.js"));
    expect(result.mutation_probe?.restored_verified).toBe(true);
  });

  it("lists the paths a patch touches from a scratch directory under a checkout", async () => {
    const repo = initMonorepo();
    const patchPath = writePatch(fixturePatchLines());

    const listing = await listPatchTouchedPaths(
      patchPath,
      path.join(repo, "pkg", ".ap-logs"),
      {},
    );

    expect(listing.ok).toBe(true);
    expect(listing.ok && listing.paths).toEqual(["pkg/fixture.js"]);
  });

  for (const isolation of ["inplace", "worktree"] as const) {
    it(`still refuses a patch that also touches another file, naming it and the --file target (${isolation})`, async () => {
      useLockDir();
      const repo = initMonorepo();
      const patchPath = writePatch([
        ...fixturePatchLines(),
        ...otherPatchLines(),
      ]);

      const result = await probe(options(repo, patchPath, { isolation }));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("mutant_not_applicable");
      const warning = result.warnings.join("\n");
      expect(warning).toContain("patch touches paths other than --file");
      expect(warning).toContain(path.join("pkg", "fixture.js"));
      expect(warning).toContain(path.join("pkg", "other.js"));
      expect(fs.readFileSync(path.join(repo, "pkg", "other.js"), "utf8")).toBe(
        "module.exports = 1;\n",
      );
      expect(
        fs.readFileSync(path.join(repo, "pkg", "fixture.js"), "utf8"),
      ).toBe(FIXTURE_JS);
    });
  }
});

describe("scratchGitEnv()", () => {
  it("sets a ceiling at the scratch directory's real parent, keeps an ambient ceiling, and drops repository selection", () => {
    const saved = {
      ceiling: process.env.GIT_CEILING_DIRECTORIES,
      dir: process.env.GIT_DIR,
    };
    try {
      process.env.GIT_CEILING_DIRECTORIES = "/ambient-ceiling";
      process.env.GIT_DIR = "/somewhere/.git";
      const parent = makeTmpDir();
      const env = scratchGitEnv(path.join(parent, "scratch"));
      expect(env.GIT_CEILING_DIRECTORIES).toBe(
        `${fs.realpathSync(parent)}${path.delimiter}/ambient-ceiling`,
      );
      expect(env.GIT_DIR).toBeUndefined();
    } finally {
      for (const [name, value] of [
        ["GIT_CEILING_DIRECTORIES", saved.ceiling],
        ["GIT_DIR", saved.dir],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
