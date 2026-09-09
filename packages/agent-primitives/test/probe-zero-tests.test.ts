import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  probe,
  type ProbeOptions,
  type ProbeResult,
} from "../src/probe/index.js";
import {
  detectKnownZeroTestsEvidence,
  hasKnownTestSummary,
} from "../src/probe/zero-tests.js";
import { initNodeTestDotRepo } from "./helpers/node-test-dot-repo.js";

/**
 * Zero-tests-executed detection (task `273b3851`): a baseline (or a
 * mutant run) that exits `0` with nothing actually executed must never
 * be read as a real pass. See the CHANGELOG's `Unreleased` entry for the
 * real bug this closes (batch 43, a vitest `-t "name (with parens)"`
 * filter matching no test inside files vitest still loaded, `130
 * skipped` on both the baseline and the mutant run, reported
 * `survived`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, "..");
const VITEST_ENTRY = path.join(
  PKG_ROOT,
  "node_modules",
  "vitest",
  "vitest.mjs",
);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-zero-tests-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Unit-level detector tests (synthetic output, no real vitest/node
// process involved -- see the live-fixture describe block below for the
// real end-to-end pair). ---------------------------------------------

describe("detectKnownZeroTestsEvidence()", () => {
  it("vitest: 'No test files found' (no matching file at all)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "\n RUN  v4.1.11 /project\n\nNo test files found, exiting with code 1\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "vitest" });
  });

  it("vitest: an all-skipped Tests summary (0 passed, 0 failed)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      " Test Files  1 skipped (1)\n      Tests  2 skipped (2)\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "vitest" });
  });

  it("vitest: a real, executed, passing summary is NOT flagged (negative control)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      " Test Files  1 passed (1)\n      Tests  2 passed (2)\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("vitest: a mixed run (some passed, some skipped) is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      " Test Files  1 passed (1)\n      Tests  1 passed | 1 skipped (2)\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("node --test: the spec reporter's zero-count summary", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "ℹ tests 0\nℹ pass 0\nℹ fail 0\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "node_test" });
  });

  it("node --test: the tap reporter's zero-count summary", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "node_test" });
  });

  it("node --test: a real, executed count is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "ℹ tests 1\nℹ pass 1\nℹ fail 0\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("an unrecognized runner's output is not flagged by either detector", () => {
    const evidence = detectKnownZeroTestsEvidence("all good, 0 issues\n", "");
    expect(evidence).toEqual({ detected: false });
  });
});

describe("hasKnownTestSummary()", () => {
  it("true for a vitest summary, zero-count or not", () => {
    expect(hasKnownTestSummary(" Tests  2 passed (2)\n", "")).toBe(true);
    expect(hasKnownTestSummary(" Tests  2 skipped (2)\n", "")).toBe(true);
  });

  it("true for a node --test summary line", () => {
    expect(hasKnownTestSummary("ℹ tests 3\n", "")).toBe(true);
  });

  it("false for output neither detector recognizes", () => {
    expect(hasKnownTestSummary("ok\n", "")).toBe(false);
    expect(hasKnownTestSummary("", "")).toBe(false);
  });
});

// --- probe() through the shared baseline-stage check (setup.ts): a
// synthetic testCommand stands in for a real test runner's output, the
// same idiom test/probe-refusal-contract.test.ts's own provocations
// use. -----------------------------------------------------------------

function initGitRepo(): string {
  const repo = makeTmpDir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, "fixture.js"),
    "module.exports = { flag: true };\n",
  );
  // Real, dependent test (reads fixture.js, prints "ready" only once its
  // own assertion has already passed): unlike a fixed echo, mutating
  // fixture.js genuinely changes this test command's outcome, so a
  // negative control built on it is not itself ambiguous between "ran
  // for real" and "printed the same fixed text either way".
  fs.writeFileSync(
    path.join(repo, "fixture.test.js"),
    [
      "const assert = require('node:assert');",
      "const { flag } = require('./fixture.js');",
      "assert.strictEqual(flag, true);",
      "console.log('ready');",
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

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 1,
    form: "replace",
    replaceText: "module.exports = { flag: false };",
    testCommand: "exit 0",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("probe(): baseline-stage no_tests_executed refusal", () => {
  it("a baseline that exits 0 but whose own output is an all-skipped vitest summary is refused, never a verdict", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log(' Test Files  1 skipped (1)'); console.log('      Tests  2 skipped (2)');\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe("no_tests_executed");
    expect(result.mutant).toBeDefined();
  });

  it("a baseline that exits 1 with vitest's own 'No test files found' text is no_tests_executed, never baseline_failed", async () => {
    // Reviewer round-1 finding: the check just above is ordered BEFORE
    // the exit-code branch specifically so vitest's exit-1 "No test
    // files found" shape (as opposed to the exit-0 all-skipped/`-t`
    // shape the test above pins) is still read as `no_tests_executed`,
    // never misread as a genuinely failing baseline.
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log('No test files found, exiting with code 1'); process.exit(1);\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
  });

  it("negative control: a baseline that genuinely runs and passes (and a mutant the suite genuinely catches) is never flagged", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, { testCommand: "node fixture.test.js" }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });
});

describe("probe(): --require-baseline-evidence", () => {
  it("refuses baseline_evidence_not_matched when the pattern does not match the baseline output", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand: "node fixture.test.js",
        requireBaselineEvidence: /this text never appears/,
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_evidence_not_matched");
    expect(result.mutation_probe?.result).toBe("not_run");
  });

  it("proceeds normally (to a real killed verdict) once the pattern matches the baseline output", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand: "node fixture.test.js",
        requireBaselineEvidence: /ready/,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  it("a truncated baseline tail that missed the pattern names the truncation in the warning", async () => {
    // Reviewer round-1 finding: `--require-baseline-evidence` (like the
    // zero-tests detectors) only ever sees the CAPTURED tail
    // (`exec.ts`'s 60-line/6000-char bound). A pattern printed first,
    // then scrolled out of the tail by >60 filler lines, reads as a
    // plain miss unless the warning names the truncation.
    const repo = initGitRepo();
    const fillerLines = Array.from(
      { length: 120 },
      (_, i) => `console.log('filler line ${i}');`,
    ).join(" ");
    const result = await probe(
      baseOptions(repo, {
        testCommand: `node -e "console.log('EVIDENCE-LINE'); ${fillerLines}"`,
        requireBaselineEvidence: /EVIDENCE-LINE/,
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_evidence_not_matched");
    expect(
      result.warnings.some((w) => /captured stdout tail was truncated/.test(w)),
    ).toBe(true);
  });
});

// --- The mutant-side zero-tests detector (step.ts's classify step),
// pinned independently of criterion 2's fixture pair: there, the
// BASELINE itself is zero-tests-shaped, so setup.ts refuses before
// step.ts is ever reached and the mutant-side branch is never exercised.
// Here the baseline is a genuine, executed pass and only the MUTANT run
// flips to a known zero-tests shape, so only step.ts's own detector (not
// setup.ts's) can catch it. -------------------------------------------

function initRunnerRepo(): string {
  const repo = makeTmpDir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, "runner.js"),
    [
      "console.log(' Test Files  1 passed (1)');",
      "console.log('      Tests  2 passed (2)');",
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

describe("probe(): mutant-side zero-tests detector (step.ts)", () => {
  it("a mutant that flips the runner's own summary line to a known zero-tests shape, still exit 0, is refused, never survived", async () => {
    const repo = initRunnerRepo();
    const result = await probe(
      baseOptions(repo, {
        file: "runner.js",
        line: 2,
        replaceText: "console.log('No test files found, exiting with code 1');",
        testCommand: "node runner.js",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(
      result.warnings.some((w) =>
        /the mutant run's own output shows no test was actually executed/.test(
          w,
        ),
      ),
    ).toBe(true);
  });
});

// --- The generic byte-identical fallback's opt-out via
// `--require-baseline-evidence`, and its truncation guard: real `node
// --test` runs, since the `--test-reporter=dot` shape (bare `..`, no
// summary line either built-in detector recognizes) is exactly the
// "quiet deterministic runner" the fallback exists for and the escape
// hatch is meant to unblock. -------------------------------------------

function dotReporterOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "calc.js",
    line: 5,
    form: "replace",
    // Mutates the untested `unused` function only: the tested `add`
    // path, and therefore the dot reporter's `..` output, is unaffected
    // either way -- a genuine, legitimate survivor.
    replaceText: "  return a - b;",
    testCommand: "node --test --test-reporter=dot calc.test.js",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("probe(): generic byte-identical fallback, --require-baseline-evidence opt-out", () => {
  it("without --require-baseline-evidence, a genuine dot-reporter survivor is read as inconclusive/no_tests_executed by design", async () => {
    const repo = initNodeTestDotRepo(makeTmpDir);
    const result = await probe(dotReporterOptions(repo));
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
  });

  it("with a matching --require-baseline-evidence, the same dot-reporter survivor stays survived, not second-guessed", async () => {
    const repo = initNodeTestDotRepo(makeTmpDir);
    const result = await probe(
      dotReporterOptions(repo, { requireBaselineEvidence: /\.\./ }),
    );
    expect(result.status).toBe("survived");
    expect(result.reason).toBeUndefined();
  });
});

describe("probe(): generic byte-identical fallback, truncated-tail guard", () => {
  it("never fires when either side's captured tail was truncated, even on byte-identical unknown output", async () => {
    // A genuine, legitimate survivor (an untested function mutated) whose
    // runner prints >60 identical lines of unrecognized text on both the
    // baseline and the mutant run: without the truncation guard, the
    // byte-identical (truncated) tails would misread this as
    // `no_tests_executed`; with it, the real `survived` verdict stands.
    const repo = initGitRepo();
    const fillerLines = Array.from(
      { length: 120 },
      (_, i) => `console.log('noise line ${i}');`,
    ).join(" ");
    const result = await probe(
      baseOptions(repo, {
        // The default mutant (flips `flag`) is a genuine survivor here:
        // the noisy command below never requires('./fixture.js') at all,
        // so it cannot observe the mutation either way.
        testCommand: `node -e "${fillerLines}"`,
      }),
    );
    expect(result.status).toBe("survived");
    expect(result.reason).toBeUndefined();
  });
});

// --- The mutant-side detector and the generic fallback also apply to a
// `killed` verdict whose "killed"-ness rests on nothing but a PASSING
// exit code (`--expect pass`): the exact silent exit-0 evidence this
// whole mechanism distrusts, whichever direction `--expect` points. ----

describe("probe(): --expect pass, which verdicts rest on the mutant run's own exit code", () => {
  it("a quiet unknown runner with identical exit-0 output on both runs is refused, never certified killed", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        expect: "pass",
        // A constant, unrecognized line on both the baseline and the
        // mutant run (the mutant here is irrelevant to this command's
        // output either way): under `--expect pass`, exit 0 on both
        // sides alone would otherwise be certified `killed` with no
        // evidence anything real ran.
        testCommand: "node -e \"console.log('constant-output')\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
  });
  // See "criterion 2 fixture pair" below for the negative control (a
  // real, executed vitest summary under --expect pass is unaffected):
  // it needs the real-vitest fixture defined further down this file.

  it("a survived verdict under --expect pass whose mutant run exited NON-ZERO stands, even with byte-identical output on both sides", async () => {
    // Round-2 review finding: `restsOnPassingExit` used to be
    // `status === "survived" || (status === "killed" && expect ===
    // "pass")`, which enters the fallback for EVERY `--expect pass`
    // `survived` verdict regardless of the mutant run's own exit code --
    // including this one, whose `survived`-ness rests on the mutant run
    // exiting NON-ZERO, the opposite of the silent exit-0 evidence this
    // mechanism exists to distrust. `restsOnPassingExit` now reads the
    // mutant run's own exit code directly, so this case never enters the
    // fallback at all.
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        expect: "pass",
        // Prints the SAME constant line whichever content fixture.js
        // has, but exits 0 only when it still reads the baseline's
        // `flag: true` -- the default mutant flips it to `flag: false`,
        // so the baseline passes (exit 0) and the mutant run fails
        // (exit 1) while producing byte-identical output.
        testCommand:
          "node -e \"const { flag } = require('./fixture.js'); console.log('constant-output'); process.exit(flag ? 0 : 1);\"",
      }),
    );
    expect(result.status).toBe("survived");
    expect(result.reason).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

// --- Criterion 2's discriminating fixture pair, through a REAL vitest
// process (not a synthetic stand-in): a `-t` filter matching no test
// name yields `no_tests_executed`, never `survived`; the SAME probe with
// a matching filter still yields `killed`. -----------------------------

const FIXTURE_TEST_FILE = "sample.test.js";
const FIXTURE_TEST_CONTENT = [
  'import { describe, it, expect } from "vitest";',
  'describe("sample", () => {',
  '  it("adds", () => {',
  "    expect(1 + 1).toBe(2);",
  "  });",
  '  it("multiplies", () => {',
  "    expect(2 * 3).toBe(6);",
  "  });",
  "});",
  "",
].join("\n");

/** A throwaway vitest project, one real test file with two passing
 * tests ("adds", "multiplies"). No `node_modules` of its own: vitest is
 * resolved by absolute path back into this package's own installed
 * copy (`VITEST_ENTRY`), the same pattern `test/cli.test.ts`'s own live
 * tool tests use. Freshly copied per test rather than reused from
 * `test/fixtures/`, so this file's own mutant (a real `probe()`
 * backup/mutate/restore against a REAL file) never touches a committed
 * fixture. */
