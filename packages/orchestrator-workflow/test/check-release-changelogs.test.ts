import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The guard lives at the agent-dx repo root, two directories above this
// package (packages/orchestrator-workflow/test/..) -- see its own
// `--root` option, added for exactly this: pointing the guard at a
// disposable fixture tree instead of copying files into this repo.
const SCRIPT_PATH = fileURLToPath(
  new URL("../../../scripts/check-release-changelogs.mjs", import.meta.url),
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-release-changelogs-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePackage(
  name: string,
  version: string,
  changelog: string | undefined,
  opts: { private?: boolean } = {},
) {
  const dir = join(root, "packages", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version, ...opts }, null, 2) + "\n",
  );
  if (changelog !== undefined) {
    writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  }
}

function writeLogMd(content: string) {
  const dir = join(root, "packages", "orchestrator-workflow", "docs", "okf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "log.md"), content);
}

function commitAll(message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

// `expect` defaults to "" (opt out of rule 5, checked-package-scope):
// these fixtures use throwaway package names ("widget") that never match
// the real repo's default expectation list, so without opting out every
// test here would spuriously fail rule 5. Pass `expect: null` to omit
// --expect entirely and exercise the script's own default
// (EXPECTED_CHECKED_PACKAGES); pass a csv string to exercise rule 5
// against this fixture's own package names.
function run(args: string[], opts: { expect?: string | null } = {}) {
  const expect = opts.expect === undefined ? "" : opts.expect;
  const expectArgs = expect === null ? [] : ["--expect", expect];
  return spawnSync(
    "node",
    [SCRIPT_PATH, "--root", root, ...expectArgs, ...args],
    { encoding: "utf8" },
  );
}

const CLEAN_CHANGELOG = (version: string) =>
  `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-09-15\n\n- did a thing\n`;

// The four packages check-release-changelogs.mjs's EXPECTED_CHECKED_PACKAGES
// pins by default. Used only by the checked-package-scope tests below,
// which run with `expect: null` to exercise that real default list
// against a --root fixture that mirrors its package names.
const PINNED_PACKAGES = [
  "agent-primitives",
  "okf-kit",
  "orchestrator-workflow",
  "slop-detector",
];

function writeAllPinnedPackages() {
  for (const name of PINNED_PACKAGES) {
    writePackage(name, "1.0.0", CLEAN_CHANGELOG("1.0.0"));
  }
}

describe("check-release-changelogs.mjs", () => {
  it("exits 0 on a clean fixture with no --base", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK \(1 package/);
  });

  it("exits 0 on a clean fixture checked against --base", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    const base = commitAll("base");
    const result = run(["--base", base]);
    expect(result.status).toBe(0);
  });

  it("rule 1 (version-heading): fails when the top heading does not match package.json's version", () => {
    writePackage(
      "widget",
      "1.0.1",
      CLEAN_CHANGELOG("1.0.0"), // heading still says 1.0.0
    );
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\[version-heading\]/);
  });

  it("rule 2 (fresh-unreleased): fails when the version increased but [Unreleased] is still populated", () => {
    writePackage(
      "widget",
      "1.0.0",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0] - 2026-09-15\n\n- did a thing\n",
    );
    const base = commitAll("base at 1.0.0 with same content");
    // Head: version bump to 1.1.0, but the [Unreleased] bullet from the
    // previous cut was never moved.
    writePackage(
      "widget",
      "1.1.0",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.1.0] - 2026-09-15\n\n- did another thing\n",
    );
    const result = run(["--base", base]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\[fresh-unreleased\]/);
  });

  it("rule 2 direction guard: does NOT fire when head is an older version than base, even with a populated [Unreleased]", () => {
    // Reproduces the review's exact regression case: base 0.35.0, head
    // 0.34.0, [Unreleased] populated. A head OLDER than base must never
    // be treated as a fresh release cut.
    writePackage(
      "widget",
      "0.35.0",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [0.35.0] - 2026-09-15\n\n- did a thing\n",
    );
    const base = commitAll("base at 0.35.0");
    writePackage(
      "widget",
      "0.34.0",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [0.34.0] - 2026-09-15\n\n- did a thing\n",
    );
    const result = run(["--base", base]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/\[fresh-unreleased\]/);
  });

  it("rule 3 (log-mention-anchor): fails on a bare CHANGELOG.md:<n> mention with no anchor", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    writeLogMd("# Bundle log\n\nSee CHANGELOG.md:12 for details.\n");
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\[log-mention-anchor\]/);
  });

  it("rule 3 does not fire when the mention carries an anchor", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    writeLogMd(
      '# Bundle log\n\nSee CHANGELOG.md:12#"did a thing" for details.\n',
    );
    const result = run([]);
    expect(result.status).toBe(0);
  });

  it("rule 2 direction guard: fires on a prerelease bump rc.9 -> rc.10 (numeric segment compare, not lexical)", () => {
    // Lexical string compare would rank "rc.10" below "rc.9" ('1' < '9'),
    // wrongly treating this as no increase. Segment-wise numeric compare
    // must rank rc.10 above rc.9.
    writePackage(
      "widget",
      "1.0.0-rc.9",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0-rc.9] - 2026-09-15\n\n- did a thing\n",
    );
    const base = commitAll("base at 1.0.0-rc.9");
    writePackage(
      "widget",
      "1.0.0-rc.10",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0-rc.10] - 2026-09-15\n\n- did a thing\n",
    );
    const result = run(["--base", base]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\[fresh-unreleased\]/);
  });

  it("rule 2 direction guard: does NOT fire on a prerelease step-down rc.10 -> rc.9", () => {
    writePackage(
      "widget",
      "1.0.0-rc.10",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0-rc.10] - 2026-09-15\n\n- did a thing\n",
    );
    const base = commitAll("base at 1.0.0-rc.10");
    writePackage(
      "widget",
      "1.0.0-rc.9",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0-rc.9] - 2026-09-15\n\n- did a thing\n",
    );
    const result = run(["--base", base]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/\[fresh-unreleased\]/);
  });

  it("rule 2 direction guard: does NOT fire when only build metadata differs (+build1 -> +build2)", () => {
    // Build metadata carries no precedence per semver; equal x.y.z with
    // different build tags must never register as an increase, even
    // with a populated [Unreleased] left in place.
    writePackage(
      "widget",
      "1.0.0+build1",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0+build1] - 2026-09-15\n\n- did a thing\n",
    );
    const base = commitAll("base at 1.0.0+build1");
    writePackage(
      "widget",
      "1.0.0+build2",
      "# Changelog\n\n## [Unreleased]\n\n- leftover bullet\n\n## [1.0.0+build2] - 2026-09-15\n\n- did a thing\n",
    );
    const result = run(["--base", base]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/\[fresh-unreleased\]/);
    expect(result.stderr).not.toMatch(/\[version-heading\]/);
  });

  it("rule 4 (empty-release-section): fails when the top heading has no body", () => {
    writePackage(
      "widget",
      "1.0.0",
      "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-15\n",
    );
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\[empty-release-section\]/);
  });

  it("exit 2 on an unresolvable --base", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    const result = run(["--base", "deadbeef"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/does not resolve to a commit/);
  });

  it("exit 2 when --base looks like a flag", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    const result = run(["--base", "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/looks like a flag/);
  });

  it("exit 2 on an unrecognized flag", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    const result = run(["--nope"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unrecognized argument/);
  });

  it("exit 2 when --expect is given with no value", () => {
    writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
    const result = run(["--expect"], { expect: null });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--expect requires/);
  });

  describe("rule 5 (checked-package-scope)", () => {
    // These three tests pass `expect: null` (omit --expect entirely) so
    // the script falls back to its own default expectation list
    // (EXPECTED_CHECKED_PACKAGES: agent-primitives, okf-kit,
    // orchestrator-workflow, slop-detector) against a --root fixture that
    // mirrors those exact package names. This is also what discriminates
    // a mutant that empties EXPECTED_CHECKED_PACKAGES: with an empty
    // list rule 5 never fires (see the --expect "" opt-out test below),
    // so exercising the *default* (no --expect at all) is required to
    // catch that regression.

    it("fails when a pinned package's CHANGELOG.md is deleted", () => {
      writeAllPinnedPackages();
      rmSync(join(root, "packages", "agent-primitives", "CHANGELOG.md"));
      const result = run([], { expect: null });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/\[checked-package-scope\]/);
      expect(result.stderr).toMatch(/agent-primitives/);
    });

    it("fails when a pinned package is flipped to private", () => {
      writeAllPinnedPackages();
      writePackage("okf-kit", "1.0.0", CLEAN_CHANGELOG("1.0.0"), {
        private: true,
      });
      const result = run([], { expect: null });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/\[checked-package-scope\]/);
      expect(result.stderr).toMatch(/okf-kit/);
      expect(result.stdout).toMatch(/skipping \(private\): okf-kit/);
    });

    it("reports a package.json without a version through the fallback notice instead of crashing", () => {
      writeAllPinnedPackages();
      const base = commitAll("base with a versioned okf-kit");
      writeFileSync(
        join(root, "packages", "okf-kit", "package.json"),
        JSON.stringify({ name: "okf-kit" }, null, 2) + "\n",
      );
      const result = run(["--base", base], { expect: null });
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).not.toMatch(/TypeError/);
      expect(result.stderr + result.stdout).toMatch(
        /version-heading|could not parse/,
      );
    });

    it("still passes when a fifth, unpinned package with its own CHANGELOG is present", () => {
      writeAllPinnedPackages();
      writePackage("extra-package", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
      const result = run([], { expect: null });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/OK \(5 package/);
    });

    it('--expect "" opts out: an empty expectation list never fires, even with every pinned package missing', () => {
      writePackage("widget", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
      const result = run([]); // default run(): expect: "" (opt-out)
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /skipping rule 5 \(checked-package-scope\): --expect is empty/,
      );
    });

    it("--expect <csv> checks a fixture's own package names", () => {
      writePackage("alpha", "1.0.0", CLEAN_CHANGELOG("1.0.0"));
      // "beta" is pinned via --expect but never written: must fail.
      const result = run([], { expect: "alpha,beta" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/\[checked-package-scope\]/);
      expect(result.stderr).toMatch(/beta/);
    });
  });
});
