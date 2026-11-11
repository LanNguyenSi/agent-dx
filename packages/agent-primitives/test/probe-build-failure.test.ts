import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probe, probePlan, type ProbeOptions } from "../src/probe/index.js";
import { parsePlanFile } from "../src/probe/plan.js";
import {
  detectBuildFailure,
  readBuildFailure,
  recognizesBuildToolchain,
  skipCauseLabel,
  skipWarning,
  type MutantRunOutput,
} from "../src/probe/build-failure.js";
import { spawnCli } from "./helpers/spawn-cli.js";
import {
  mutationProbeReportItem,
  renderProbeSummary,
  type SummaryInput,
} from "../src/probe/summary.js";

/**
 * A mutant whose test command failed because the BUILD broke measured
 * nothing about the suite: it is reported `build_failed`, never `killed`.
 * The detector tests read real tool output captured once from go 1.27,
 * tsc 5.9, npm and vitest 4 (test/fixtures/README.md lists the commands);
 * the probe tests replay those exact bytes as a test command's output
 * through the real mutant step.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURED = path.join(__dirname, "fixtures", "captured");

function captured(name: string): string {
  return fs.readFileSync(path.join(CAPTURED, `${name}.txt`), "utf8");
}
function capturedPath(name: string): string {
  return path.join(CAPTURED, `${name}.txt`);
}

const tmpDirs: string[] = [];
const savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-build-failure-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
});

/** A repo whose test command (`node run.js`) prints a captured fixture
 * and exits 1 as soon as `fixture.js` says `broken: true`, and prints
 * `ready` (exit 0) otherwise. The mutant flips the flag. */