function makeVitestFixture(): string {
  const dir = makeTmpDir();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "zero-tests-fixture",
      private: true,
      type: "module",
    }),
  );
  fs.writeFileSync(path.join(dir, FIXTURE_TEST_FILE), FIXTURE_TEST_CONTENT);
  return dir;
}

function fixtureOptions(cwd: string, testCommand: string): ProbeOptions {
  return {
    file: FIXTURE_TEST_FILE,
    line: 4,
    form: "replace",
    // Breaks the "adds" assertion: a mutant a filter that actually
    // selects "adds" catches, one a filter matching nothing cannot.
    replaceText: "    expect(1 + 1).toBe(999);",
    testCommand,
    isolation: "inplace",
    expect: "fail",
    cwd,
    logDir: makeTmpDir(),
  };
}

describe("probe(): criterion 2 fixture pair, real vitest (task 273b3851)", () => {
  it("a -t filter matching no test name yields no_tests_executed, never survived", async () => {
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe(
      fixtureOptions(
        cwd,
        `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE} -t "no such name"`,
      ),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.status).not.toBe("survived");
    expect(result.mutation_probe?.result).toBe("not_run");
  }, 20000);

  it("the SAME probe with a matching filter still yields killed", async () => {
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe(
      fixtureOptions(
        cwd,
        `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE} -t "adds"`,
      ),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  }, 20000);

  it("negative control: no filter at all (the whole suite runs) also yields killed, never flagged", async () => {
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe(
      fixtureOptions(cwd, `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE}`),
    );
    expect(result.status).toBe("killed");
  }, 20000);

  it("negative control: --expect pass with a real, executed vitest summary is unaffected by the widened exit-0 check", async () => {
    // A harmless mutant (renames the describe block; the assertions
    // themselves are untouched, so the suite still genuinely passes) run
    // under --expect pass: a real "Tests 2 passed (2)" summary on both
    // the baseline and the mutant run means neither the mutant-side
    // zero-tests detector nor the generic fallback has anything to catch
    // here, whatever the exit code says.
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe({
      file: FIXTURE_TEST_FILE,
      line: 2,
      form: "replace",
      replaceText: 'describe("sample renamed", () => {',
      testCommand: `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE}`,
      isolation: "inplace",
      expect: "pass",
      cwd,
      logDir: makeTmpDir(),
    });
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  }, 20000);
});
