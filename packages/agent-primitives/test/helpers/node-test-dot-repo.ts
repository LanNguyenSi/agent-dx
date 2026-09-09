import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A throwaway `node --test` project: `calc.js` exports `add` (tested)
 * and `unused` (never referenced by the test file at all), `calc.test.js`
 * runs two passing tests against `add` with `--test-reporter=dot` (bare
 * `..`, no summary line either built-in zero-tests detector recognizes).
 * Mutating `unused` is a genuine, legitimate survivor: the suite never
 * exercises it, so both the baseline and the mutant run print the exact
 * same `..` and exit `0` -- this is real "the test does not cover this
 * line" evidence, not a runner that ran nothing.
 *
 * Shared by `probe-zero-tests.test.ts` (the single-probe path) and
 * `plan.test.ts` (the plan path). `makeTmpDir` is the caller's own
 * tmp-dir helper, so cleanup stays registered with that suite's own
 * `afterEach`, not this module. */
export function initNodeTestDotRepo(makeTmpDir: () => string): string {
  const repo = makeTmpDir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, "calc.js"),
    [
      "function add(a, b) {",
      "  return a + b;",
      "}",
      "function unused(a, b) {",
      "  return a + b;",
      "}",
      "module.exports = { add, unused };",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repo, "calc.test.js"),
    [
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      "const { add } = require('./calc.js');",
      "test('add', () => { assert.strictEqual(add(1, 2), 3); });",
      "test('add2', () => { assert.strictEqual(add(2, 2), 4); });",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );
  return repo;
}