function initRepo(): string {
  process.env.AGENT_PRIMITIVES_LOCK_DIR = makeTmpDir();
  const repo = makeTmpDir();
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(
    path.join(repo, "fixture.js"),
    "module.exports = { broken: false };\n",
  );
  fs.writeFileSync(
    path.join(repo, "run.js"),
    [
      "const fs = require('node:fs');",
      "const fixture = require('./fixture.js');",
      "const { broken } = fixture;",
      "if (broken) {",
      "  process.stdout.write(fs.readFileSync(process.env.BF_FIXTURE, 'utf8'));",
      "  if (process.env.BF_RMLOGS) {",
      "    for (const f of fs.readdirSync(process.env.BF_RMLOGS)) {",
      "      if (/^exec-.*\\.log$/.test(f)) fs.unlinkSync(process.env.BF_RMLOGS + '/' + f);",
      "    }",
      "  }",
      "  process.exit(process.env.BF_EXIT0 ? 0 : 1);",
      "}",
      // Differs from the baseline's line whenever the mutant adds a key,
      // so a surviving mutant is not read as byte-identical output.
      "console.log('ready:' + Object.keys(fixture).join(','));",
      "",
    ].join("\n"),
  );
  git(["add", "-A"]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return repo;
}

function commandFor(fixture: string): string {
  return `BF_FIXTURE=${capturedPath(fixture)} node run.js`;
}

function options(
  repo: string,
  fixture: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 1,
    form: "replace",
    replaceText: "module.exports = { broken: true };",
    testCommand: commandFor(fixture),
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("detectBuildFailure(): captured real outputs", () => {
  it("go test: `FAIL <pkg> [build failed]` is a build failure", () => {
    expect(detectBuildFailure(captured("go-test-build-failed"), "")).toEqual({
      detected: true,
      via: "go",
    });
  });

  it("go test: `FAIL <pkg> [setup failed]` is a build failure", () => {
    expect(detectBuildFailure(captured("go-test-setup-failed"), "")).toEqual({
      detected: true,
      via: "go",
    });
  });

  it("go test: a package that failed to build next to a package that passed is still a build failure", () => {
    expect(
      detectBuildFailure(captured("go-test-build-failed-beside-ok"), ""),
    ).toEqual({ detected: true, via: "go" });
  });

  it("go test: a build failure next to a real failing test is NOT one (a test observed the mutant)", () => {
    expect(
      detectBuildFailure(
        captured("go-test-build-failed-beside-failed-test"),
        "",
      ),
    ).toEqual({ detected: false });
  });

  it("go test: an assertion failure is NOT a build failure (negative control)", () => {
    expect(detectBuildFailure(captured("go-test-assert-failed"), "")).toEqual({
      detected: false,
    });
  });

  it("go test: the marker is found in stderr too", () => {
    expect(detectBuildFailure("", captured("go-test-build-failed"))).toEqual({
      detected: true,
      via: "go",
    });
  });

  it("tsc: a pretest tsc error with no test-runner summary is a build failure", () => {
    expect(
      detectBuildFailure(captured("tsc-pretest-build-failed"), ""),
    ).toEqual({ detected: true, via: "tsc" });
  });

  it("tsc: a bare tsc diagnostic listing is a build failure", () => {
    expect(detectBuildFailure(captured("tsc-errors"), "")).toEqual({
      detected: true,
      via: "tsc",
    });
  });

  it("tsc: type errors printed beside a vitest summary are NOT a build failure (tests ran)", () => {
    expect(detectBuildFailure(captured("tsc-vitest-concat"), "")).toEqual({
      detected: false,
    });
  });

  it("tsc: a clean tsc run is not flagged (negative control)", () => {
    expect(detectBuildFailure(captured("tsc-clean"), "")).toEqual({
      detected: false,
    });
  });

  it("tsc: a type error next to jest's totals line is NOT a build failure", () => {
    const jest =
      "src/a.ts:2:9 - error TS2322: nope\nTests:       1 failed, 3 passed, 4 total\n";
    expect(detectBuildFailure(jest, "")).toEqual({ detected: false });
  });

  it("vitest: a file that fails to transform and no test run is a build failure", () => {
    expect(detectBuildFailure(captured("vitest-transform-failed"), "")).toEqual(
      { detected: true, via: "vitest" },
    );
  });

  it("vitest: a file that fails to load (missing module) and no test run is a build failure", () => {
    expect(detectBuildFailure(captured("vitest-collection-error"), "")).toEqual(
      { detected: true, via: "vitest" },
    );
  });

  it("vitest: a transform failure beside a test that ran and failed is NOT a build failure", () => {
    expect(
      detectBuildFailure(
        captured("vitest-transform-failed-beside-failed-test"),
        "",
      ),
    ).toEqual({ detected: false });
  });

  it("vitest: an assertion failure and `No test files found` are NOT build failures", () => {
    expect(detectBuildFailure(captured("vitest-fail"), "")).toEqual({
      detected: false,
    });
    expect(detectBuildFailure(captured("vitest-no-tests"), "")).toEqual({
      detected: false,
    });
  });

  it("vitest: the no-tests summary needs a failed test file AND a load error together", () => {
    const noTestsLoadErrorOnly =
      "SyntaxError: Unexpected token\n Test Files  1 passed (1)\n      Tests  no tests\n";
    const failedFileNoLoadError =
      " FAIL  a.test.ts [ a.test.ts ]\nError: boom in beforeAll\n Test Files  1 failed (1)\n      Tests  no tests\n";
    expect(detectBuildFailure(noTestsLoadErrorOnly, "")).toEqual({
      detected: false,
    });
    expect(detectBuildFailure(failedFileNoLoadError, "")).toEqual({
      detected: false,
    });
  });

  it("an unrecognized toolchain's compile error is not detected", () => {
    const rust =
      "error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:2:5\nerror: could not compile `m`\n";
    expect(detectBuildFailure(rust, "")).toEqual({ detected: false });
    expect(detectBuildFailure("", "")).toEqual({ detected: false });
  });
});

describe("detectBuildFailure(): tsc shapes that are not a build failure", () => {
  const ASSERTION_SHAPES = [
    "vitest-tap-assert-error-ts",
    "vitest-junit-assert-error-ts",
    "node-dot-assert-error-ts",
    "node-junit-assert-error-ts",
  ];
  for (const name of ASSERTION_SHAPES) {
    it(`${name}: a real assertion failure whose message contains \`error TS\` is NOT a build failure`, () => {
      expect(detectBuildFailure(captured(name), ""), name).toEqual({
        detected: false,
      });
    });
  }

  it("a type-level test run as `tsc --noEmit` reads as a build failure: such a command needs the opt-out", () => {
    expect(detectBuildFailure(captured("tsc-type-test-killed"), "")).toEqual({
      detected: true,
      via: "tsc",
    });
  });

  it("tsc's pretty diagnostic format is recognized too", () => {
    expect(
      detectBuildFailure(
        "src/a.ts:2:9 - error TS2322: Type 'number' is not assignable.\n",
        "",
      ),
    ).toEqual({ detected: true, via: "tsc" });
  });

  it("the diagnostic must start the line with a colon-free path: a prefixed or indented one is not tsc's", () => {
    for (const text of [
      "message: src/a.ts(2,9): error TS2322: boom\n",
      "  src/a.ts(2,9): error TS2322: boom\n",
      "message: src/a.ts:2:9 - error TS2322: boom\n",
      "an error TS2322: with no position\n",
    ]) {
      expect(detectBuildFailure(text, ""), text).toEqual({ detected: false });
    }
  });

  it("a diagnostic beside clear evidence that a test ran is NOT a build failure, each kind on its own", () => {
    const diagnostic = "src/a.ts(2,9): error TS2322: boom\n";
    for (const sign of [
      "not ok 1 - add\n",
      "1..1\nok 1 - add\n",
      "TAP version 13\nok 1 - add\n",
      "# pass 1\nok 1 - add\n",
      "# fail 1\nok 1 - add\n",
      "FAIL  a.test.ts > add\n",
      "FAILED a.test.ts\n",
      "--- FAIL: TestAdd (0.00s)\n",
      "  AssertionError: nope\n",
      "  AssertionError [ERR_ASSERTION]: nope\n",
      '<testcase name="add">\n',
      '<failure message="x">\n',
      "\u2716 add (1ms)\n",
      "\u25cf add\n",
      "1) Ns\\Class::testMethod\n",
    ]) {
      expect(detectBuildFailure(diagnostic + sign, ""), sign).toEqual({
        detected: false,
      });
    }
  });

  it("none of these is evidence that a test ran: the diagnostic still reads as a build failure", () => {
    const diagnostic = "src/a.ts(2,9): error TS2322: boom\n";
    for (const noise of [
      // eslint's closing line starts with the cross a reporter prints
      "\u2716 1 problem (0 errors, 1 warning)\n",
      "\u2716 12 problems (3 errors, 9 warnings)\n",
      // pnpm's footer: a bare Error, not a named one
      "Error: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\n",
      '  \u00d7 "pnpm recursive run" failed in /project/packages/a\n',
      "[ELIFECYCLE] Test failed. See above for more details.\n",
      // a TAP-looking line outside a TAP stream
      "ok 1 - env check\n",
      "ok 1\n",
      // another tsc diagnostic whose path happens to end in Error.ts
      "AppError.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n",
      "src/AssertionError.ts:3:5 - error TS2322: x\n",
    ]) {
      expect(detectBuildFailure(noise + diagnostic, ""), noise).toEqual({
        detected: true,
        via: "tsc",
      });
      expect(detectBuildFailure(diagnostic + noise, ""), noise).toEqual({
        detected: true,
        via: "tsc",
      });
    }
  });

  it("a TAP `ok` line needs a full TAP line: `ok` inside a longer line is not one even in a stream", () => {
    const diagnostic = "src/a.ts(2,9): error TS2322: boom\n";
    expect(detectBuildFailure(`1..2\n${diagnostic}ok123 - nope\n`, "")).toEqual(
      { detected: true, via: "tsc" },
    );
    expect(
      detectBuildFailure(`1..2\n${diagnostic}  ok 1 - indented\n`, ""),
    ).toEqual({ detected: true, via: "tsc" });
    expect(detectBuildFailure(`1..2\n${diagnostic}ok 1x - nope\n`, "")).toEqual(
      {
        detected: true,
        via: "tsc",
      },
    );
    expect(detectBuildFailure(`1..2\n${diagnostic}ok 7`, "")).toEqual({
      detected: false,
    });
  });

  it("only weak evidence (a named error line) keeps the kill but is reported ambiguous, with the matched line", () => {
    const diagnostic = "src/a.ts(2,9): error TS2322: boom\n";
    for (const line of [
      "TypeError: Cannot read properties of undefined (reading 'load')",
      "  RangeError: Maximum call stack size exceeded",
      "TSError: \u2a2f Unable to compile TypeScript:",
    ]) {
      expect(detectBuildFailure(diagnostic + line + "\n", ""), line).toEqual({
        detected: false,
        ambiguous: { via: "tsc", evidence: line.trim() },
      });
    }
  });

  it("strong evidence beats weak evidence wherever it sits; the first weak line is the one reported", () => {
    const diagnostic = "src/a.ts(2,9): error TS2322: boom\n";
    expect(
      detectBuildFailure(`${diagnostic}TypeError: x\nnot ok 1 - add\n`, ""),
    ).toEqual({ detected: false });
    expect(
      detectBuildFailure(`${diagnostic}TypeError: one\nRangeError: two\n`, ""),
    ).toEqual({
      detected: false,
      ambiguous: { via: "tsc", evidence: "TypeError: one" },
    });
  });

  it("a long weak line is cut to 160 characters", () => {
    const evidence = (
      detectBuildFailure(
        `src/a.ts(2,9): error TS2322: boom\nTypeError: ${"x".repeat(400)}\n`,
        "",
      ) as { ambiguous: { evidence: string } }
    ).ambiguous.evidence;
    expect(evidence).toHaveLength(160);
  });
});

describe("detectBuildFailure(): captured tsc output beside other tools", () => {
  const READ_AS_BUILD_FAILURE = [
    "tsc-eslint-warning-then-tsc",
    "tsc-apperror-root-diagnostic",
    "tsc-pretest-ok-line-then-tsc",
    "pnpm-filter-tsc-error",
  ];
  for (const name of READ_AS_BUILD_FAILURE) {
    it(`${name}: a build failure (eslint warnings, an AppError.ts path, a bare Error: footer and a stray ok line are not tests)`, () => {
      expect(detectBuildFailure(captured(name), ""), name).toEqual({
        detected: true,
        via: "tsc",
      });
    });
  }

  it("pnpm -r test prefixes every line with `packages/a test: `, a shape that is not recognized: the row stays killed and the summary says the toolchain was not covered", () => {
    const text = captured("pnpm-recursive-tsc-error");
    expect(detectBuildFailure(text, "")).toEqual({ detected: false });
    expect(recognizesBuildToolchain(text, "")).toBe(false);
  });

  it("tsc-then-uncaught-typeerror: a diagnostic beside a TypeError from a later script is ambiguous", () => {
    expect(
      detectBuildFailure(captured("tsc-then-uncaught-typeerror"), ""),
    ).toEqual({
      detected: false,
      ambiguous: {
        via: "tsc",
        evidence:
          "TypeError: Cannot read properties of undefined (reading 'load')",
      },
    });
  });
});

describe("detectBuildFailure(): vitest SyntaxError and ANSI", () => {
  const NO_TESTS = " Test Files  1 failed (1)\n      Tests  no tests\n";

  it("a runtime SyntaxError raised while a loaded file ran (JSON.parse at import) is NOT a build failure", () => {
    expect(
      detectBuildFailure(captured("vitest-runtime-syntaxerror-at-import"), ""),
    ).toEqual({ detected: false });
  });

  it("a SyntaxError with no frame in user code is one (parse failure)", () => {
    expect(
      detectBuildFailure(`SyntaxError: Unexpected token\n${NO_TESTS}`, ""),
    ).toEqual({ detected: true, via: "vitest" });
  });

  it("a SyntaxError whose only frames are inside node_modules is still one", () => {
    const text = `SyntaxError: Unexpected token\n \u276f ../../node_modules/vite/dist/node/chunks/node.js:7618:19\n${NO_TESTS}`;
    expect(detectBuildFailure(text, "")).toEqual({
      detected: true,
      via: "vitest",
    });
  });

  it("a SyntaxError with a node-style `at` frame in user code is not", () => {
    const text = `SyntaxError: Unexpected token\n    at load (/work/src/a.ts:3:9)\n${NO_TESTS}`;
    expect(detectBuildFailure(text, "")).toEqual({ detected: false });
  });

  it("a [PARSE_ERROR] and a Transform failed line are build failures on their own", () => {
    for (const marker of [
      "[PARSE_ERROR] Unexpected token",
      "Error: Transform failed with 2 errors:",
    ]) {
      expect(detectBuildFailure(`${marker}\n${NO_TESTS}`, ""), marker).toEqual({
        detected: true,
        via: "vitest",
      });
    }
  });

  it("escape codes around the go marker and around the vitest lines do not hide them", () => {
    const go = "\u001b[31mFAIL\u001b[0m\texample.com/m [build failed]\n";
    expect(detectBuildFailure(go, "")).toEqual({ detected: true, via: "go" });
    const vitest =
      "Error: Transform failed with 1 error:\n" +
      "\u001b[2m Test Files \u001b[22m \u001b[31m1 failed\u001b[39m \u001b[90m(1)\u001b[39m\n" +
      "\u001b[2m      Tests \u001b[22m no tests\n";
    expect(detectBuildFailure(vitest, "")).toEqual({
      detected: true,
      via: "vitest",
    });
  });
});

describe("readBuildFailure(): truncated output", () => {
  function run(overrides: Partial<MutantRunOutput>): MutantRunOutput {
    return {
      stdoutTail: "",
      stderrTail: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      logPath: path.join(makeTmpDir(), "missing.log"),
      ...overrides,
    };
  }
  function logWith(text: string): string {
    const file = path.join(makeTmpDir(), "run.log");
    fs.writeFileSync(file, text);
    return file;
  }
  const BIG = 1024 * 1024;

  it("untruncated output is read from the tails and the log is never touched", () => {
    expect(
      readBuildFailure(
        run({ stdoutTail: captured("go-test-build-failed") }),
        BIG,
      ),
    ).toEqual({ detected: true, via: "go" });
  });

  for (const which of ["stdoutTruncated", "stderrTruncated"] as const) {
    it(`${which}: the full log is read, not the tails (a marker only the log has)`, () => {
      expect(
        readBuildFailure(
          run({
            [which]: true,
            stdoutTail: "ok  \texample.com/m/p70\t0.001s\n",
            logPath: logWith(captured("go-test-many-early-buildfail")),
          }),
          BIG,
        ),
      ).toEqual({ detected: true, via: "go" });
    });

    it(`${which}: the full log is read, not the tails (a failing test only the log has)`, () => {
      expect(
        readBuildFailure(
          run({
            [which]: true,
            stdoutTail: captured("go-test-many-testfail-and-buildfail")
              .split("\n")
              .slice(-4)
              .join("\n"),
            logPath: logWith(captured("go-test-many-testfail-and-buildfail")),
          }),
          BIG,
        ),
      ).toEqual({ detected: false });
    });
  }

  it("a truncated run whose log cannot be read is skipped, whatever the tails say", () => {
    expect(
      readBuildFailure(
        run({
          stdoutTruncated: true,
          stdoutTail: captured("go-test-build-failed"),
        }),
        BIG,
      ),
    ).toEqual({ detected: false, skipped: "log_unreadable" });
  });

  it("a log that may be incomplete is skipped, readable or not, each for its own cause", () => {
    for (const [flag, cause] of [
      ["logWriteFailed", "log_write_failed"],
      ["outputMayBeIncomplete", "output_incomplete"],
    ] as const) {
      expect(
        readBuildFailure(
          run({
            stdoutTruncated: true,
            [flag]: true,
            logPath: logWith(captured("go-test-build-failed")),
          }),
          BIG,
        ),
        flag,
      ).toEqual({ detected: false, skipped: cause });
    }
  });

  it("both flags at once report the write failure first", () => {
    expect(
      readBuildFailure(
        run({
          stdoutTruncated: true,
          logWriteFailed: true,
          outputMayBeIncomplete: true,
        }),
        BIG,
      ),
    ).toEqual({ detected: false, skipped: "log_write_failed" });
  });

  it("each skip cause has its own label and a warning that names it, the bound and the log", () => {
    const labels = {
      log_too_large: "log too large",
      log_write_failed: "log write failed",
      output_incomplete: "output may be incomplete",
      log_unreadable: "log unreadable",
    } as const;
    const wording = {
      log_too_large: "its full log is larger than 2 MiB",
      log_write_failed: "writing its full log failed",
      output_incomplete: "its output may be incomplete",
      log_unreadable: "its full log could not be read",
    } as const;
    for (const cause of Object.keys(labels) as (keyof typeof labels)[]) {
      expect(skipCauseLabel(cause)).toBe(labels[cause]);
      const warning = skipWarning(cause, 2 * 1024 * 1024, "/logs/run.log");
      expect(warning, cause).toContain(wording[cause]);
      expect(warning, cause).toContain("see /logs/run.log");
      expect(warning, cause).toMatch(/^build-failure detection was skipped: /);
    }
  });

  it("a log larger than the bound is skipped; one exactly at it is read", () => {
    const text = captured("go-test-build-failed");
    const logPath = logWith(text);
    const size = Buffer.byteLength(text);
    expect(
      readBuildFailure(run({ stdoutTruncated: true, logPath }), size - 1),
    ).toEqual({ detected: false, skipped: "log_too_large" });
    expect(
      readBuildFailure(run({ stdoutTruncated: true, logPath }), size),
    ).toEqual({ detected: true, via: "go" });
  });
});

describe("recognizesBuildToolchain()", () => {
  it("recognizes go test, tsc and vitest output", () => {
    for (const name of [
      "go-test-build-failed",
      "go-test-assert-failed",
      "tsc-errors",
      "vitest-fail",
      "vitest-pass",
      "vitest-transform-failed",
    ]) {
      expect(recognizesBuildToolchain(captured(name), ""), name).toBe(true);
    }
  });

  it("does not recognize a hand-rolled script, pytest or empty output", () => {
    expect(recognizesBuildToolchain("FAIL fixture is false\n", "")).toBe(false);
    expect(recognizesBuildToolchain(captured("pytest-fail"), "")).toBe(false);
    expect(recognizesBuildToolchain("", "")).toBe(false);
  });
});

describe("probe(): a build failure is never a kill", () => {
  const buildFailedFixtures = [
    "go-test-build-failed",
    "go-test-setup-failed",
    "tsc-pretest-build-failed",
    "vitest-transform-failed",
    "vitest-collection-error",
  ];

  for (const fixture of buildFailedFixtures) {
    it(`${fixture}: build_failed, not killed, no expectation (expect fail)`, async () => {
      const repo = initRepo();
      const result = await probe(options(repo, fixture));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("build_failed");
      expect(result.mutation_probe?.result).toBe("build_failed");
      expect(result.mutation_probe?.reason).toBe("build_failed");
      expect(result.mutation_probe?.restored_verified).toBe(true);
      expect(result.mutation_probe?.expectation).toBeUndefined();
      expect(
        result.warnings.some((w) => /shows the build failed/.test(w)),
      ).toBe(true);
      expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
        "module.exports = { broken: false };\n",
      );
    });
  }

  it("a build failure whose output also shows a zero-tests shape is still build_failed", async () => {
    const repo = initRepo();
    const combined = path.join(makeTmpDir(), "combined.txt");
    fs.writeFileSync(
      combined,
      // node's runner statement that no test ran, after the go output
      captured("go-test-build-failed") + "ℹ tests 0\n",
    );
    const result = await probe({
      ...options(repo, "go-test-build-failed"),
      testCommand: `BF_FIXTURE=${combined} node run.js`,
    });
    expect(result.reason).toBe("build_failed");
    expect(result.mutation_probe?.result).toBe("build_failed");
  });

  it("--expect pass: a build_failed mutant is not met either (no expectation, inconclusive)", async () => {
    const repo = initRepo();
    const result = await probe(
      options(repo, "go-test-build-failed", { expect: "pass" }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.mutation_probe?.result).toBe("build_failed");
    expect(result.mutation_probe?.expectation).toBeUndefined();
  });

  it("a run that exits 0 is never reinterpreted, whatever its output shows", async () => {
    const repo = initRepo();
    const result = await probe(
      options(repo, "go-test-build-failed", {
        testCommand: `BF_EXIT0=1 ${commandFor("go-test-build-failed")}`,
        expect: "pass",
      }),
    );
    expect(result.status).toBe("survived");
    expect(result.mutation_probe?.result).toBe("survived");
    expect(result.mutation_probe?.expectation).toBe("met");
  });

  it("a real assertion failure is still killed (go)", async () => {
    const repo = initRepo();
    const result = await probe(options(repo, "go-test-assert-failed"));
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
    expect(result.mutation_probe?.expectation).toBe("met");
    expect(result.reason).toBeUndefined();
  });

  it("a real assertion failure is still killed (vitest)", async () => {
    const repo = initRepo();
    const result = await probe(options(repo, "vitest-fail"));
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
  });

  it("a build failure beside a failing test is still killed (a test observed the mutant)", async () => {
    const repo = initRepo();
    const result = await probe(
      options(repo, "go-test-build-failed-beside-failed-test"),
    );
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
  });

  it("a build failure of an unrecognized toolchain keeps the old behaviour: killed", async () => {
    const repo = initRepo();
    const result = await probe(
      options(repo, "go-test-build-failed", {
        // Same exit code, none of the recognized shapes in the output.
        testCommand:
          "node -e \"require('./fixture.js').broken ? (console.error('error[E0425]: cannot find value'), process.exit(1)) : console.log('ready')\"",
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
  });
});

describe("probe(): output longer than the captured tail", () => {
  it("a failing test in one package and a build failure in another (73 lines, the test failure scrolled out of the tail) is killed, not build_failed", async () => {
    const repo = initRepo();
    const result = await probe(
      options(repo, "go-test-many-testfail-and-buildfail"),
    );
    expect(result.test?.stdoutTail).not.toContain("--- FAIL");
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
  });

  it("a build failure in an early package (the marker scrolled out of the tail) is build_failed, not killed", async () => {
    const repo = initRepo();
    const result = await probe(options(repo, "go-test-many-early-buildfail"));
    expect(result.test?.stdoutTail).not.toContain("[build failed]");
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("build_failed");
    expect(result.mutation_probe?.result).toBe("build_failed");
  });

  it("a long tsc listing (70 diagnostics) is build_failed", async () => {
    const repo = initRepo();
    const result = await probe(options(repo, "tsc-errors-many"));
    expect(result.reason).toBe("build_failed");
  });

  it("a truncated run whose log is gone keeps killed and says detection was skipped", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const result = await probe(
      options(repo, "go-test-many-early-buildfail", {
        logDir,
        testCommand: `BF_RMLOGS=${logDir} ${commandFor("go-test-many-early-buildfail")}`,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
    expect(
      result.warnings.filter((w) =>
        /build-failure detection was skipped: .* truncated/.test(w),
      ),
    ).toHaveLength(1);
  });
});

describe("probe(): a killed reading build detection could not settle is marked", () => {
  it("a tsc diagnostic beside an uncaught TypeError stays killed, marked ambiguous, with a warning naming the mutant and the line", async () => {
    const repo = initRepo();
    const result = await probe(options(repo, "tsc-then-uncaught-typeerror"));
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
    expect(result.mutation_probe?.expectation).toBe("met");
    expect(result.mutation_probe?.build_detection).toBe("ambiguous");
    expect(result.mutation_probe?.build_detection_detail).toBe(
      "TypeError: Cannot read properties of undefined (reading 'load')",
    );
    const warnings = result.warnings.filter((w) =>
      w.startsWith("build-failure detection is ambiguous for the mutant "),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fixture.js:1");
    expect(warnings[0]).toContain("TypeError: Cannot read properties");
    expect(warnings[0]).toContain("--no-build-detect");
  });

  it("with detection off the same run carries no marker and no warning", async () => {
    const repo = initRepo();
    const result = await probe(
      options(repo, "tsc-then-uncaught-typeerror", { buildDetect: false }),
    );
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.build_detection).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("the unambiguous captures carry no marker: a build failure and a real assertion failure", async () => {
    const repo = initRepo();
    const built = await probe(options(repo, "tsc-eslint-warning-then-tsc"));
    expect(built.mutation_probe?.result).toBe("build_failed");
    expect(built.mutation_probe?.build_detection).toBeUndefined();
    const asserted = await probe(options(repo, "vitest-tap-assert-error-ts"));
    expect(asserted.mutation_probe?.result).toBe("killed");
    expect(asserted.mutation_probe?.build_detection).toBeUndefined();
  });

  it("a skipped full-log read marks the row and names the cause in the warning", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const result = await probe(
      options(repo, "go-test-many-early-buildfail", {
        logDir,
        testCommand: `BF_RMLOGS=${logDir} ${commandFor("go-test-many-early-buildfail")}`,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.build_detection).toBe("skipped");
    expect(result.mutation_probe?.build_detection_detail).toBe(
      "log unreadable",
    );
    expect(
      result.warnings.filter((w) =>
        w.includes("its full log could not be read"),
      ),
    ).toHaveLength(1);
  });

  it("a skipped read whose run is then refused as no_tests_executed carries no marker and no skip warning", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const fixture = path.join(makeTmpDir(), "filler.txt");
    fs.writeFileSync(
      fixture,
      Array.from({ length: 80 }, (_, i) => `filler line ${i}`).join("\n") +
        "\nℹ tests 0\n",
    );
    const result = await probe({
      ...options(repo, "go-test-build-failed"),
      logDir,
      testCommand: `BF_FIXTURE=${fixture} BF_RMLOGS=${logDir} node run.js`,
    });
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.build_detection).toBeUndefined();
    expect(
      result.warnings.filter((w) => w.startsWith("build-failure detection")),
    ).toEqual([]);
  });

  it("a verdict that is no longer killed carries no marker", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    // truncated and unreadable, but the run exits 0: survived, not killed
    const result = await probe(
      options(repo, "go-test-many-early-buildfail", {
        logDir,
        expect: "pass",
        testCommand: `BF_EXIT0=1 BF_RMLOGS=${logDir} ${commandFor("go-test-many-early-buildfail")}`,
      }),
    );
    expect(result.status).toBe("survived");
    expect(result.mutation_probe?.build_detection).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

describe("build detection opt-out", () => {
  it("probe(): buildDetect false keeps a build failure killed; true and absent read it as build_failed", async () => {
    const repo = initRepo();
    const off = await probe(
      options(repo, "go-test-build-failed", { buildDetect: false }),
    );
    expect(off.status).toBe("killed");
    expect(off.mutation_probe?.result).toBe("killed");
    expect(off.warnings).toEqual([]);
    for (const buildDetect of [true, undefined]) {
      const on = await probe(
        options(repo, "go-test-build-failed", { buildDetect }),
      );
      expect(on.mutation_probe?.result, String(buildDetect)).toBe(
        "build_failed",
      );
    }
  });

  it("a type-level test run as tsc: build_failed by default, a kill with the opt-out", async () => {
    const repo = initRepo();
    const on = await probe(options(repo, "tsc-type-test-killed"));
    expect(on.mutation_probe?.result).toBe("build_failed");
    const off = await probe(
      options(repo, "tsc-type-test-killed", { buildDetect: false }),
    );
    expect(off.mutation_probe?.result).toBe("killed");
    expect(off.mutation_probe?.expectation).toBe("met");
  });

  it("a skipped truncated read is not warned about when detection is off", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const result = await probe(
      options(repo, "go-test-many-early-buildfail", {
        logDir,
        buildDetect: false,
        testCommand: `BF_RMLOGS=${logDir} ${commandFor("go-test-many-early-buildfail")}`,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.warnings).toEqual([]);
  });

  type Setting = boolean | undefined;
  const SETTINGS: Setting[] = [undefined, true, false];
  for (const plan of SETTINGS) {
    it(`probePlan(): plan-level buildDetect=${String(plan)}, a mutant's own value wins, else the plan's, else on`, async () => {
      const repo = initRepo();
      const result = await probePlan({
        mutants: SETTINGS.map((own) => ({
          file: "fixture.js",
          line: 1,
          form: "replace" as const,
          replaceText: "module.exports = { broken: true };",
          ...(own !== undefined ? { buildDetect: own } : {}),
        })),
        testCommand: commandFor("go-test-build-failed"),
        isolation: "inplace",
        expect: "fail",
        ...(plan !== undefined ? { buildDetect: plan } : {}),
        cwd: repo,
        logDir: makeTmpDir(),
      });
      const seen = result.results.map((r) => r.mutation_probe?.result);
      const expected = SETTINGS.map((own) =>
        (own ?? plan ?? true) ? "build_failed" : "killed",
      );
      expect(seen).toEqual(expected);
    });
  }

  describe("plan file", () => {
    function plan(
      body: Record<string, unknown>,
      entry: Record<string, unknown> = {},
    ) {
      const file = path.join(makeTmpDir(), "plan.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          test: "true",
          mutants: [{ file: "a.js", line: 1, replace: "x", ...entry }],
          ...body,
        }),
      );
      return parsePlanFile(file);
    }

    it("reads build_detect at the plan level and on a mutant", () => {
      const parsed = plan({ build_detect: false }, { build_detect: true });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.plan.buildDetect).toBe(false);
        expect(parsed.plan.mutants[0]?.buildDetect).toBe(true);
      }
    });

    it("leaves both absent when not given", () => {
      const parsed = plan({});
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.plan.buildDetect).toBeUndefined();
        expect(parsed.plan.mutants[0]?.buildDetect).toBeUndefined();
      }
    });

    it("refuses a non-boolean build_detect, naming where", () => {
      const planLevel = plan({ build_detect: "no" });
      expect(planLevel.ok).toBe(false);
      if (!planLevel.ok)
        expect(planLevel.message).toContain("plan.build_detect");
      const mutantLevel = plan({}, { build_detect: 0 });
      expect(mutantLevel.ok).toBe(false);
      if (!mutantLevel.ok) {
        expect(mutantLevel.message).toContain("plan.mutants[0].build_detect");
      }
    });
  });

  describe("CLI", { timeout: 60000 }, () => {
    async function cli(repo: string, args: string[]) {
      return spawnCli([
        "-C",
        repo,
        "-l",
        makeTmpDir(),
        "-m",
        "100000",
        "probe",
        ...args,
      ]);
    }
    const SINGLE = (extra: string[]) => [
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-r",
      "module.exports = { broken: true };",
      "-i",
      "inplace",
      "-t",
      commandFor("go-test-build-failed"),
      ...extra,
    ];

    it("--no-build-detect keeps the build failure a kill (exit 0); without it the run is build_failed (exit 2)", async () => {
      const repo = initRepo();
      const on = await cli(repo, SINGLE([]));
      expect(on.code).toBe(2);
      expect(JSON.parse(on.stdout).mutation_probe.result).toBe("build_failed");
      const off = await cli(repo, SINGLE(["--no-build-detect"]));
      expect(off.code).toBe(0);
      expect(JSON.parse(off.stdout).mutation_probe.result).toBe("killed");
    });

    function planFile(
      body: Record<string, unknown>,
      mutants: Record<string, unknown>[],
    ): string {
      const file = path.join(makeTmpDir(), "plan.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          test: commandFor("go-test-build-failed"),
          isolation: "inplace",
          ...body,
          mutants: mutants.map((m) => ({
            file: "fixture.js",
            line: 1,
            replace: "module.exports = { broken: true };",
            ...m,
          })),
        }),
      );
      return file;
    }
    async function results(
      repo: string,
      file: string,
      extra: string[],
    ): Promise<(string | undefined)[]> {
      const run = await cli(repo, ["--plan", file, ...extra]);
      return JSON.parse(run.stdout).plan.results.map(
        (r: { mutation_probe?: { result?: string } }) =>
          r.mutation_probe?.result,
      );
    }

    it("a plan without any setting detects; plan build_detect false turns it off; a mutant's true turns it back on", async () => {
      const repo = initRepo();
      expect(await results(repo, planFile({}, [{}]), [])).toEqual([
        "build_failed",
      ]);
      expect(
        await results(repo, planFile({ build_detect: false }, [{}]), []),
      ).toEqual(["killed"]);
      expect(
        await results(
          repo,
          planFile({ build_detect: false }, [{ build_detect: true }, {}]),
          [],
        ),
      ).toEqual(["build_failed", "killed"]);
    });

    it("--no-build-detect wins over the plan's build_detect true, and a mutant's own value still wins over it", async () => {
      const repo = initRepo();
      expect(
        await results(
          repo,
          planFile({ build_detect: true }, [{}, { build_detect: true }]),
          ["--no-build-detect"],
        ),
      ).toEqual(["killed", "build_failed"]);
      expect(
        await results(repo, planFile({}, [{ build_detect: false }, {}]), []),
      ).toEqual(["killed", "build_failed"]);
    });
  });
});

describe("probePlan(): build_failed is counted on its own", () => {
  it("totals count it separately and the plan cannot conclude; an expect:pass survivor is listed with its reason", async () => {
    const repo = initRepo();
    const result = await probePlan({
      mutants: [
        {
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "module.exports = { broken: true };",
        },
        {
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "module.exports = { broken: false, extra: 1 };",
          expect: "pass",
          expectReason: "extra is read by no caller",
        },
        {
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "module.exports = { broken: false, other: 2 };",
          expect: "pass",
        },
      ],
      testCommand: commandFor("go-test-build-failed"),
      isolation: "inplace",
      expect: "fail",
      cwd: repo,
      logDir: makeTmpDir(),
    });
    expect(result.summary).toEqual({
      total: 3,
      killed: 0,
      survived: 2,
      inconclusive: 0,
      not_run: 0,
      build_failed: 1,
      met: 2,
      violated: 0,
    });
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_inconclusive");
    expect(result.results[0]?.mutation_probe?.result).toBe("build_failed");
    expect(result.results[1]?.expect_reason).toBe("extra is read by no caller");
    expect(result.results[2]?.expect_reason).toBeUndefined();

    const text = renderProbeSummary(
      {
        status: result.status,
        reason: result.reason,
        plan: { ...result, summary: { ...result.summary } },
        cwd: repo,
      },
      Number.POSITIVE_INFINITY,
    );
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^#0 fixture\.js:1 \| build_failed\(build failed, mutant not exercised\) \| expectation=- \| restored=true \| failing=- \| log=/,
    );
    expect(lines).toContain(
      "expected survivors (expect: pass, survived, counted as met): 2",
    );
    expect(lines).toContain(
      "  #1 fixture.js:1 | reason: extra is read by no caller",
    );
    expect(lines).toContain("  #2 fixture.js:1 | reason: (no reason given)");
    expect(lines.at(-1)).toBe(
      "totals: status=inconclusive reason=mutant_inconclusive total=3 killed=0 survived=2 inconclusive=0 not_run=0 met=2 violated=0 build_failed=1",
    );
  });
});

describe("parsePlanFile(): optional reason", () => {
  function plan(entry: Record<string, unknown>) {
    const dir = makeTmpDir();
    const file = path.join(dir, "plan.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        test: "true",
        mutants: [{ file: "a.js", line: 1, replace: "x", ...entry }],
      }),
    );
    return parsePlanFile(file);
  }

  it("carries a mutant's reason", () => {
    const parsed = plan({ expect: "pass", reason: "dead branch" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.plan.mutants[0]?.expectReason).toBe("dead branch");
  });

  it("is optional", () => {
    const parsed = plan({ expect: "pass" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.mutants[0]?.expectReason).toBeUndefined();
  });

  it("refuses an empty or non-string reason", () => {
    for (const reason of ["", 3]) {
      const parsed = plan({ reason });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe("plan_invalid");
        expect(parsed.message).toContain("plan.mutants[0].reason");
      }
    }
  });
});

describe("renderProbeSummary(): build_failed and expected survivors", () => {
  const build = {
    index: 0,
    file: "a.go",
    expect: "fail",
    status: "inconclusive",
    reason: "build_failed",
    mutant: { file: "a.go", line: 4 },
    mutation_probe: {
      result: "build_failed",
      reason: "build_failed",
      restored_verified: true,
    },
    test: { stdoutTail: captured("go-test-build-failed"), stderrTail: "" },
  };

  it("single form: build_failed has its own total, not inconclusive", () => {
    const text = renderProbeSummary({
      status: "inconclusive",
      reason: "build_failed",
      mutant: { file: "a.go", line: 4 },
      mutation_probe: build.mutation_probe,
      test: build.test,
    });
    expect(text).toContain(
      "total=1 killed=0 survived=0 inconclusive=0 not_run=0 met=0 violated=0 build_failed=1",
    );
    expect(text).toContain("build_failed(build failed, mutant not exercised)");
  });

  it("an expect:pass build_failed row is not an expected survivor and keeps expectation=-", () => {
    const input: SummaryInput = {
      status: "inconclusive",
      plan: {
        results: [{ ...build, expect: "pass" }],
        summary: { total: 1, build_failed: 1 },
      },
    };
    const text = renderProbeSummary(input);
    expect(text).not.toContain("expected survivors");
    expect(text).toContain("expectation=-");
    expect(text).toContain("build_failed=1");
  });

  it("a killed row without test output is not asked about its toolchain, and a survivor's output never counts", () => {
    const text = renderProbeSummary({
      status: "killed",
      plan: {
        results: [
          {
            index: 0,
            file: "a.js",
            expect: "fail",
            status: "killed",
            mutation_probe: { result: "killed", expectation: "met" },
          },
          {
            index: 1,
            file: "b.js",
            expect: "pass",
            status: "survived",
            mutation_probe: { result: "survived", expectation: "met" },
            test: { stdoutTail: "unknown runner output\n", stderrTail: "" },
          },
        ],
      },
    });
    expect(text).not.toContain("build-failure detection:");
  });

  it("lists only survivors that declared expect pass: a survivor that violated expect fail is not an expected one", () => {
    const text = renderProbeSummary({
      status: "survived",
      plan: {
        results: [
          {
            index: 0,
            file: "a.js",
            expect: "fail",
            expect_reason: "should not be shown",
            status: "survived",
            mutation_probe: { result: "survived", expectation: "violated" },
          },
        ],
      },
    });
    expect(text).not.toContain("expected survivors");
    expect(text).not.toContain("should not be shown");
  });

  it("names how many killed rows build-failure detection did not cover, once", () => {
    const unknown = {
      index: 0,
      file: "a.py",
      expect: "fail",
      status: "killed",
      mutation_probe: { result: "killed", expectation: "met" },
      test: { stdoutTail: "boom\n", stderrTail: "" },
    };
    const text = renderProbeSummary({
      status: "killed",
      plan: { results: [unknown, { ...unknown, index: 1 }] },
    });
    const hits = text
      .split("\n")
      .filter((l) => l.startsWith("build-failure detection:"));
    expect(hits).toEqual([
      "build-failure detection: not available for 2 killed mutants (recognized: go test, tsc, vitest output); a compile error there still reads as killed, check the log",
    ]);
  });

  it("does not print that line when every killed row is a recognized toolchain", () => {
    const text = renderProbeSummary({
      status: "killed",
      plan: {
        results: [
          {
            index: 0,
            file: "a.go",
            expect: "fail",
            status: "killed",
            mutation_probe: { result: "killed", expectation: "met" },
            test: {
              stdoutTail: captured("go-test-assert-failed"),
              stderrTail: "",
            },
          },
        ],
      },
    });
    expect(text).not.toContain("build-failure detection:");
  });

  it("the totals line is kept when -m only fits the totals", () => {
    const survivor = {
      index: 3,
      file: "b.js",
      expect: "pass",
      expect_reason: "cosmetic",
      status: "survived",
      mutant: { file: "b.js", line: 9 },
      mutation_probe: { result: "survived", expectation: "met" },
    };
    const full = renderProbeSummary({
      status: "survived",
      plan: { results: [survivor] },
    });
    expect(full).toContain("  #3 b.js:9 | reason: cosmetic");
    const totalsOnly = renderProbeSummary(
      { status: "survived", plan: { results: [survivor] } },
      full.split("\n").at(-2)!.length + 1,
    );
    expect(totalsOnly).toContain("totals:");
  });
});

describe("renderProbeSummary(): the extra lines under -m", () => {
  const killedUnknown = {
    index: 0,
    file: "a.py",
    expect: "fail",
    status: "killed",
    mutation_probe: { result: "killed", expectation: "met" },
    test: { stdoutTail: "boom\n", stderrTail: "" },
  };
  const survivor = {
    index: 1,
    file: "b.js",
    expect: "pass",
    status: "survived",
    mutant: { file: "b.js", line: 9 },
    mutation_probe: { result: "survived", expectation: "met" },
  };
  const input: SummaryInput = {
    status: "killed",
    plan: {
      baselines: [
        { index: 0, command: "npm test", status: "passed", entries: [0] },
        { index: 1, command: "npm run b", status: "passed", entries: [1] },
      ],
      results: [killedUnknown, survivor],
    },
  };
  const HEADING =
    "expected survivors (expect: pass, survived, counted as met): 1";

  it("unbounded, the survivors and the detection line print above the baseline lines", () => {
    const lines = renderProbeSummary(input).trimEnd().split("\n");
    expect(lines.slice(2)).toEqual([
      HEADING,
      "  #1 b.js:9 | reason: (no reason given)",
      "build-failure detection: not available for 1 killed mutant (recognized: go test, tsc, vitest output); a compile error there still reads as killed, check the log",
      "baseline[0] | passed | entries=0 | log=- | test=npm test",
      "baseline[1] | passed | entries=1 | log=- | test=npm run b",
      lines.at(-1),
    ]);
  });

  it("a budget that only fits the baselines and totals drops the detection line and the survivor lines, never a baseline line or the heading", () => {
    const full = renderProbeSummary(input).trimEnd().split("\n");
    const tail = full.slice(-3);
    const budget = HEADING.length + 1 + tail.join("\n").length + 2;
    const text = renderProbeSummary(input, budget).trimEnd().split("\n");
    expect(text.slice(-4)).toEqual([HEADING, ...tail]);
    expect(text.join("\n")).not.toContain("  #1 b.js:9");
    expect(text.join("\n")).not.toContain("build-failure detection:");
  });

  it("whenever an extra line is printed, every baseline line and the heading are printed too, at any budget", () => {
    const full = renderProbeSummary(input);
    for (let budget = 100; budget <= full.length; budget += 1) {
      const text = renderProbeSummary(input, budget);
      if (
        text.includes("  #1 b.js:9") ||
        text.includes("build-failure detection:")
      ) {
        expect(text, `budget ${budget}`).toContain("baseline[0]");
        expect(text, `budget ${budget}`).toContain("baseline[1]");
      }
      expect(text, `budget ${budget}`).toContain(HEADING);
    }
  });

  it("a budget that fits the survivors but not the detection line keeps the survivors", () => {
    const full = renderProbeSummary(input).trimEnd().split("\n");
    const withoutDetection = full.filter(
      (l) => !l.startsWith("build-failure detection:"),
    );
    const budget = withoutDetection.join("\n").length + 1;
    const text = renderProbeSummary(input, budget);
    expect(text).toBe(withoutDetection.join("\n") + "\n");
  });
});

describe("renderProbeSummary(): expected survivors never vanish", () => {
  const manySurvivors = (
    count: number,
    reasonLength: number,
  ): SummaryInput => ({
    status: "killed",
    plan: {
      results: Array.from({ length: count }, (_, index) => ({
        index,
        file: "b.js",
        expect: "pass",
        expect_reason: "r".repeat(reasonLength),
        status: "survived",
        mutant: { file: "b.js", line: index + 1 },
        mutation_probe: { result: "survived", expectation: "met" },
      })),
    },
  });

  it("12 survivors with 700-character reasons at the default -m: heading, every entry, each reason capped at 200 characters", () => {
    const text = renderProbeSummary(manySurvivors(12, 700), 8000);
    const lines = text.trimEnd().split("\n");
    expect(lines).toContain(
      "expected survivors (expect: pass, survived, counted as met): 12",
    );
    const entries = lines.filter((l) => l.startsWith("  #"));
    expect(entries).toHaveLength(12);
    for (const entry of entries) {
      const reason = entry.slice(entry.indexOf("reason: ") + 8);
      expect(reason).toHaveLength(200);
      expect(reason.endsWith("...")).toBe(true);
    }
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("a reason of exactly 200 characters is printed whole", () => {
    const text = renderProbeSummary(manySurvivors(1, 200), 8000);
    expect(text).toContain(`reason: ${"r".repeat(200)}\n`);
  });

  it("60 survivors at the default -m: the heading with the full count stays, the entries that do not fit give way to an omission line", () => {
    const text = renderProbeSummary(manySurvivors(60, 700), 8000);
    const lines = text.trimEnd().split("\n");
    expect(lines).toContain(
      "expected survivors (expect: pass, survived, counted as met): 60",
    );
    const shown = lines.filter((l) => l.startsWith("  #")).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(60);
    expect(lines).toContain(
      `... ${60 - shown} expected-survivor lines omitted (-m 8000)`,
    );
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(lines.at(-1)).toMatch(/^totals: /);
  });

  for (const count of [1, 3]) {
    it(`${count} survivor(s) with long reasons when only the heading and the omission line fit: the omission line counts them`, () => {
      const input = manySurvivors(count, 700);
      const full = renderProbeSummary(input, 100000).trimEnd().split("\n");
      const totals = full.at(-1)!;
      const heading = full.find((l) => l.startsWith("expected survivors"))!;
      // heading + omission line + totals + the mutant-line marker, but no entry
      const budget = heading.length + totals.length + 48 + 120 + 6;
      const text = renderProbeSummary(input, budget);
      expect(text.length).toBeLessThanOrEqual(budget);
      expect(text).toContain(
        `... ${count} expected-survivor line${count === 1 ? "" : "s"} omitted (-m ${budget})`,
      );
      expect(text).not.toContain("  #0 ");
    });
  }

  it("even a budget that fits nothing else keeps the heading", () => {
    const text = renderProbeSummary(manySurvivors(3, 50), 60);
    expect(text).toContain(
      "expected survivors (expect: pass, survived, counted as met): 3",
    );
  });
});

describe("renderProbeSummary(): marked killed rows", () => {
  const marked = (index: number, state: string, detail: string) => ({
    index,
    file: "a.ts",
    expect: "fail",
    status: "killed",
    mutation_probe: {
      result: "killed",
      expectation: "met",
      restored_verified: true,
      build_detection: state,
      build_detection_detail: detail,
    },
    test: { stdoutTail: "src/a.ts(1,1): error TS2322: x\n", stderrTail: "" },
  });

  it("the row says `killed (build detection ambiguous)`, a skipped row names its cause, and failing= still reads", () => {
    const text = renderProbeSummary({
      status: "killed",
      plan: {
        results: [
          marked(0, "ambiguous", "TypeError: x"),
          marked(1, "skipped", "log too large"),
        ],
      },
    });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^#0 a\.ts \| killed \(build detection ambiguous\) \| expectation=met \| restored=true \| failing=/,
    );
    expect(lines[1]).toMatch(
      /^#1 a\.ts \| killed \(build detection skipped: log too large\) \| expectation=met /,
    );
  });

  it("the detection lines count ambiguous and skipped rows, each once", () => {
    const text = renderProbeSummary({
      status: "killed",
      plan: {
        results: [
          marked(0, "ambiguous", "TypeError: x"),
          marked(1, "ambiguous", "RangeError: y"),
          marked(2, "skipped", "log too large"),
        ],
      },
    });
    const lines = text.trimEnd().split("\n");
    expect(lines).toContain(
      "build-failure detection ambiguous for 2 killed mutants; check their logs or use --no-build-detect",
    );
    expect(lines).toContain(
      "build-failure detection skipped for 1 killed mutant (truncated output, full log not usable); a compile error there still reads as killed, check their logs",
    );
    expect(
      lines.filter((l) => l.startsWith("build-failure detection")),
    ).toHaveLength(2);
  });

  it("a marker on a row that is not killed is not shown", () => {
    const text = renderProbeSummary({
      status: "survived",
      plan: {
        results: [
          {
            index: 0,
            file: "a.ts",
            expect: "pass",
            status: "survived",
            mutation_probe: {
              result: "survived",
              expectation: "met",
              build_detection: "ambiguous",
            },
          },
        ],
      },
    });
    expect(text).not.toContain("build detection");
    expect(text).not.toContain("build-failure detection");
  });
});

describe("renderProbeSummary(): survivors give way before a row that is not met", () => {
  const survivor = (index: number) => ({
    index,
    file: "b.js",
    expect: "pass",
    expect_reason: "r".repeat(700),
    status: "survived",
    mutant: { file: "b.js", line: index + 1 },
    mutation_probe: { result: "survived", expectation: "met" },
  });
  const violated = (index: number) => ({
    index,
    file: "v.js",
    expect: "fail",
    status: "survived",
    mutant: { file: "v.js", line: index + 1 },
    mutation_probe: { result: "survived", expectation: "violated" },
  });

  it("40 long-reason survivors plus 2 violated rows at the default -m: both violated rows are shown, the survivor lines thin out", () => {
    const results = [
      ...Array.from({ length: 40 }, (_, i) => survivor(i)),
      violated(40),
      violated(41),
    ];
    const text = renderProbeSummary(
      { status: "survived", plan: { results } },
      8000,
    );
    const lines = text.trimEnd().split("\n");
    expect(lines.filter((l) => l.startsWith("#40 v.js"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("#41 v.js"))).toHaveLength(1);
    expect(lines).toContain(
      "expected survivors (expect: pass, survived, counted as met): 40",
    );
    const shown = lines.filter((l) => l.startsWith("  #")).length;
    expect(shown).toBeLessThan(40);
    expect(lines).toContain(
      `... ${40 - shown} expected-survivor lines omitted (-m 8000)`,
    );
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("a build_failed row and a killed row marked ambiguous are kept the same way", () => {
    const flagged = [
      {
        index: 40,
        file: "x.js",
        expect: "fail",
        status: "inconclusive",
        mutation_probe: { result: "build_failed" },
      },
      {
        index: 41,
        file: "y.js",
        expect: "fail",
        status: "killed",
        mutation_probe: {
          result: "killed",
          expectation: "met",
          build_detection: "ambiguous",
        },
      },
    ];
    const results = [
      ...Array.from({ length: 40 }, (_, i) => survivor(i)),
      ...flagged,
    ];
    const text = renderProbeSummary(
      { status: "inconclusive", plan: { results } },
      8000,
    );
    expect(text).toContain("#40 x.js");
    expect(text).toContain("#41 y.js");
  });

  it("a killed row marked ambiguous is the only row that must be kept: it is shown among 40 long-reason survivors", () => {
    const results = [
      ...Array.from({ length: 40 }, (_, i) => survivor(i)),
      {
        index: 40,
        file: "y.js",
        expect: "fail",
        status: "killed",
        mutation_probe: {
          result: "killed",
          expectation: "met",
          build_detection: "ambiguous",
        },
      },
    ];
    const text = renderProbeSummary(
      { status: "killed", plan: { results } },
      8000,
    );
    expect(text).toContain("#40 y.js | killed (build detection ambiguous)");
  });

  it("the last row that must be kept is kept even when dropping it would cost less than the marker that replaces it", () => {
    const short = (index: number) => ({
      ...survivor(index),
      expect_reason: "r",
    });
    // a row longer than the "N more mutant lines omitted" marker, so
    // keeping the rows before it and omitting it is cheaper than keeping it
    const longName = `${"v".repeat(400)}.js`;
    let covered = 0;
    for (let count = 60; count <= 84; count += 2) {
      const results = [
        ...Array.from({ length: count }, (_, i) => short(i)),
        {
          ...violated(count),
          file: longName,
          mutant: { file: longName, line: 1 },
        },
      ];
      const text = renderProbeSummary(
        { status: "survived", plan: { results } },
        8000,
      );
      if (text.includes("expected-survivor line")) covered += 1;
      expect(text, `count ${count}`).toContain(`#${count} ${longName}:1`);
    }
    // the sweep reached budgets where survivor lines had to thin out
    expect(covered).toBeGreaterThan(3);
  });

  it("when even the thinnest candidate cannot keep every such row, the heading and the omission line stay", () => {
    const results = [
      ...Array.from({ length: 40 }, (_, i) => survivor(i)),
      ...Array.from({ length: 60 }, (_, i) => violated(40 + i)),
    ];
    const text = renderProbeSummary(
      { status: "survived", plan: { results } },
      8000,
    );
    const lines = text.trimEnd().split("\n");
    expect(lines).toContain(
      "expected survivors (expect: pass, survived, counted as met): 40",
    );
    expect(
      lines.some((l) => /^\.\.\. 40 expected-survivor lines omitted/.test(l)),
    ).toBe(true);
  });

  it("rows that are all met keep the fullest survivor candidate", () => {
    const results = Array.from({ length: 12 }, (_, i) => survivor(i));
    const text = renderProbeSummary(
      { status: "killed", plan: { results } },
      8000,
    );
    expect(text.split("\n").filter((l) => l.startsWith("  #"))).toHaveLength(
      12,
    );
  });
});

describe("mutationProbeReportItem(): build_failed", () => {
  it("is not_applicable with the build-failed reason, expectation not_applicable", () => {
    const item = mutationProbeReportItem(
      {
        mutant: { file: "a.go", line: 4, before: "x", after: "y" },
        mutation_probe: {
          mutant: "m",
          verified_applied_via: "v",
          result: "build_failed",
          reason: "build_failed",
          restored_verified: true,
        },
      },
      false,
    );
    expect(item.result).toBe("not_applicable");
    expect(item.expectation).toBe("not_applicable");
    expect(item.reason).toBe("build failed, mutant not exercised");
    expect(item.restored_verified).toBe(true);
  });
});
