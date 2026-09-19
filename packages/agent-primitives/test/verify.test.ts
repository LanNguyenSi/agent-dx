import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  verify,
  selectDetector,
  genericDetector,
  vitestDetector,
  tscDetector,
  eslintDetector,
  phpunitDetector,
  phpstanDetector,
  phpcsDetector,
  DEFAULT_CHECKS,
  DEFAULT_DETECTORS,
} from "../src/verify/index.js";
import { phpunitZeroTestsVerdict } from "../src/verify/detectors/phpunit.js";
import { UsageError } from "../src/envelope.js";
import type {
  Detector,
  DetectorParseResult,
  ExecLike,
} from "../src/verify/types.js";
import { execCommand } from "../src/exec.js";
import type { ExecResult } from "../src/exec.js";
import { compilePassRegex } from "../src/pass-regex.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CAPTURED_DIR = path.join(FIXTURES_DIR, "captured");

/** Reads one captured real-tool-output fixture (see
 * test/fixtures/README.md for the tool versions these were captured
 * from). */
function readCaptured(name: string): string {
  return fs.readFileSync(path.join(CAPTURED_DIR, `${name}.txt`), "utf8");
}

/** The three-valued zero-tests reading for one phpunit output, verdict
 * only: `"zero"`, `"not_zero"`, or `"ambiguous"` (see
 * `phpunitZeroTestsVerdict` for what each one means). */
function zeroTests(output: string): string {
  return phpunitZeroTestsVerdict(output).verdict;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-verify-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writePackageJson(cwd: string, scripts: Record<string, string>): void {
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "verify-fixture", version: "0.0.0", scripts }),
  );
}

/** Stub execFn: never spawns a real process. Records every invoked
 * command (for fail-fast / order assertions) and returns a canned
 * ExecResult per command (default: exit 0, no output). */
function makeStubExec(responses: Record<string, Partial<ExecResult>> = {}): {
  fn: ExecLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fn: ExecLike = async (cmd, options) => {
    calls.push(cmd);
    const r = responses[cmd] ?? {};
    return {
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs ?? 1,
      stdoutTail: r.stdoutTail ?? "",
      stderrTail: r.stderrTail ?? "",
      logPath: r.logPath ?? path.join(options.logDir, "stub.log"),
      timedOut: r.timedOut ?? false,
      aborted: r.aborted ?? false,
      logWriteFailed: false,
      outputMayBeIncomplete: r.outputMayBeIncomplete ?? false,
      stdioClosed: r.stdioClosed ?? true,
      stdoutTruncated: r.stdoutTruncated ?? false,
      stderrTruncated: r.stderrTruncated ?? false,
    };
  };
  return { fn, calls };
}

describe("verify: check resolution", () => {
  it("an -x override wins over a package.json script of the same name", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { build: "should-not-run" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({
      cwd,
      logDir,
      checks: ["build"],
      overrides: { build: "echo overridden" },
      execFn: fn,
    });
    expect(calls).toEqual(["echo overridden"]);
    expect(result.checks[0].command).toBe("echo overridden");
  });

  it("falls back to `npm run <name> --silent` when package.json has the script and no override is given", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { build: "tsc" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({ cwd, logDir, checks: ["build"], execFn: fn });
    expect(calls).toEqual(["npm run build --silent"]);
    expect(result.checks[0]).toMatchObject({
      name: "build",
      command: "npm run build --silent",
      status: "pass",
    });
  });

  it("a requested check with neither an override nor a matching script is an explicit no_script non-pass", async () => {
    const cwd = makeTmpDir();
    // A second, resolvable check keeps this run from being all-skipped
    // (which is its own status: "error" / nothing_verified case, covered
    // separately below): this test's own concern is per-check resolution.
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec({
      "npm run test --silent": { exitCode: 0 },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["lint", "test"],
      execFn: fn,
    });
    expect(calls).toEqual(["npm run test --silent"]);
    expect(result.checks[0].command).toBeUndefined();
    expect(result.checks[0]).toMatchObject({
      name: "lint",
      status: "skipped",
      reason: "no_script",
      failures: [],
    });
    expect(result.checks[0].summary.skipped).toBe(1);
    expect(result.warnings).toContain(
      "lint: no_script: no -x override or matching package.json script",
    );
    expect(result.status).toBe("error");

    const overridden = await verify({
      cwd,
      logDir,
      checks: ["lint"],
      overrides: { lint: "echo ok" },
      execFn: fn,
    });
    expect(overridden.checks[0]).toMatchObject({
      name: "lint",
      command: "echo ok",
      status: "pass",
    });
    expect(overridden.status).toBe("pass");
  });

  it("a check name that appears only via -x (not in the requested/default list) still runs", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({
      cwd,
      logDir,
      checks: [],
      overrides: { mycheck: "echo hi" },
      execFn: fn,
    });
    expect(calls).toEqual(["echo hi"]);
    expect(result.checks.map((c) => c.name)).toEqual(["mycheck"]);
  });
});

describe("verify: check order", () => {
  it("runs build, typecheck, lint, test in that order by default", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "t",
      lint: "l",
      test: "te",
    });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({ cwd, logDir, execFn: fn });
    expect(result.checks.map((c) => c.name)).toEqual(DEFAULT_CHECKS);
    expect(calls).toEqual([
      "npm run build --silent",
      "npm run typecheck --silent",
      "npm run lint --silent",
      "npm run test --silent",
    ]);
  });

  it("-c limits and orders the checks that are run", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "t",
      lint: "l",
      test: "te",
    });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({
      cwd,
      logDir,
      checks: ["test", "build"],
      execFn: fn,
    });
    expect(result.checks.map((c) => c.name)).toEqual(["test", "build"]);
    expect(calls).toEqual(["npm run test --silent", "npm run build --silent"]);
  });
});

describe("verify: --fail-fast", () => {
  it("stops after the first non-pass check; the next check's command is never invoked", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "t",
      lint: "l",
      test: "te",
    });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec({
      "npm run build --silent": { exitCode: 1 },
    });
    const result = await verify({ cwd, logDir, failFast: true, execFn: fn });
    expect(calls).toEqual(["npm run build --silent"]);
    expect(result.checks.map((c) => c.name)).toEqual(["build"]);
    expect(result.status).toBe("fail");
  });

  it("stops on an error (exit 127) status too, not only on fail; the next check's command is never invoked", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "t",
      lint: "l",
      test: "te",
    });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec({
      "npm run build --silent": { exitCode: 127 },
    });
    const result = await verify({ cwd, logDir, failFast: true, execFn: fn });
    expect(calls).toEqual(["npm run build --silent"]);
    expect(result.checks.map((c) => c.name)).toEqual(["build"]);
    expect(result.checks[0].status).toBe("error");
    expect(result.status).toBe("error");
  });

  it("stops on a timed-out first check too; the next check's command is never invoked", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "t",
      lint: "l",
      test: "te",
    });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec({
      "npm run build --silent": { timedOut: true },
    });
    const result = await verify({ cwd, logDir, failFast: true, execFn: fn });
    expect(calls).toEqual(["npm run build --silent"]);
    expect(result.checks.map((c) => c.name)).toEqual(["build"]);
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].timedOut).toBe(true);
    expect(result.status).toBe("error");
  });

  it("without --fail-fast, every check still runs after an earlier failure", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "t",
      lint: "l",
      test: "te",
    });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec({
      "npm run build --silent": { exitCode: 1 },
    });
    const result = await verify({ cwd, logDir, failFast: false, execFn: fn });
    expect(calls).toEqual([
      "npm run build --silent",
      "npm run typecheck --silent",
      "npm run lint --silent",
      "npm run test --silent",
    ]);
    expect(result.checks).toHaveLength(4);
  });
});

describe("verify: shell exit code mapping", () => {
  it("maps shell exit 126 and 127 to status error, not fail", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { a: "x", b: "y" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run a --silent": { exitCode: 126 },
      "npm run b --silent": { exitCode: 127 },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["a", "b"],
      execFn: fn,
    });
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[1].status).toBe("error");
    expect(result.status).toBe("error");
  });

  it("a genuine non-zero, non-126/127 exit maps to fail", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({ "npm run test --silent": { exitCode: 1 } });
    const result = await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(result.checks[0].status).toBe("fail");
    expect(result.status).toBe("fail");
  });
});

describe("verify: failures invariant for error checks", () => {
  it("a timed-out check with no parsed failures gets one synthetic failure naming timedOut, and summary.errors is 1", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": { timedOut: true, stdoutTail: "hang" },
    });
    const result = await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].failures[0].message).toContain("timedOut");
    expect(result.checks[0].failures[0].message).toContain("hang");
    expect(result.checks[0].summary.errors).toBe(1);
    expect(result.status).toBe("error");
    expect(
      result.warnings.some((w) => w.includes("detector_matched_nothing")),
    ).toBe(true);
  });

  it("a 127 (not found) check with no parsed failures gets one synthetic failure naming the exit code, and summary.errors is 1", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { nope: "x" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run nope --silent": { exitCode: 127, stderrTail: "not found" },
    });
    const result = await verify({ cwd, logDir, checks: ["nope"], execFn: fn });
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].failures[0].message).toContain("exit code 127");
    expect(result.checks[0].summary.errors).toBe(1);
    expect(result.status).toBe("error");
  });
});

describe("verify: failures invariant", () => {
  it("a fail status with a detector that parses zero failures gets one synthetic failure, never an empty list", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const nothingDetector: Detector = {
      name: "nothing",
      matches: () => true,
      parse: (): DetectorParseResult => ({
        summary: { passed: 0, failed: 0, skipped: 0, errors: 0, warnings: 0 },
        failures: [],
        warnings: [],
      }),
    };
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 1, stdoutTail: "boom" },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [nothingDetector],
    });
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].failures[0].message).toContain("exit code 1");
    expect(result.checks[0].failures[0].message).toContain("boom");
    expect(
      result.warnings.some((w) => w.includes("detector_matched_nothing")),
    ).toBe(true);
  });

  it("a pass status is never given a synthetic failure", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: makeStubExec({ "npm run test --silent": { exitCode: 0 } }).fn,
    });
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].failures).toEqual([]);
  });

  it("the invariant only increments the count when the detector itself reported 0 for it: a detector with an empty failures list but a nonzero failed count is left alone (never double counted)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    // Simulates a real shape: the `Tests` summary line survived the
    // captured tail (it is the very last line eslint/vitest print), but
    // the `FAIL` block itself was pushed out of the tail by a long diff,
    // so the detector's own `failures` list came back empty while its
    // `summary.failed` still correctly states 1.
    const partialDetector: Detector = {
      name: "partial",
      matches: () => true,
      parse: (): DetectorParseResult => ({
        summary: { passed: 0, failed: 1, skipped: 0, errors: 0, warnings: 0 },
        failures: [],
        warnings: [],
      }),
    };
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 1, stdoutTail: "boom" },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [partialDetector],
    });
    expect(result.checks[0].status).toBe("fail");
    // One synthetic entry is still added (the failures list was empty),
    // but the already-correct count of 1 is not bumped to 2.
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].summary.failed).toBe(1);
  });
});

describe("verify: --max-failures", () => {
  it("caps each check's own failures list, failures-first, and marks truncatedByMaxFailures with the full list kept in fullChecks", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const manyFailuresDetector: Detector = {
      name: "many",
      matches: () => true,
      parse: (): DetectorParseResult => ({
        summary: { passed: 0, failed: 30, skipped: 0, errors: 0, warnings: 0 },
        failures: Array.from({ length: 30 }, (_, i) => ({ message: `f${i}` })),
        warnings: [],
      }),
    };
    const { fn } = makeStubExec({ "npm run test --silent": { exitCode: 1 } });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [manyFailuresDetector],
      maxFailures: 5,
    });
    expect(result.checks[0].failures).toHaveLength(5);
    expect(result.checks[0].failures[0].message).toBe("f0");
    expect(result.truncatedByMaxFailures).toBe(true);
    expect(result.fullChecks?.[0].failures).toHaveLength(30);
  });

  it("does not mark truncatedByMaxFailures when nothing exceeds the cap", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({ "npm run test --silent": { exitCode: 0 } });
    const result = await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(result.truncatedByMaxFailures).toBe(false);
    expect(result.fullChecks).toBeUndefined();
  });

  it("rejects maxFailures 0 as a usage error", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    await expect(
      verify({ cwd, logDir, checks: ["test"], execFn: fn, maxFailures: 0 }),
    ).rejects.toThrow(UsageError);
    expect(calls).toEqual([]);
  });

  it("rejects a non-integer maxFailures as a usage error", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec();
    await expect(
      verify({ cwd, logDir, checks: ["test"], execFn: fn, maxFailures: 1.5 }),
    ).rejects.toThrow(UsageError);
  });
});

describe("verify: --fail-fast falls through a skipped check", () => {
  it("does not stop on a skipped check; a later fail still stops the run", async () => {
    const cwd = makeTmpDir();
    // No `build` script: the first default check resolves to skipped.
    writePackageJson(cwd, { typecheck: "t", lint: "l", test: "te" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({ cwd, logDir, failFast: true, execFn: fn });
    expect(result.checks.map((c) => c.name)).toEqual(DEFAULT_CHECKS);
    expect(result.checks[0].status).toBe("skipped");
    expect(calls).toEqual([
      "npm run typecheck --silent",
      "npm run lint --silent",
      "npm run test --silent",
    ]);
    expect(result.status).toBe("error");
  });

  it("stops after the first check that actually fails, once past any leading skips", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "t", lint: "l", test: "te" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec({
      "npm run typecheck --silent": { exitCode: 1 },
    });
    const result = await verify({ cwd, logDir, failFast: true, execFn: fn });
    expect(calls).toEqual(["npm run typecheck --silent"]);
    expect(result.checks.map((c) => c.name)).toEqual(["build", "typecheck"]);
    expect(result.checks[0].status).toBe("skipped");
    expect(result.checks[1].status).toBe("fail");
    expect(result.status).toBe("error");
  });
});

describe("verify: check name validation", () => {
  it("rejects a -c name carrying shell metacharacters before ever building a command", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    await expect(
      verify({
        cwd,
        logDir,
        checks: ["good; touch /tmp/pwned-agent-primitives-test"],
        execFn: fn,
      }),
    ).rejects.toThrow(UsageError);
    expect(calls).toEqual([]);
  });

  it("rejects an -x override name carrying shell metacharacters before ever building a command", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    await expect(
      verify({
        cwd,
        logDir,
        checks: [],
        overrides: { "bad name": "echo hi" },
        execFn: fn,
      }),
    ).rejects.toThrow(UsageError);
    expect(calls).toEqual([]);
  });

  it("accepts names built only from letters, digits, underscore, dot, colon, and hyphen", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { "a.b:c-d_1": "x" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    await verify({ cwd, logDir, checks: ["a.b:c-d_1"], execFn: fn });
    expect(calls).toEqual(["npm run a.b:c-d_1 --silent"]);
  });
});

describe("verify: duplicate check names", () => {
  it("-c d,d runs the check once, not twice", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { d: "x" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({
      cwd,
      logDir,
      checks: ["d", "d"],
      execFn: fn,
    });
    expect(calls).toEqual(["npm run d --silent"]);
    expect(result.checks).toHaveLength(1);
  });
});

describe("verify: nothing_verified", () => {
  it("every requested check resolving to skipped is status error, reason nothing_verified, with a warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({ cwd, logDir, execFn: fn });
    expect(calls).toEqual([]);
    expect(result.checks.every((c) => c.status === "skipped")).toBe(true);
    expect(result.status).toBe("error");
    expect(result.reason).toBe("nothing_verified");
    expect(result.warnings.some((w) => w.includes("nothing_verified"))).toBe(
      true,
    );
  });

  it("an empty resolved check list (checks: []) is status error, reason nothing_verified, never a silent pass", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const result = await verify({ cwd, logDir, checks: [], execFn: fn });
    expect(calls).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(result.status).toBe("error");
    expect(result.reason).toBe("nothing_verified");
    expect(result.warnings.some((w) => w.includes("nothing_verified"))).toBe(
      true,
    );
  });
});

describe("verify: unique per-run logs", () => {
  it("two runs sharing one logDir keep separate log files; the second run's logPath contains only its own output", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { echoer: "x" });
    const logDir = makeTmpDir();

    const firstResult = await verify({
      cwd,
      logDir,
      checks: ["echoer"],
      overrides: { echoer: "echo first-run-output" },
    });
    const secondResult = await verify({
      cwd,
      logDir,
      checks: ["echoer"],
      overrides: { echoer: "echo second-run-output" },
    });

    const firstLogPath = firstResult.checks[0].logPath as string;
    const secondLogPath = secondResult.checks[0].logPath as string;
    expect(firstLogPath).not.toBe(secondLogPath);

    const secondLogContents = fs.readFileSync(secondLogPath, "utf8");
    expect(secondLogContents).toContain("second-run-output");
    expect(secondLogContents).not.toContain("first-run-output");

    const firstLogContents = fs.readFileSync(firstLogPath, "utf8");
    expect(firstLogContents).toContain("first-run-output");
    expect(firstLogContents).not.toContain("second-run-output");
  }, 20000);
});

describe("verify: status ternary, error wins over fail", () => {
  it("one exit-1 (fail) check and one exit-127 (error) check: top-level status is error", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { failer: "x", errorer: "y" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run failer --silent": { exitCode: 1 },
      "npm run errorer --silent": { exitCode: 127 },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["failer", "errorer"],
      execFn: fn,
    });
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[1].status).toBe("error");
    expect(result.status).toBe("error");
  });
});

describe("verify: detector selection through verify()", () => {
  function makeStubDetector(name: string, matches: boolean): Detector {
    return {
      name,
      matches: () => matches,
      parse: (): DetectorParseResult => ({
        summary: { passed: 0, failed: 0, skipped: 0, errors: 0, warnings: 0 },
        failures: [],
        warnings: [],
      }),
    };
  }

  it("two always-matching candidates plus the default fallback: ambiguity warning names both candidates, checks[0].detector is the fallback", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({ "npm run test --silent": { exitCode: 0 } });
    const alpha = makeStubDetector("alpha", true);
    const beta = makeStubDetector("beta", true);
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [alpha, beta],
    });
    expect(result.checks[0].detector).toBe(genericDetector.name);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("ambiguous") && w.includes("alpha") && w.includes("beta"),
      ),
    ).toBe(true);
  });

  it("one matching candidate: checks[0].detector is that candidate's name", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({ "npm run test --silent": { exitCode: 0 } });
    const alpha = makeStubDetector("alpha", true);
    const beta = makeStubDetector("beta", false);
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [alpha, beta],
    });
    expect(result.checks[0].detector).toBe("alpha");
  });
});

describe("verify: package.json unreadable warning", () => {
  it("warns when a requested check needs script resolution and package.json is missing", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const { fn } = makeStubExec();
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
    });
    expect(
      result.warnings.some((w) => w.includes("package.json not readable")),
    ).toBe(true);
  });

  it("does not warn when every requested name is covered by an -x override, even with no package.json", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const { fn } = makeStubExec();
    const result = await verify({
      cwd,
      logDir,
      checks: [],
      overrides: { mycheck: "echo hi" },
      execFn: fn,
    });
    expect(
      result.warnings.some((w) => w.includes("package.json not readable")),
    ).toBe(false);
  });
});

describe("verify: summary.errors floor", () => {
  it("a stub detector returning nonempty failures with summary.errors 0 on a 127 exit still reports summary.errors 1", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { nope: "x" });
    const logDir = makeTmpDir();
    const oneFailureDetector: Detector = {
      name: "one-failure",
      matches: () => true,
      parse: (): DetectorParseResult => ({
        summary: { passed: 0, failed: 1, skipped: 0, errors: 0, warnings: 0 },
        failures: [{ message: "some parsed failure" }],
        warnings: [],
      }),
    };
    const { fn } = makeStubExec({ "npm run nope --silent": { exitCode: 127 } });
    const result = await verify({
      cwd,
      logDir,
      checks: ["nope"],
      execFn: fn,
      detectors: [oneFailureDetector],
    });
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].failures[0].message).toBe("some parsed failure");
    expect(result.checks[0].summary.errors).toBe(1);
  });
});

describe("verify: exec rejection is a per-check error, not a thrown promise", () => {
  it("an execFn that rejects records that check as status error with a synthetic failure naming the error, and the run continues", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { broken: "x", test: "te" });
    const logDir = makeTmpDir();
    const failingExec: ExecLike = async (cmd) => {
      if (cmd === "npm run broken --silent") {
        throw new Error("simulated exec failure: ENOSPC");
      }
      return {
        exitCode: 0,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        logPath: path.join(logDir, "stub.log"),
        timedOut: false,
        aborted: false,
        logWriteFailed: false,
        outputMayBeIncomplete: false,
        stdioClosed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };
    const result = await verify({
      cwd,
      logDir,
      checks: ["broken", "test"],
      execFn: failingExec,
    });
    expect(result.checks[0].name).toBe("broken");
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].failures[0].message).toContain(
      "simulated exec failure",
    );
    expect(result.checks[0].summary.errors).toBe(1);
    // The run continues past the failed check to the next one.
    expect(result.checks[1].name).toBe("test");
    expect(result.checks[1].status).toBe("pass");
    expect(result.status).toBe("error");
  });

  it("a --pass-regex configured for a check whose execFn rejects warns that the predicate was never consulted", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { broken: "x" });
    const logDir = makeTmpDir();
    const failingExec: ExecLike = async () => {
      throw new Error("simulated exec failure: ENOSPC");
    };
    const result = await verify({
      cwd,
      logDir,
      checks: ["broken"],
      execFn: failingExec,
      passRegexes: { broken: /ok/ },
    });
    expect(result.checks[0].status).toBe("error");
    expect(result.warnings).toContain(
      "broken: --pass-regex (ok) was given but the check failed to run (exec failed), so the predicate was never consulted",
    );
  });
});

describe("verify: detector warnings merge", () => {
  it("merges a detector's own parsed.warnings into the top-level warnings, prefixed with the check name", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const warningDetector: Detector = {
      name: "warns",
      matches: () => true,
      parse: (): DetectorParseResult => ({
        summary: { passed: 1, failed: 0, skipped: 0, errors: 0, warnings: 1 },
        failures: [],
        warnings: ["a deprecation notice"],
      }),
    };
    const { fn } = makeStubExec({ "npm run test --silent": { exitCode: 0 } });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [warningDetector],
    });
    expect(result.warnings).toContain("test: a deprecation notice");
  });
});

describe("verify: --pass-regex opt-in success predicate", () => {
  it("regex matched + exit 1 -> pass, with a warning naming the non-zero exit code (AC-003)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: "OK (11 tests, 17 assertions)\n",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.exitCode).toBe(1);
    expect(check.passRegex).toBe("^OK \\(");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("test: --pass-regex (^OK \\() matched") &&
          w.includes("non-zero exit code (1)"),
      ),
    ).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("regex absent + exit 0 -> fail, with a warning naming the pattern (AC-003)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: "something else entirely\n",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    const check = result.checks[0];
    expect(check.status).toBe("fail");
    expect(check.exitCode).toBe(0);
    expect(
      result.warnings.some((w) =>
        w.includes(
          "test: --pass-regex (^OK \\() did not match the check's output",
        ),
      ),
    ).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("a predicate-decided pass with the detector's own parsed failures still reports pass, but warns the predicate may be too loose", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    // The real phpunit-fail.txt fixture: a genuine `FAILURES!` run
    // (`Tests: 2, Assertions: 2, Failures: 1.`). A predicate matching
    // its banner line ahead of the failure section is exactly the "too
    // loose" shape this warning exists for.
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: readCaptured("phpunit-fail"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^PHPUnit 9\\.6") },
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.summary.failed).toBeGreaterThan(0);
    expect(check.failures.length).toBeGreaterThan(0);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /test: --pass-regex \(\^PHPUnit 9\\\.6\) matched, but the phpunit detector parsed 1 failure\(s\) of its own; the predicate may be too loose/,
      ),
    );
  });

  it("a check with no predicate keeps the plain exit-code verdict, unaffected by a predicate on a different check", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { build: "b", test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run build --silent": { exitCode: 1, stdoutTail: "boom" },
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: "OK (1 test, 1 assertion)",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["build", "test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    const build = result.checks.find((c) => c.name === "build")!;
    const test = result.checks.find((c) => c.name === "test")!;
    expect(build.status).toBe("fail");
    // `"passRegex" in build` (not `.toBeUndefined()`): pins the KEY's
    // absence, not merely an undefined value at a key that might still
    // be present (e.g. explicitly set to `undefined` by a future change),
    // matching how a real JSON-serialized envelope would drop the key.
    expect("passRegex" in build).toBe(false);
    expect(test.status).toBe("pass");
    expect(test.passRegex).toBe("^OK \\(");
  });

  it("exit 126/127 stays error even with a predicate configured, whatever the output", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 127,
        stdoutTail: "OK (1 test, 1 assertion)",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("error");
    expect("passRegex" in result.checks[0]).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /test: --pass-regex \(\^OK \\\(\) was given but the check exited with code 127, so the predicate was never consulted/,
      ),
    );
  });

  it("a timed-out check stays error even with a predicate configured, whatever the output", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        timedOut: true,
        stdoutTail: "OK (1 test, 1 assertion)",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("error");
    expect("passRegex" in result.checks[0]).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /test: --pass-regex \(\^OK \\\(\) was given but the check timed out, so the predicate was never consulted/,
      ),
    );
  });

  it("an aborted check stays error even with a predicate configured, whatever the output", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        aborted: true,
        stdoutTail: "OK (1 test, 1 assertion)",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("error");
    expect("passRegex" in result.checks[0]).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /test: --pass-regex \(\^OK \\\(\) was given but the check was aborted before it could finish, so the predicate was never consulted/,
      ),
    );
  });

  it("rejects a --pass-regex naming a check that is neither requested nor -x-overridden (no silent no-op)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn, calls } = makeStubExec();
    await expect(
      verify({
        cwd,
        logDir,
        checks: ["test"],
        execFn: fn,
        passRegexes: { lint: compilePassRegex("^OK \\(") },
      }),
    ).rejects.toThrow(UsageError);
    expect(calls).toEqual([]);
  });

  it("accepts a --pass-regex naming a check that only exists via -x override", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "irrelevant-command": {
        exitCode: 1,
        stdoutTail: "OK (1 test, 1 assertion)",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: [],
      overrides: { mycheck: "irrelevant-command" },
      execFn: fn,
      passRegexes: { mycheck: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("pass");
  });

  it("a requested check with a predicate that resolves to skipped (no script, no -x) warns the predicate was never consulted", async () => {
    const cwd = makeTmpDir();
    // Only `build` has a script; `test` is requested and carries a
    // predicate, but has neither a package.json script nor an -x
    // override, so it resolves to skipped -- a multi-check run so the
    // overall result is not itself `nothing_verified` (which would mask
    // the per-check warning this test is actually about).
    writePackageJson(cwd, { build: "b" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run build --silent": { exitCode: 0 },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["build", "test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    const test = result.checks.find((c) => c.name === "test")!;
    expect(test.status).toBe("skipped");
    expect("passRegex" in test).toBe(false);
    expect(
      result.warnings.some(
        (w) =>
          w ===
          `test: --pass-regex (^OK \\() was given but the check resolved to skipped, so the predicate was never consulted`,
      ),
    ).toBe(true);
    expect(result.status).toBe("error");
  });
});

describe("verify: --pass-regex with a real detector, summary comes from the detector (AC-004)", () => {
  it("a passing predicate keeps the detector's own parsed summary; no synthetic failure entry is added", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: readCaptured("phpunit-deprecation-notice"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.summary.passed).toBe(1);
    expect(check.summary.failed).toBe(0);
    expect(check.failures).toEqual([]);
    expect(
      result.warnings.some((w) => w.includes("detector_matched_nothing")),
    ).toBe(false);
  });

  it("the same fixture without a predicate keeps today's (buggy) exit-code verdict: fail with a synthetic failure", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: readCaptured("phpunit-deprecation-notice"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("fail");
    expect(check.failures).toHaveLength(1);
    expect(
      result.warnings.some((w) => w.includes("detector_matched_nothing")),
    ).toBe(true);
  });

  it("a predicate-decided fail with zero parsed failures gets exactly one synthetic entry labeled from the predicate, not the exit code", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      // Exit 0 (a green-looking exit) but the phpunit detector parses
      // zero failures out of this output either way (it does not match
      // any phpunit shape at all) -- the predicate is what decides
      // `fail` here, not the detector and not the exit code.
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: "totally unrelated output, no OK line here\n",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    const check = result.checks[0];
    expect(check.status).toBe("fail");
    expect(check.failures).toHaveLength(1);
    expect(check.failures[0].message).toMatch(
      /^--pass-regex \(\^OK \\\(\) did not match: /,
    );
    expect(check.failures[0].message).not.toMatch(/^exit code/);
    // The generic `detector_matched_nothing` wording is reworded on this
    // path: a reader should see the predicate named as the reason, not a
    // bare "the detector found nothing" that reads as if no predicate
    // were involved at all.
    expect(
      result.warnings.some((w) => w.includes("detector_matched_nothing")),
    ).toBe(false);
    expect(
      result.warnings.some((w) => w.includes("pass_regex_matched_nothing")),
    ).toBe(true);
  });
});

describe("verify: --pass-regex map lookup guards inherited Object.prototype names", () => {
  it("a check named 'constructor' with no predicate configured runs normally (does not crash on the inherited Object.prototype.constructor)", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      'printf "hi\\n"': {
        exitCode: 0,
        stdoutTail: "hi\n",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["constructor"],
      overrides: { constructor: 'printf "hi\\n"' },
      execFn: fn,
    });
    expect(result.checks[0].name).toBe("constructor");
    expect(result.checks[0].status).toBe("pass");
    expect(result.status).toBe("pass");
  });

  it("a check named 'constructor' still runs normally while a predicate is configured for another check", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      'printf "hi\\n"': {
        exitCode: 0,
        stdoutTail: "hi\n",
      },
      'printf "other\\n"': {
        exitCode: 0,
        stdoutTail: "other\n",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["constructor", "other"],
      overrides: {
        constructor: 'printf "hi\\n"',
        other: 'printf "other\\n"',
      },
      passRegexes: { other: /other/ },
      execFn: fn,
    });
    expect(result.checks[0].name).toBe("constructor");
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[1].name).toBe("other");
    expect(result.checks[1].status).toBe("pass");
    expect(result.status).toBe("pass");
  });
});

describe("verify: --pass-regex signal-band wording and truncated-tail caveats", () => {
  it("a match despite exit 137 (SIGKILL's 128+N band) gets the signal wording, not plain deprecation-notice wording", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 137,
        stdoutTail: "OK (1 test, 1 assertion)",
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("pass");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("test: --pass-regex (^OK \\() matched") &&
          w.includes(
            "exited with 137, the code a shell reports for a process killed by signal 9",
          ) &&
          w.includes("the suite may have been cut short"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("deprecation-notice noise")),
    ).toBe(false);
  });

  it("a truncated tail on a --pass-regex miss appends the truncation caveat to the warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: "no match here",
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("fail");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("test: --pass-regex (^OK \\() did not match") &&
          w.includes("captured stdout tail was truncated") &&
          w.includes(
            "the pattern may have matched output outside the captured tail",
          ),
      ),
    ).toBe(true);
  });

  it("a truncated tail on a --pass-regex PASS still runs the truncation adjustment (output_tail_truncated warning present)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: "OK (1 test, 1 assertion)",
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      passRegexes: { test: compilePassRegex("^OK \\(") },
    });
    expect(result.checks[0].status).toBe("pass");
    expect(
      result.warnings.some((w) => w.includes("output_tail_truncated")),
    ).toBe(true);
  });

  it("a truncated tail on a check with NO predicate is unaffected on a pass (no output_tail_truncated warning)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: "all good",
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
    });
    expect(result.checks[0].status).toBe("pass");
    expect(
      result.warnings.some((w) => w.includes("output_tail_truncated")),
    ).toBe(false);
  });
});

describe("selectDetector", () => {
  const stubParse = (): DetectorParseResult => ({
    summary: { passed: 0, failed: 0, skipped: 0, errors: 0, warnings: 0 },
    failures: [],
    warnings: [],
  });

  function makeAlphaBeta(
    alphaMatches: boolean,
    betaMatches: boolean,
  ): Detector[] {
    const alpha: Detector = {
      name: "alpha",
      matches: () => alphaMatches,
      parse: stubParse,
    };
    const beta: Detector = {
      name: "beta",
      matches: () => betaMatches,
      parse: stubParse,
    };
    return [alpha, beta];
  }

  it("zero candidates: selects the fallback (generic) detector", () => {
    const detectors = makeAlphaBeta(false, false);
    const selection = selectDetector(detectors, genericDetector, {
      output: "anything",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(selection.detector).toBe(genericDetector);
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("one candidate: selects that candidate, never the fallback", () => {
    const detectors = makeAlphaBeta(true, false);
    const selection = selectDetector(detectors, genericDetector, {
      output: "anything",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(selection.detector.name).toBe("alpha");
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("two or more candidates, exactly one named by the command text: selects that one", () => {
    const detectors = makeAlphaBeta(true, true);
    const selection = selectDetector(detectors, genericDetector, {
      output: "anything",
      command: "npm run test --silent -- alpha",
      exitCode: 1,
    });
    expect(selection.detector.name).toBe("alpha");
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("two or more candidates, none (or more than one) named by the command text: falls back to generic with the candidate shapes listed", () => {
    const detectors = makeAlphaBeta(true, true);
    const selection = selectDetector(detectors, genericDetector, {
      output: "anything",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(selection.detector).toBe(genericDetector);
    expect(selection.ambiguousCandidates).toEqual(["alpha", "beta"]);
  });

  it("a candidate named by the command text only as a substring of a longer word does not count as named (token boundary)", () => {
    const tsc: Detector = {
      name: "tsc",
      matches: () => true,
      parse: stubParse,
    };
    const other: Detector = {
      name: "other",
      matches: () => true,
      parse: stubParse,
    };
    const selection = selectDetector([tsc, other], genericDetector, {
      output: "anything",
      command: "npm run typecheck --silent -- --project tsconfig.json",
      exitCode: 1,
    });
    // "tsc" is only a substring of "tsconfig.json", not a whole token, so
    // it must not be treated as named by the command: ambiguous, fallback.
    expect(selection.detector).toBe(genericDetector);
    expect(selection.ambiguousCandidates).toEqual(["tsc", "other"]);
  });
});

describe("genericDetector", () => {
  it("reports passed: 1 on a zero exit and parses no failures either way", () => {
    const passResult = genericDetector.parse({
      output: "ok",
      command: "npm run test --silent",
      exitCode: 0,
    });
    expect(passResult.summary.passed).toBe(1);
    expect(passResult.failures).toEqual([]);

    const failResult = genericDetector.parse({
      output: "boom",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(failResult.summary.passed).toBe(0);
    expect(failResult.failures).toEqual([]);
  });
});

describe("verify: integration against a real package.json fixture", () => {
  it("runs build/typecheck/lint/test through real exec, one failing", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, {
      build: "echo build-ok",
      typecheck: "echo typecheck-ok",
      lint: "echo lint-ok",
      test: "echo test-failed 1>&2; exit 1",
    });
    const logDir = makeTmpDir();
    const result = await verify({ cwd, logDir });

    expect(result.checks.map((c) => c.name)).toEqual(DEFAULT_CHECKS);
    expect(result.checks.slice(0, 3).every((c) => c.status === "pass")).toBe(
      true,
    );
    const testCheck = result.checks[3];
    expect(testCheck.status).toBe("fail");
    expect(testCheck.exitCode).toBe(1);
    expect(testCheck.failures.length).toBeGreaterThan(0);
    expect(result.status).toBe("fail");
    for (const check of result.checks) {
      expect(check.logPath).toBeTruthy();
      expect(fs.existsSync(check.logPath as string)).toBe(true);
    }
  }, 20000);

  it("an unwritable log path omits that check's log from `logs` and warns naming the check and the write error", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    // exec.ts derives the log file path as
    // `<logDir>/verify/<runId>/<name>.log`; a fixed runId makes that path
    // predictable so pre-creating a directory at that exact path forces
    // the write stream `createWriteStream` opens there to fail (EISDIR)
    // without touching exec.ts itself or relying on filesystem permission
    // bits (which sandboxes and CI runners do not treat uniformly).
    const runId = "eisdir-test-run";
    const runSubdir = path.join(logDir, "verify", runId);
    fs.mkdirSync(runSubdir, { recursive: true });
    fs.mkdirSync(path.join(runSubdir, "test.log"));

    const result = await verify({ cwd, logDir, checks: ["test"], runId });

    expect(result.logs).toEqual([]);
    expect(
      result.warnings.some(
        (w) => w.startsWith("test: log write failed") && w.includes("EISDIR"),
      ),
    ).toBe(true);
  }, 20000);
});

describe("verify: output that may be incomplete", () => {
  it("warns, naming the check, when a check's command settled on the flush grace with a descendant still holding its pipes", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, { test: "run-the-suite" });
    const { fn } = makeStubExec({
      "npm run test --silent": { outputMayBeIncomplete: true },
    });
    const result = await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(
      result.warnings.some(
        (w) => w.startsWith("test:") && w.includes("may be incomplete"),
      ),
    ).toBe(true);
  });

  it("says nothing when every check's output is complete", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, { test: "run-the-suite" });
    const { fn } = makeStubExec();
    const result = await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(result.warnings.some((w) => w.includes("may be incomplete"))).toBe(
      false,
    );
  });
});

describe("verify: the optional signal", () => {
  it("hands the signal it was given to every exec call, so the caller can abort an in-flight check", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, { build: "b", test: "t" });
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const fn: ExecLike = async (_cmd, options) => {
      seen.push(options.signal);
      return {
        exitCode: 0,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        logPath: path.join(options.logDir, "stub.log"),
        timedOut: false,
        aborted: false,
        logWriteFailed: false,
        outputMayBeIncomplete: false,
        stdioClosed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };
    await verify({
      cwd,
      logDir,
      checks: ["build", "test"],
      execFn: fn,
      signal: controller.signal,
    });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it("passes no signal when the caller gave none, leaving exec's behaviour unchanged", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, { test: "t" });
    const seen: (AbortSignal | undefined)[] = [];
    const fn: ExecLike = async (_cmd, options) => {
      seen.push(options.signal);
      return {
        exitCode: 0,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        logPath: path.join(options.logDir, "stub.log"),
        timedOut: false,
        aborted: false,
        logWriteFailed: false,
        outputMayBeIncomplete: false,
        stdioClosed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };
    await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(seen).toEqual([undefined]);
  });
});

describe("verify: an aborted run", () => {
  it("stops the run when a check is aborted: the queued checks are never spawned and the result names the abort", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, {
      build: "b",
      typecheck: "tc",
      lint: "l",
      test: "t",
    });
    const controller = new AbortController();
    const calls: string[] = [];
    // The first check is the one the abort lands on: exec reports it as
    // aborted, exactly as exec.ts does for a signal that killed the
    // child's process group.
    const fn: ExecLike = async (cmd, options) => {
      calls.push(cmd);
      const aborted = calls.length === 1;
      if (aborted) controller.abort();
      return {
        exitCode: aborted ? null : 0,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        logPath: path.join(options.logDir, "stub.log"),
        timedOut: false,
        aborted,
        logWriteFailed: false,
        outputMayBeIncomplete: false,
        stdioClosed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };

    const result = await verify({
      cwd,
      logDir,
      checks: ["build", "typecheck", "lint", "test"],
      execFn: fn,
      signal: controller.signal,
    });

    // The two checks queued behind the aborted one were never spawned.
    expect(calls).toEqual(["npm run build --silent"]);
    expect(result.checks.map((c) => c.name)).toEqual(["build"]);
    expect(result.status).toBe("error");
    expect(result.reason).toBe("aborted");
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].failures[0].message).toContain("aborted");
    // Never the failures invariant's synthetic entry, which would
    // present a run that was stopped as a check that ran and produced
    // nothing parseable.
    expect(
      result.checks[0].failures.some((f) => f.message.includes("exit code")),
    ).toBe(false);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("typecheck") && w.includes("lint") && w.includes("test"),
      ),
    ).toBe(true);
  });

  it("stops the run for an aborted check even when no signal option was passed, since the abort reaches it through the exec result alone", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, { build: "b", typecheck: "tc", test: "t" });
    const calls: string[] = [];
    // No `signal` option at all: a caller whose own exec seam reports an
    // aborted run (its provider holds the signal) still gets a run that
    // stops, rather than one that spawns every remaining check.
    const fn: ExecLike = async (cmd, options) => {
      calls.push(cmd);
      const aborted = calls.length === 1;
      return {
        exitCode: aborted ? null : 0,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        logPath: path.join(options.logDir, "stub.log"),
        timedOut: false,
        aborted,
        logWriteFailed: false,
        outputMayBeIncomplete: false,
        stdioClosed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };

    const result = await verify({
      cwd,
      logDir,
      checks: ["build", "typecheck", "test"],
      execFn: fn,
    });

    expect(calls).toEqual(["npm run build --silent"]);
    expect(result.reason).toBe("aborted");
    expect(
      result.warnings.some(
        (w) => w.includes("typecheck") && w.includes("test"),
      ),
    ).toBe(true);
  });

  it("starts no check at all when the signal has already fired before the run began", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    writePackageJson(cwd, { build: "b", test: "t" });
    const controller = new AbortController();
    controller.abort();
    const { fn, calls } = makeStubExec();

    const result = await verify({
      cwd,
      logDir,
      checks: ["build", "test"],
      execFn: fn,
      signal: controller.signal,
    });

    expect(calls).toEqual([]);
    expect(result.status).toBe("error");
    // `aborted`, not `nothing_verified`: the run was stopped, which is a
    // different thing to tell a caller than "every check was skipped".
    expect(result.reason).toBe("aborted");
    expect(result.reason).not.toBe("nothing_verified");
    expect(result.warnings.some((w) => w.includes("never started"))).toBe(true);
  });
});

describe("vitestDetector: captured real output", () => {
  it("matches a mixed run, a green run, and the no-test-files case", () => {
    expect(
      vitestDetector.matches({
        output: readCaptured("vitest-fail"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
    expect(
      vitestDetector.matches({
        output: readCaptured("vitest-pass"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      vitestDetector.matches({
        output: readCaptured("vitest-no-tests"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
  });

  it("does not match tsc or eslint captured output (shape disjointness)", () => {
    for (const name of [
      "tsc-errors",
      "tsc-clean",
      "eslint-errors",
      "eslint-warnings",
      "eslint-clean",
    ]) {
      expect(
        vitestDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: name.includes("clean") ? 0 : 1,
        }),
      ).toBe(false);
    }
  });

  it("parses a mixed run: one failure with file, name, and the assertion message; summary 1 passed 1 failed", () => {
    const parsed = vitestDetector.parse({
      output: readCaptured("vitest-fail"),
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 1,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("sample.test.js");
    expect(parsed.failures[0].name).toContain("is wrong");
    expect(parsed.failures[0].message).toContain("AssertionError");
  });

  it("parses a green run: 0 failures, summary passed equals the total", () => {
    const parsed = vitestDetector.parse({
      output: readCaptured("vitest-pass"),
      command: "npm run test --silent",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary.passed).toBe(2);
    expect(parsed.summary.failed).toBe(0);
  });

  it("parses the no-test-files case: no false passed:0/failed:0 claim of its own, no failures (the failures invariant, not this detector, supplies the synthetic entry)", () => {
    const parsed = vitestDetector.parse({
      output: readCaptured("vitest-no-tests"),
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
  });
});

describe("tscDetector: captured real output", () => {
  it("matches multi-error tsc output, not the clean (empty) case", () => {
    expect(
      tscDetector.matches({
        output: readCaptured("tsc-errors"),
        command: "",
        exitCode: 2,
      }),
    ).toBe(true);
    expect(
      tscDetector.matches({
        output: readCaptured("tsc-clean"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(false);
  });

  it("does not match vitest or eslint captured output (shape disjointness)", () => {
    for (const name of [
      "vitest-fail",
      "vitest-pass",
      "vitest-no-tests",
      "eslint-errors",
      "eslint-warnings",
      "eslint-clean",
    ]) {
      expect(
        tscDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: 1,
        }),
      ).toBe(false);
    }
  });

  it("parses every diagnostic line; summary.errors equals the count", () => {
    const parsed = tscDetector.parse({
      output: readCaptured("tsc-errors"),
      command: "npm run typecheck --silent",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(3);
    expect(parsed.summary.errors).toBe(3);
    expect(parsed.failures[0].file).toBe("a.ts");
    expect(parsed.failures[0].line).toBe(5);
    expect(parsed.failures[0].message).toContain("TS2322");
    expect(parsed.failures[2].line).toBe(11);
    expect(parsed.failures[2].message).toContain("TS2554");
  });
});

describe("eslintDetector: captured real output", () => {
  it("matches an errors run and a warnings-only run, not the clean (empty) case", () => {
    expect(
      eslintDetector.matches({
        output: readCaptured("eslint-errors"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
    expect(
      eslintDetector.matches({
        output: readCaptured("eslint-warnings"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      eslintDetector.matches({
        output: readCaptured("eslint-clean"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(false);
  });

  it("does not match vitest or tsc captured output (shape disjointness)", () => {
    for (const name of [
      "vitest-fail",
      "vitest-pass",
      "vitest-no-tests",
      "tsc-errors",
      "tsc-clean",
    ]) {
      expect(
        eslintDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: 1,
        }),
      ).toBe(false);
    }
  });

  it("error rows populate failures with the rule id appended to the message", () => {
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-errors"),
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(3);
    expect(parsed.summary.errors).toBe(3);
    expect(parsed.summary.warnings).toBe(0);
    expect(parsed.failures[0].file).toBe("/project/a.js");
    expect(parsed.failures[0].line).toBe(2);
    expect(parsed.failures[0].message).toContain("no-unused-vars");
  });

  it("warning rows count into summary.warnings and never populate failures on a zero-exit (pass) check", () => {
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-warnings"),
      command: "npm run lint --silent",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary.warnings).toBe(1);
    expect(parsed.summary.errors).toBe(0);
  });

  it("a row with no rule column (a parsing error) is still a failure, and still counted", () => {
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-parsing-error"),
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.summary.errors).toBe(1);
    expect(parsed.failures[0].file).toBe("/project/bad.js");
    expect(parsed.failures[0].line).toBe(2);
    expect(parsed.failures[0].message).toBe(
      "Parsing error: Unexpected keyword 'return'",
    );
  });

  it("a scoped plugin rule id (`@typescript-eslint/no-unused-vars`) is captured whole, and the message's own inline regex-literal token just before it is never mistaken for the rule id", () => {
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-scoped-rule-id"),
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.summary.errors).toBe(1);
    expect(parsed.failures[0].file).toBe("/project/a.ts");
    expect(parsed.failures[0].message).toContain(
      "@typescript-eslint/no-unused-vars",
    );
    expect(parsed.failures[0].message).toContain("/^_/u");
  });

  it("a file header with a space in its path is recognized (structural match, not \\S*)", () => {
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-space-in-path"),
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(3);
    for (const failure of parsed.failures) {
      expect(failure.file).toBe("/project/my file.js");
    }
  });

  it("two files, only the second with a space in its path: every row attributed to its own file, no bleed from the first", () => {
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-two-files-second-has-space"),
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(6);
    const firstFileFailures = parsed.failures.filter(
      (f) => f.file === "/project/plain.js",
    );
    const secondFileFailures = parsed.failures.filter(
      (f) => f.file === "/project/with space.js",
    );
    expect(firstFileFailures).toHaveLength(3);
    expect(secondFileFailures).toHaveLength(3);
  });

  it("colorized (ANSI SGR) output parses identically to the plain capture", () => {
    expect(
      eslintDetector.matches({
        output: readCaptured("eslint-errors-colorized"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
    const parsed = eslintDetector.parse({
      output: readCaptured("eslint-errors-colorized"),
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(3);
    expect(parsed.summary.errors).toBe(3);
    expect(parsed.failures[0].file).toBe("/project/a.js");
    expect(parsed.failures[0].line).toBe(2);
    expect(parsed.failures[0].message).toContain("no-unused-vars");
  });
});

describe("vitestDetector: Tests-line shapes, segment-wise", () => {
  it("an all-failing run (`Tests  N failed (N)`, no `passed` segment): summary.failed is the count", () => {
    expect(
      vitestDetector.matches({
        output: readCaptured("vitest-all-failed"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
    const parsed = vitestDetector.parse({
      output: readCaptured("vitest-all-failed"),
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 2,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(2);
  });

  it("a four-segment run (`failed | passed | skipped | todo`): every count populated, skipped and todo folded into summary.skipped", () => {
    const parsed = vitestDetector.parse({
      output: readCaptured("vitest-mixed-shapes"),
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 1,
      skipped: 2,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(1);
  });

  it("an all-skipped run (`Tests  N skipped (N)`) still selects vitest, with summary.skipped populated and no failures", () => {
    expect(
      vitestDetector.matches({
        output: readCaptured("vitest-all-skipped"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
    const parsed = vitestDetector.parse({
      output: readCaptured("vitest-all-skipped"),
      command: "npm run test --silent",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 2,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
  });

  it("through verify(): an all-skipped Tests line selects the vitest detector, not generic", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "run-vitest" });
    const logDir = makeTmpDir();
    const output = readCaptured("vitest-all-skipped");
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 0, stdoutTail: output },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    expect(result.checks[0].detector).toBe("vitest");
  });

  it("a Tests line with no `failed` segment but parsed FAIL blocks falls back to failures.length (synthetic: this shape is not producible by a real vitest run, only exercised to cover the fallback)", () => {
    const output = [
      " FAIL  sample.test.js > sample > is wrong",
      "AssertionError: expected 2 to be 3",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 passed (1)",
    ].join("\n");
    const parsed = vitestDetector.parse({
      output,
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.summary.failed).toBe(1);
  });

  it("colorized (ANSI SGR) output does not break the Tests-line or FAIL-line regexes", () => {
    const colorized = [
      "\x1b[1m RUN \x1b[22m v4.1.11 /project",
      "",
      " \x1b[31mFAIL\x1b[39m  sample.test.js > sample > is wrong",
      "AssertionError: expected 2 to be 3",
      "",
      " Test Files  1 failed (1)",
      "      Tests  \x1b[31m1 failed\x1b[39m | \x1b[32m1 passed\x1b[39m (2)",
    ].join("\n");
    expect(
      vitestDetector.matches({ output: colorized, command: "", exitCode: 1 }),
    ).toBe(true);
    const parsed = vitestDetector.parse({
      output: colorized,
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.failures).toHaveLength(1);
  });
});

describe("vitestDetector: FAIL line structural path capture (not \\S+)", () => {
  it("a test path with a space is captured whole, up to the ` > ` suite separator (structural match, not \\S+)", () => {
    const output = readCaptured("vitest-fail-space-in-path");
    expect(vitestDetector.matches({ output, command: "", exitCode: 1 })).toBe(
      true,
    );
    const parsed = vitestDetector.parse({
      output,
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("my dir/sample test.test.js");
    expect(parsed.failures[0].name).toBe("sample > is wrong");
    expect(parsed.summary.failed).toBe(1);
  });

  it("a test name ending in a bracketed segment is captured whole, never truncated by the collection-error shape's bracket handling", () => {
    const output = readCaptured("vitest-fail-bracket-name");
    expect(vitestDetector.matches({ output, command: "", exitCode: 1 })).toBe(
      true,
    );
    const parsed = vitestDetector.parse({
      output,
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("sample.test.js");
    expect(parsed.failures[0].name).toBe("parses row [1,2,3]");
    expect(parsed.summary.failed).toBe(1);
  });
});

describe("vitestDetector: `expected fail` (an it.fails run)", () => {
  it("folds the `expected fail` segment into summary.passed, and still selects vitest (not generic)", () => {
    const output = readCaptured("vitest-expected-fail");
    expect(vitestDetector.matches({ output, command: "", exitCode: 0 })).toBe(
      true,
    );
    const parsed = vitestDetector.parse({
      output,
      command: "npm run test --silent",
      exitCode: 0,
    });
    // "Tests  1 passed | 1 expected fail (2)": both segments are passes
    // from a caller's point of view, so summary.passed is 2, not 1.
    expect(parsed.summary).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
  });

  it("through verify(): an it.fails run selects the vitest detector, not generic", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "run-vitest" });
    const logDir = makeTmpDir();
    const output = readCaptured("vitest-expected-fail");
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 0, stdoutTail: output },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    expect(result.checks[0].detector).toBe("vitest");
  });

  it("an all-`expected fail` run (`Tests  1 expected fail (1)`, no `passed`/`failed` segment at all) still selects vitest and folds into summary.passed -- unlike the mixed fixture above, no other segment is present to select the detector on its own, so this discriminates the `expected fail` alternative in SUMMARY_LINE itself", () => {
    const output = readCaptured("vitest-all-expected-fail");
    expect(vitestDetector.matches({ output, command: "", exitCode: 0 })).toBe(
      true,
    );
    const parsed = vitestDetector.parse({
      output,
      command: "npm run test --silent",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
  });
});

describe("vitestDetector: collection error (a file that fails to collect, e.g. a broken import)", () => {
  it("matches the `Tests  no tests` / ` FAIL  file [ file ]` shape (no suite, no name)", () => {
    const output = readCaptured("vitest-collection-error");
    expect(vitestDetector.matches({ output, command: "", exitCode: 1 })).toBe(
      true,
    );
    const parsed = vitestDetector.parse({
      output,
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("broken.test.js");
    expect(parsed.failures[0].name).toBeUndefined();
    // "Tests  no tests" carries no segment at all; the detector reports
    // passed/failed/skipped at 0 here, same as the "no test files" case,
    // and relies on the parsed FAIL block (not the missing Tests line)
    // for the failure it did find.
    expect(parsed.summary.passed).toBe(0);
    expect(parsed.summary.skipped).toBe(0);
  });

  it("through verify(): a collection-error run still selects vitest, not generic, and the failures invariant does not override the one real parsed failure", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "run-vitest" });
    const logDir = makeTmpDir();
    const output = readCaptured("vitest-collection-error");
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 1, stdoutTail: output },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    expect(result.checks[0].detector).toBe("vitest");
    expect(result.checks[0].failures).toHaveLength(1);
    expect(result.checks[0].failures[0].file).toBe("broken.test.js");
  });
});

describe("tscDetector: bare `tsc --noEmit` (no --pretty false)", () => {
  it("parses identically to the --pretty false capture: a bare invocation, run non-interactively (no TTY), emits the same non-pretty diagnostic shape", () => {
    const output = readCaptured("tsc-errors-bare");
    expect(tscDetector.matches({ output, command: "", exitCode: 2 })).toBe(
      true,
    );
    const parsed = tscDetector.parse({
      output,
      command: "npm run typecheck --silent",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.summary.errors).toBe(1);
    expect(parsed.failures[0].file).toBe("a.ts");
    expect(parsed.failures[0].line).toBe(5);
    expect(parsed.failures[0].message).toContain("TS2322");
  });
});

describe("tscDetector: a path with a space (structural file capture, not \\S+)", () => {
  it("captures the whole relative path up to the diagnostic's own `(line,col):` separator, space included", () => {
    const output = readCaptured("tsc-space-in-path");
    expect(tscDetector.matches({ output, command: "", exitCode: 2 })).toBe(
      true,
    );
    const parsed = tscDetector.parse({
      output,
      command: "npm run typecheck --silent",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("my dir/a.ts");
    expect(parsed.failures[0].line).toBe(5);
    expect(parsed.failures[0].message).toContain("TS2322");
  });
});

describe("eslintDetector: blank-line reset (synthetic)", () => {
  it("synthetic: a blank line resets currentFile, so an issue row that follows one with no recognized header in between gets file: undefined (not silently inherited from the previous file) -- this shape is not producible by the real stylish formatter (every issue row is always preceded by a header), only exercised to cover the reset", () => {
    const output = [
      "/project/a.js",
      "  1:1  error  message one  rule-a",
      "",
      "  2:2  error  message two  rule-b",
    ].join("\n");
    const parsed = eslintDetector.parse({
      output,
      command: "npm run lint --silent",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0].file).toBe("/project/a.js");
    expect(parsed.failures[1].file).toBeUndefined();
  });
});

describe("phpunitDetector: precededByFrame reset (synthetic)", () => {
  // Neither shape below is producible by PHPUnit 9.6's real reporter,
  // which prints an uncaught exception's frames back to back and puts a
  // `Caused by` block after them (see phpunit-chained-exception.txt); they
  // are exercised only to cover each reset of the consecutive-frame gate on
  // its own, the same way the eslint synthetic above covers its reset.
  const header = [
    "PHPUnit 9.6.36 by Sebastian Bergmann and contributors.",
    "",
    "E                                                                   1 / 1 (100%)",
    "",
    "Time: [elided]",
    "",
    "There was 1 error:",
    "",
    "1) SyntheticTest::testFrames",
    "RuntimeException: boom",
    "",
    "src/A.php:4",
    "src/A.php:8",
  ];
  const footer = ["", "ERRORS!", "Tests: 1, Assertions: 0, Errors: 1."];
  const parse = (middle: string[]) =>
    phpunitDetector.parse({
      output: [...header, ...middle, ...footer].join("\n"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });

  it("synthetic: a blank line after a consumed frame ends the consecutive run, so a later locator-shaped line stays in message (pins the reset in the blank-line branch)", () => {
    const parsed = parse(["", "src/B.php:9"]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("src/A.php");
    expect(parsed.failures[0].line).toBe(4);
    expect(parsed.failures[0].message).toBe(
      "RuntimeException: boom src/B.php:9",
    );
  });

  it("synthetic: an ordinary text line after a consumed frame ends the consecutive run, so a later locator-shaped line stays in message (pins the reset on the message path)", () => {
    const parsed = parse(["other text", "src/B.php:9"]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].file).toBe("src/A.php");
    expect(parsed.failures[0].line).toBe(4);
    expect(parsed.failures[0].message).toBe(
      "RuntimeException: boom other text src/B.php:9",
    );
  });
});

describe("verify: truncation is read from exec's own stdoutTruncated/stderrTruncated flags", () => {
  // Every stub tail here carries a trailing newline (the shape real
  // command output almost always has) precisely because that shape is
  // what hid the earlier bug: verify used to recompute truncation itself
  // by counting lines in the tail text, and a trailing newline made a
  // truncated tail always look one line short of its own bound. verify
  // now only ever reads exec's own flags, so what the tail text itself
  // looks like is no longer load-bearing for this decision; these flags
  // are set the same way exec.ts's TailKeeper.wasTruncated() would set
  // them for the stated shape, not left at a value convenient for the
  // test.
  it("stdoutTruncated: false and stderrTruncated: false: no truncation warning", async () => {
    const stdoutTail =
      Array.from({ length: 59 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": {
        exitCode: 2,
        stdoutTail,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      execFn: fn,
    });
    expect(
      result.warnings.some(
        (w) => w.includes("typecheck") && w.includes("truncated"),
      ),
    ).toBe(false);
  });

  it("stdoutTruncated: true: warns naming the check as truncated", async () => {
    const stdoutTail =
      Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": {
        exitCode: 2,
        stdoutTail,
        stdoutTruncated: true,
        stderrTruncated: false,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      execFn: fn,
    });
    expect(
      result.warnings.some(
        (w) => w.includes("typecheck") && w.includes("truncated"),
      ),
    ).toBe(true);
  });

  it("stderrTruncated: true alone (stdout untouched) still warns: either stream truncated is enough", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": {
        exitCode: 2,
        stdoutTail: "line 0\n",
        stderrTail:
          Array.from({ length: 60 }, (_, i) => `err ${i}`).join("\n") + "\n",
        stdoutTruncated: false,
        stderrTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      execFn: fn,
    });
    expect(
      result.warnings.some(
        (w) => w.includes("typecheck") && w.includes("truncated"),
      ),
    ).toBe(true);
  });
});

describe("verify: truncation detection end-to-end through the real execCommand (not a stub)", () => {
  it("a real command printing more than exec's line bound, with a trailing newline, is reported truncated by exec's own flags and by verify's warning", async () => {
    // 90 lines, comfortably past exec.ts's 60-line TAIL_LINES bound, with
    // the trailing newline `echo` always adds: the exact real-tool shape
    // the earlier line-counting heuristic in verify/index.ts could never
    // detect as truncated (see the describe block above). Run twice: once
    // directly through execCommand (the flags themselves), once through
    // verify() with the same command as a check (the warning that a
    // caller actually sees).
    const cmd =
      "i=1; while [ $i -le 90 ]; do echo line-$i; i=$((i+1)); done; exit 1";

    const execLogDir = makeTmpDir();
    const execResult = await execCommand(cmd, { logDir: execLogDir });
    expect(execResult.exitCode).toBe(1);
    expect(execResult.stdoutTruncated).toBe(true);
    expect(execResult.stderrTruncated).toBe(false);

    const cwd = makeTmpDir();
    writePackageJson(cwd, {});
    const verifyLogDir = makeTmpDir();
    const result = await verify({
      cwd,
      logDir: verifyLogDir,
      checks: [],
      overrides: { test: cmd },
    });
    expect(result.checks[0].status).toBe("fail");
    expect(
      result.warnings.some(
        (w) => w.includes("test") && w.includes("truncated"),
      ),
    ).toBe(true);
  }, 20000);
});

describe("tscDetector: colorized (ANSI SGR) output", () => {
  it("parses identically to the plain capture (inline SGR sequences around `error` and the TS code)", () => {
    expect(
      tscDetector.matches({
        output: readCaptured("tsc-errors-colorized"),
        command: "",
        exitCode: 2,
      }),
    ).toBe(true);
    const parsed = tscDetector.parse({
      output: readCaptured("tsc-errors-colorized"),
      command: "npm run typecheck --silent",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(3);
    expect(parsed.summary.errors).toBe(3);
    expect(parsed.failures[0].file).toBe("a.ts");
    expect(parsed.failures[0].line).toBe(5);
    expect(parsed.failures[0].message).toContain("TS2322");
  });
});

describe("verify: tail-bound counts (truncated output tail)", () => {
  it("a >60-line captured tsc fixture, tail-truncated to 60 lines: warns that counts may be undercounted", async () => {
    const full = readCaptured("tsc-errors-many");
    const fullLines = full.split("\n").filter((l) => l.length > 0);
    expect(fullLines.length).toBeGreaterThan(60);
    // Mirrors exec.ts's own TailKeeper.tail(): keep only the last 60
    // lines, simulating what a real captured tail would have delivered.
    const truncatedTail = fullLines.slice(-60).join("\n");

    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": {
        exitCode: 2,
        stdoutTail: truncatedTail,
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    const check = result.checks[0];
    expect(check.detector).toBe("tsc");
    expect(check.summary.errors).toBe(60);
    expect(
      result.warnings.some(
        (w) => w.includes("typecheck") && w.includes("truncated"),
      ),
    ).toBe(true);
  });

  it("a truncated eslint tail whose own totals line survives: the tool's own total wins over the tail-counted rows", async () => {
    // Pads the captured errors fixture with filler lines ahead of the
    // real content, past exec.ts's 60-line tail bound, so the earliest
    // issue rows are exactly what a real truncation would have cut,
    // while the summary line (the very end of the output) survives.
    const filler = Array.from({ length: 65 }, (_, i) => `// filler ${i}`);
    const real = readCaptured("eslint-errors").split("\n");
    const stdoutTail = [...filler, ...real].join("\n");
    expect(stdoutTail.split("\n").length).toBeGreaterThan(60);

    const cwd = makeTmpDir();
    writePackageJson(cwd, { lint: "run-eslint" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run lint --silent": {
        exitCode: 1,
        stdoutTail,
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["lint"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    const check = result.checks[0];
    expect(check.detector).toBe("eslint");
    // The fixture's own "✖ 3 problems (3 errors, 0 warnings)" line is
    // still present (it is the last line): the tool's own total (3) is
    // used, not a possibly-wrong tail-counted number. A truncation
    // warning is still added, though, since the *failures list* (the
    // individual issue rows) can still be missing entries that fell
    // outside the tail even when the tool's own total is trustworthy.
    expect(check.summary.errors).toBe(3);
    expect(
      result.warnings.some(
        (w) => w.includes("lint") && w.includes("truncated"),
      ),
    ).toBe(true);
  });

  it("a truncated tsc tail that happens to contain an eslint-shaped totals line: the totals-line preference is gated on the eslint detector, so the coincidental line is ignored", async () => {
    // The totals-line preference must not fire just because some text in
    // the tail happens to match eslint's summary shape; it is gated on
    // the detector actually selected for this check being eslint.
    const full = readCaptured("tsc-errors-many");
    const fullLines = full.split("\n").filter((l) => l.length > 0);
    const truncatedTail = [
      ...fullLines.slice(-60),
      "✖ 3 problems (3 errors, 0 warnings)",
    ].join("\n");

    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": {
        exitCode: 2,
        stdoutTail: truncatedTail,
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    const check = result.checks[0];
    expect(check.detector).toBe("tsc");
    // Still the real tsc diagnostic count (60), never overridden to the
    // coincidental eslint-shaped "3" in the tail.
    expect(check.summary.errors).toBe(60);
    expect(
      result.warnings.some(
        (w) => w.includes("typecheck") && w.includes("truncated"),
      ),
    ).toBe(true);
  });

  it('a custom, non-default detector also named "eslint" (a different object from the real eslintDetector) does not get the totals-line preference: gated on detector identity, not the name string', async () => {
    // A detector object that shares eslintDetector's `name` but is a
    // distinct object: were the totals-line preference gated on
    // `detector.name === "eslint"` instead of `detector === eslintDetector`,
    // this fake detector's own, already-correct summary would be
    // silently overwritten by a coincidentally eslint-shaped totals line
    // in the tail that belongs to a different tool entirely.
    const fakeEslintNamedDetector: Detector = {
      name: "eslint",
      matches: () => true,
      parse: () => ({
        summary: { passed: 0, failed: 0, skipped: 0, errors: 5, warnings: 0 },
        failures: Array.from({ length: 5 }, (_, i) => ({
          message: `fake failure ${i}`,
        })),
        warnings: [],
      }),
    };
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-fake" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": {
        exitCode: 1,
        stdoutTail: "✖ 1 problem (1 error, 0 warnings)",
        stdoutTruncated: true,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      execFn: fn,
      detectors: [fakeEslintNamedDetector],
    });
    const check = result.checks[0];
    expect(check.detector).toBe("eslint");
    // The fake detector's own count (5), never the coincidental
    // eslint-shaped totals line's "1".
    expect(check.summary.errors).toBe(5);
  });
});

describe("verify: detector shapes are disjoint under real DEFAULT_DETECTORS ordering", () => {
  it("a check whose output concatenates tsc and vitest shapes falls back to generic, naming both candidates", () => {
    const output = readCaptured("tsc-vitest-concat");
    const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
      output,
      // A command name that is not a whole token of "tsc" or "vitest": the
      // tiebreaker must not fire, so the ambiguity is what is exercised
      // here, not the tiebreaker.
      command: "npm run ci --silent",
      exitCode: 1,
    });
    expect(selection.detector).toBe(genericDetector);
    expect(selection.ambiguousCandidates).toEqual(
      expect.arrayContaining(["tsc", "vitest"]),
    );
    expect(selection.ambiguousCandidates).not.toContain("eslint");
  });

  it("through verify(): the same concatenated output selects generic and warns listing tsc and vitest", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { ci: "run-both" });
    const logDir = makeTmpDir();
    const output = readCaptured("tsc-vitest-concat");
    const { fn } = makeStubExec({
      "npm run ci --silent": { exitCode: 1, stdoutTail: output },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["ci"],
      execFn: fn,
      detectors: DEFAULT_DETECTORS,
    });
    expect(result.checks[0].detector).toBe("generic");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("ambiguous") && w.includes("tsc") && w.includes("vitest"),
      ),
    ).toBe(true);
  });
});

describe("verify: detector selection precedence, output shape first, real tools", () => {
  it("-c typecheck resolved to `npm run typecheck --silent` against the tsc fixture selects tsc", async () => {
    const cwd = path.join(FIXTURES_DIR, "tsc-project");
    const logDir = makeTmpDir();
    const result = await verify({
      cwd,
      logDir,
      checks: ["typecheck"],
      detectors: DEFAULT_DETECTORS,
    });
    expect(result.checks[0].command).toBe("npm run typecheck --silent");
    expect(result.checks[0].detector).toBe("tsc");
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].summary.errors).toBeGreaterThan(0);
  }, 20000);

  it("-c test resolved to `npm run test --silent` against the vitest fixture selects vitest", async () => {
    // A dedicated copy of the vitest fixture (not test/fixtures/vitest-
    // project, which cli.test.ts's live integration test also spawns
    // `vitest run` against): vitest writes a transform cache to
    // node_modules/.vite under its cwd, and two vitest processes racing
    // on the very same cache path (this test file and cli.test.ts run as
    // separate, concurrent vitest test files) intermittently made vitest
    // itself error, which made its output stop matching the vitest
    // detector's shape and fall through to generic. tsc and eslint carry
    // no such cache and are shared safely across the two fixtures they
    // both use.
    const cwd = path.join(FIXTURES_DIR, "vitest-project-select");
    const logDir = makeTmpDir();
    // try/finally, not an in-body cleanup at the end of the test: an
    // assertion failure above would otherwise skip the rmSync and leave
    // the transform cache node_modules/.vite behind under this fixture,
    // which ships no node_modules of its own (see test/fixtures/.gitignore).
    try {
      const result = await verify({
        cwd,
        logDir,
        checks: ["test"],
        detectors: DEFAULT_DETECTORS,
      });
      expect(result.checks[0].command).toBe("npm run test --silent");
      expect(result.checks[0].detector).toBe("vitest");
      expect(result.checks[0].status).toBe("fail");
      expect(result.checks[0].failures.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(path.join(cwd, "node_modules"), {
        recursive: true,
        force: true,
      });
    }
  }, 20000);
});

describe("phpunitDetector: captured real output", () => {
  it("matches a green run, a red run, and the no-tests-executed case", () => {
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-pass"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-fail"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-no-tests-executed"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
  });

  it("matches a run with both a real failure and a real skip (round-1 review fixture: caught mutant misread as no_tests_executed)", () => {
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-skip-and-fail"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
  });

  it("matches an all-skipped run with no FAILURES!/ERRORS! marker at all (round-1 review fixture)", () => {
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-all-skipped"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
  });

  it("matches an ERRORS! run (errors and failures together; round-1 review fixture)", () => {
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-errors-and-failures"),
        command: "",
        exitCode: 2,
      }),
    ).toBe(true);
  });

  it("matches a WARNINGS! run (measured exit 0, not 2: a PHPUnit-level warning does not fail the run)", () => {
    expect(
      phpunitDetector.matches({
        output: readCaptured("phpunit-warnings"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
  });

  it("matches the risky captures and an errors-plus-skipped run (round-3 redesign fixtures)", () => {
    for (const name of [
      "phpunit-risky-and-real",
      "phpunit-risky-only",
      "phpunit-errors-and-skipped",
    ]) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: name === "phpunit-errors-and-skipped" ? 2 : 0,
        }),
      ).toBe(true);
    }
  });

  it("matches a port-suffixed error message and a plural-header (2 failures, 2 risky) run", () => {
    for (const [name, exitCode] of [
      ["phpunit-error-message-with-port", 2],
      ["phpunit-two-failures-and-risky", 1],
    ] as const) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode,
        }),
      ).toBe(true);
    }
  });

  it("matches a diff-with-blank-row, a nested-throw-frames, a message-reset, an indented-message-line, a raw-blank-check, and a chained-exception run", () => {
    for (const [name, exitCode] of [
      ["phpunit-diff-indented-locator", 1],
      ["phpunit-nested-throw-frames", 2],
      ["phpunit-message-reset", 2],
      ["phpunit-indented-message-line", 2],
      ["phpunit-raw-blank-check", 2],
      ["phpunit-chained-exception", 2],
    ] as const) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode,
        }),
      ).toBe(true);
    }
  });

  it("does not match vitest, tsc, or eslint captured output (shape disjointness)", () => {
    for (const name of [
      "vitest-fail",
      "vitest-pass",
      "vitest-no-tests",
      "tsc-errors",
      "tsc-clean",
      "eslint-errors",
      "eslint-warnings",
      "eslint-clean",
    ]) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: name.includes("clean") ? 0 : 1,
        }),
      ).toBe(false);
    }
  });

  it("vitest, tsc, and eslint detectors do not match phpunit captured output (pin: PHP detectors never shadow the JS ones)", () => {
    for (const name of [
      "phpunit-pass",
      "phpunit-fail",
      "phpunit-no-tests-executed",
      "phpunit-deprecation-notice",
      "phpunit-skip-and-fail",
      "phpunit-all-skipped",
      "phpunit-errors-and-failures",
      "phpunit-warnings",
      "phpunit-risky-and-real",
      "phpunit-risky-only",
      "phpunit-errors-and-skipped",
      "phpunit-error-message-with-port",
      "phpunit-two-failures-and-risky",
      "phpunit-diff-indented-locator",
      "phpunit-nested-throw-frames",
      "phpunit-message-reset",
      "phpunit-indented-message-line",
      "phpunit-raw-blank-check",
      "phpunit-chained-exception",
    ]) {
      const output = readCaptured(name);
      expect(vitestDetector.matches({ output, command: "", exitCode: 0 })).toBe(
        false,
      );
      expect(tscDetector.matches({ output, command: "", exitCode: 0 })).toBe(
        false,
      );
      expect(eslintDetector.matches({ output, command: "", exitCode: 0 })).toBe(
        false,
      );
    }
  });

  it("selectDetector against DEFAULT_DETECTORS: a real vitest fixture still selects vitest, not phpunit (shape-first selection is not order-dependent)", () => {
    const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
      output: readCaptured("vitest-pass"),
      command: "npm run test --silent",
      exitCode: 0,
    });
    expect(selection.detector.name).toBe("vitest");
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("selectDetector against DEFAULT_DETECTORS: a real phpunit fixture selects phpunit", () => {
    const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
      output: readCaptured("phpunit-fail"),
      command: "vendor/bin/phpunit",
      exitCode: 1,
    });
    expect(selection.detector.name).toBe("phpunit");
  });

  it("parses a green run: 0 failures, summary passed equals the total", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-pass"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it("parses a red run: one failure with class::method name, message, and file:line", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-fail"),
      command: "vendor/bin/phpunit",
      exitCode: 1,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 1,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("CalcFailTest::testAddWrong");
    expect(parsed.failures[0].file).toBe("tests/CalcFailTest.php");
    expect(parsed.failures[0].line).toBe(11);
    expect(parsed.failures[0].message).toContain(
      "Failed asserting that 4 is identical to 5.",
    );
  });

  it("parses the no-tests-executed case: no false passed/failed claim, no failures", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-no-tests-executed"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it("surfaces a PHP-level deprecation notice on an otherwise green run as a detector warning, not a failure", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-deprecation-notice"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.summary.failed).toBe(0);
    expect(
      parsed.warnings.some(
        (w) =>
          w.includes("phpunit_deprecation") && w.includes("dynamic property"),
      ),
    ).toBe(true);
  });

  it("parses a run with a real failure AND a real skip: failed/skipped both correctly counted, not zeroed out (round-1 review fixture)", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-skip-and-fail"),
      command: "vendor/bin/phpunit",
      exitCode: 1,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("SkipFailTest::testFail");
  });

  it("parses an all-skipped run: no false pass, skipped counted, no failures (round-1 review fixture)", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-all-skipped"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 2,
      errors: 0,
      warnings: 0,
    });
  });

  it("parses an ERRORS! run: errors and failures both counted (PHPUnit prints Errors: before Failures:), skipped folds in Incomplete too", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-errors-and-failures"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.summary.errors).toBe(1);
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.summary.skipped).toBe(2); // 1 Skipped + 1 Incomplete
    expect(parsed.summary.passed).toBe(2); // 6 total - 1 skipped - 1 incomplete - 1 failed - 1 error
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures.map((f) => f.name)).toEqual([
      "ErrFailTest::testError",
      "ErrFailTest::testFail",
    ]);
    // Exact, not `toContain`: the entry-body terminator rule is what
    // keeps the `--` divider PHPUnit prints between the error and the
    // failure section (and the `There was 1 failure:` header after it)
    // out of the first entry's message (round-2 review finding).
    expect(parsed.failures[0].message).toBe("RuntimeException: boom");
    expect(parsed.failures[0].file).toBe("tests/ErrFailTest.php");
    expect(parsed.failures[0].line).toBe(26);
    expect(parsed.failures[1].message).toBe(
      "Failed asserting that 4 is identical to 5.",
    );
    // The failures invariant this fixture exercises: every numbered
    // entry `parse()` extracted is accounted for by errors+failed
    // together (summary.failed alone undercounts here, since PHPUnit's
    // own `Failures:` count excludes its `Errors:` count).
    expect(
      parsed.summary.failed + parsed.summary.errors,
    ).toBeGreaterThanOrEqual(parsed.failures.length);
  });

  it("parses a WARNINGS! run: nothing executed, so no false passed count (round-2 review finding: this shape exits 0 and was read as a green passed: 1)", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-warnings"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 1,
    });
    expect(parsed.failures).toEqual([]);
  });

  it("parses a risky-plus-real run: the risky test COUNTS as executed (passed 2, skipped 0), and its numbered entry is not a failure", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-risky-and-real"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    // `Tests: 2, Assertions: 1, Risky: 1.`: both tests ran, neither
    // failed, so both land in `passed`. Reading Risky as not-executed
    // instead would report `passed: 1` here and, on the risky-only
    // capture below, "no tests executed".
    expect(parsed.summary).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    // The capture's own `1) RiskyRealTest::testNoAssertions` entry sits
    // under `There was 1 risky test:`, not under an error/failure
    // section (round-2 review finding: it was landing in `failures`).
    expect(parsed.failures).toEqual([]);
  });

  it("parses a risky-only run: executed 1, still no failure and no skip", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-risky-only"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
  });

  it("parses an errors-plus-skipped run with no failures at all: the error is counted as an error, not as a failure", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-errors-and-skipped"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    // `Tests: 3, Assertions: 1, Errors: 1, Skipped: 1.`: 3 - 1 skipped
    // = 2 executed, less 1 error = 1 passed.
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 1,
      errors: 1,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("ErrSkipTest::testError");
    expect(parsed.failures[0].message).toBe("RuntimeException: boom");
  });

  it("parses an error message ending in ':<digits>': the port suffix is never mistaken for the file:line locator", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-error-message-with-port"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("PortTest::testUnreachable");
    // The message ends in `:8080`, structurally identical to a
    // `file:line` locator, but sits on the entry's own first line (never
    // preceded by a blank line), so it is read as the message, not the
    // locator.
    expect(parsed.failures[0].message).toBe(
      "RuntimeException: upstream unreachable at api.example.com:8080",
    );
    // The real locator, two lines below and preceded by a blank line,
    // is still captured correctly.
    expect(parsed.failures[0].file).toBe("tests/PortTest.php");
    expect(parsed.failures[0].line).toBe(14);
  });

  it("parses a plural-header run (2 failures, 2 risky tests): failed 2, passed 2, both risky entries excluded from failures", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-two-failures-and-risky"),
      command: "vendor/bin/phpunit",
      exitCode: 1,
    });
    // `Tests: 4, Assertions: 2, Failures: 2, Risky: 2.`: 4 total, 2
    // failed, the 2 risky tests ran and did not fail, so they land in
    // `passed`.
    expect(parsed.summary).toEqual({
      passed: 2,
      failed: 2,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures.map((f) => f.name)).toEqual([
      "PluralTest::testFailOne",
      "PluralTest::testFailTwo",
    ]);
    // The plural `There were 2 risky tests:` header is recognized
    // (`DEFECT_SECTION_HEADER`'s `s?`), so neither
    // `PluralTest::testRiskyOne` nor `PluralTest::testRiskyTwo` lands in
    // `failures`, even though the `--` divider separates them from the
    // failure section above.
    expect(parsed.failures.some((f) => f.name?.includes("Risky"))).toBe(false);
  });

  it("parses a diff message with a blank context row and an indented locator-shaped row: the real locator is still found, not the diff row", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-diff-indented-locator"),
      command: "vendor/bin/phpunit",
      exitCode: 1,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("DiffTest::testConfigDiff");
    // The diff's blank context row is a single space, not a zero-length
    // line; its indented ` port:12` row right below it is structurally
    // identical to a locator once trimmed, but `ENTRY_FILE_LINE`'s `\S`
    // anchor (not the blank check) is what actually keeps it from being
    // matched, since it is still indented on the raw line, so it is
    // folded into the message like any other diff row. This fixture
    // does not by itself discriminate a raw-length blank check from a
    // trim-based one, since the entry loop never reaches this row
    // looking for a locator either way (see
    // `phpunit-raw-blank-check.txt` / the "raw-line blank check" test
    // below for the fixture that does).
    expect(parsed.failures[0].message).toBe(
      "Failed asserting that two strings are identical. --- Expected +++ Actual @@ @@ 'first port:12 -second' +third'",
    );
    // The real locator, on its own unindented line two lines below and
    // preceded by a genuinely blank line, is still captured correctly.
    expect(parsed.failures[0].file).toBe("tests/DiffTest.php");
    expect(parsed.failures[0].line).toBe(11);
  });

  it("parses a multi-frame uncaught-exception trace: only the innermost (throw-site) frame becomes file/line, the rest are dropped from message", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-nested-throw-frames"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("NestedThrowTest::testThrows");
    // Three consecutive `file:line` lines follow the message with no
    // blank line between them (the throw site, its caller, and the test
    // method); only the first becomes file/line.
    expect(parsed.failures[0].file).toBe("src/Thrower.php");
    expect(parsed.failures[0].line).toBe(5);
    // The other two frames are consumed, not folded into the message.
    expect(parsed.failures[0].message).toBe("RuntimeException: boom");
  });

  it("parses a message that itself embeds a blank line then a locator-shaped line: precededByBlank resets after the ordinary message line in between, so the real locator is still found", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-message-reset"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe(
      "MessageResetTest::testBlankThenColonDigitText",
    );
    // "abc:99" follows the message's own embedded blank line, but is
    // itself preceded by an ordinary ("Body line") message line, not
    // directly by the blank line, so it is not mistaken for the locator.
    expect(parsed.failures[0].message).toBe(
      "RuntimeException: Header Body line abc:99",
    );
    // The real locator, preceded by a genuine blank line further down,
    // is still captured correctly.
    expect(parsed.failures[0].file).toBe("tests/MessageResetTest.php");
    expect(parsed.failures[0].line).toBe(9);
  });

  it("parses a message with a genuinely blank line followed by an INDENTED locator-shaped line: the indented line is never matched, even preceded by a real blank line", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-indented-message-line"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe(
      "IndentedMessageTest::testIndentedLine",
    );
    // "  file:42" is preceded by a genuinely blank (zero-length) line,
    // not merely a diff-shaped single-space one, isolating the locator
    // regex's own raw-vs-trimmed behavior from the blank-line check: it
    // is still never read as the locator, because `ENTRY_FILE_LINE`
    // requires a non-whitespace first character on the RAW line.
    expect(parsed.failures[0].message).toBe(
      "RuntimeException: Header file:42 Trailer",
    );
    expect(parsed.failures[0].file).toBe("tests/IndentedMessageTest.php");
    expect(parsed.failures[0].line).toBe(9);
  });

  it("parses a message with a genuinely one-space line (not zero-length) followed by an UNINDENTED locator-shaped line: the raw-line blank check, not the anchor, keeps it out", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-raw-blank-check"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe(
      "RawBlankCheckTest::testSingleSpaceLineThenLocator",
    );
    // "abc:99" is unindented, so `ENTRY_FILE_LINE`'s `\S` anchor would
    // happily match it; only the entry loop's blank check testing the
    // RAW line's length (not its trimmed length) keeps the one-space
    // line above it from being misread as blank, so "abc:99" is never
    // mistaken for the locator and is folded into the message instead.
    expect(parsed.failures[0].message).toBe("RuntimeException: Header abc:99");
    // The real locator, preceded by a genuinely blank line further
    // down, is still captured correctly.
    expect(parsed.failures[0].file).toBe("tests/RawBlankCheckTest.php");
    expect(parsed.failures[0].line).toBe(9);
  });

  it("parses a chained exception's PHPUnit 9.6 'Caused by' block: only the first exception's frame becomes file/line, the block's own message and locator are folded into message (not consumed as a consecutive frame)", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-chained-exception"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe(
      "ChainedThrowTest::testChainedException",
    );
    expect(parsed.failures[0].file).toBe("tests/ChainedThrowTest.php");
    expect(parsed.failures[0].line).toBe(9);
    // The `Caused by` block's own message line and locator line are
    // both separated from the first exception's captured frame by a
    // blank line (and, for the message line, the `Caused by` line
    // itself), so neither is CONSECUTIVE with it: the extra-frame
    // branch does not consume them, and both are folded into `message`
    // as ordinary text instead of being silently dropped.
    expect(parsed.failures[0].message).toBe(
      "RuntimeException: outer Caused by LogicException: inner:42 tests/ChainedThrowTest.php:9",
    );
  });

  it("failures invariant: summary.failed + summary.errors is never less than the parsed failures list, across every red/error fixture", () => {
    for (const [name, exitCode] of [
      ["phpunit-fail", 1],
      ["phpunit-skip-and-fail", 1],
      ["phpunit-errors-and-failures", 2],
      ["phpunit-errors-and-skipped", 2],
      ["phpunit-error-message-with-port", 2],
      ["phpunit-two-failures-and-risky", 1],
      ["phpunit-diff-indented-locator", 1],
      ["phpunit-nested-throw-frames", 2],
      ["phpunit-message-reset", 2],
      ["phpunit-indented-message-line", 2],
      ["phpunit-raw-blank-check", 2],
      ["phpunit-chained-exception", 2],
    ] as const) {
      const parsed = phpunitDetector.parse({
        output: readCaptured(name),
        command: "vendor/bin/phpunit",
        exitCode,
      });
      expect(
        parsed.summary.failed + parsed.summary.errors,
      ).toBeGreaterThanOrEqual(parsed.failures.length);
    }
  });

  // --- The summary invariant, over EVERY captured phpunit fixture.
  // The expected side is derived here from the fixture's own text (the
  // stated total, and the named counts of the categories the detector's
  // table calls not-executed), independently of the detector's own
  // derivation, so this test pins the rule rather than restating the
  // implementation: a category moved across the executed/not-executed
  // line in `TALLY_CATEGORIES` breaks it.
  const PHPUNIT_FIXTURES = [
    "phpunit-pass",
    "phpunit-fail",
    "phpunit-no-tests-executed",
    "phpunit-deprecation-notice",
    "phpunit-skip-and-fail",
    "phpunit-all-skipped",
    "phpunit-errors-and-failures",
    "phpunit-warnings",
    "phpunit-risky-and-real",
    "phpunit-risky-only",
    "phpunit-errors-and-skipped",
    "phpunit-error-message-with-port",
    "phpunit-two-failures-and-risky",
    "phpunit-diff-indented-locator",
    "phpunit-nested-throw-frames",
    "phpunit-message-reset",
    "phpunit-indented-message-line",
    "phpunit-raw-blank-check",
    "phpunit-chained-exception",
  ] as const;

  /** The run's own stated total: the tally line's `Tests: N`, or a green
   * run's `OK (N tests`, or 0 when neither line is present. */
  function statedTotal(output: string): number {
    const tally = /^Tests: (\d+), Assertions: \d+/m.exec(output);
    if (tally) return Number(tally[1]);
    const ok = /^OK \((\d+) tests?, /m.exec(output);
    if (ok) return Number(ok[1]);
    return 0;
  }

  /** The stated count of every category the detector treats as NOT
   * executed: Skipped, Incomplete and Warnings. */
  function statedNotExecuted(output: string): number {
    let sum = 0;
    for (const name of ["Skipped", "Incomplete", "Warnings"]) {
      const match = new RegExp(`, ${name}: (\\d+)`).exec(output);
      if (match) sum += Number(match[1]);
    }
    return sum;
  }

  it("summary invariant across every captured phpunit fixture: the parts exactly account for the stated total, and passed + failed + errors equals the executed count", () => {
    for (const name of PHPUNIT_FIXTURES) {
      const output = readCaptured(name);
      const parsed = phpunitDetector.parse({
        output,
        command: "vendor/bin/phpunit",
        exitCode: 0,
      });
      const total = statedTotal(output);
      const { passed, failed, errors, skipped, warnings } = parsed.summary;
      // Compared as an object carrying the fixture name, so a failure
      // says WHICH capture broke the invariant. Equality, not `<=`: a
      // mutant that silently drops part of the budget (spends it out of
      // `remaining` without ever crediting a `summary` field) still
      // satisfies `<=` but not `===`.
      expect({
        name,
        accountsForStatedTotal:
          passed + failed + errors + skipped + warnings === total,
      }).toEqual({ name, accountsForStatedTotal: true });
      expect({ name, executed: passed + failed + errors }).toEqual({
        name,
        executed: total - statedNotExecuted(output),
      });
      expect(passed).toBeGreaterThanOrEqual(0);
    }
  });

  it("summary invariant holds for a self-contradictory tally too (hand-written, NOT a capture: no real PHPUnit run prints one)", () => {
    const parsed = phpunitDetector.parse({
      output: "FAILURES!\nTests: 2, Assertions: 0, Failures: 3, Skipped: 5.\n",
      command: "vendor/bin/phpunit",
      exitCode: 1,
    });
    const { passed, failed, errors, skipped, warnings } = parsed.summary;
    expect(passed + failed + errors + skipped + warnings).toBeLessThanOrEqual(
      2,
    );
    expect(passed).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(skipped).toBeGreaterThanOrEqual(0);
  });
});

describe("phpunitDetector: PHPUnit 11 residuals (tracker 3a0c5242)", () => {
  it("matches the PHPUnit-error, two-word-deprecation-tally, and exit-mid-suite captures", () => {
    for (const [name, exitCode] of [
      ["phpunit-error-data-provider", 2],
      ["phpunit-two-word-deprecation-tally", 0],
      ["phpunit-exit-mid-suite", 0],
    ] as const) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode,
        }),
      ).toBe(true);
    }
  });

  it("vitest, tsc, and eslint detectors do not match the three new PHPUnit-11 captures (disjointness)", () => {
    for (const name of [
      "phpunit-error-data-provider",
      "phpunit-two-word-deprecation-tally",
      "phpunit-exit-mid-suite",
    ]) {
      const output = readCaptured(name);
      expect(vitestDetector.matches({ output, command: "", exitCode: 0 })).toBe(
        false,
      );
      expect(tscDetector.matches({ output, command: "", exitCode: 0 })).toBe(
        false,
      );
      expect(eslintDetector.matches({ output, command: "", exitCode: 0 })).toBe(
        false,
      );
    }
  });

  it("the exit-mid-suite capture does not make phpunit shadow vitest/tsc/eslint captured output (the banner check is phpunit-only)", () => {
    for (const name of [
      "vitest-fail",
      "vitest-pass",
      "vitest-no-tests",
      "tsc-errors",
      "tsc-clean",
      "eslint-errors",
      "eslint-warnings",
      "eslint-clean",
    ]) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: name.includes("clean") ? 0 : 1,
        }),
      ).toBe(false);
    }
  });

  it("selectDetector against DEFAULT_DETECTORS: the exit-mid-suite capture selects phpunit, not generic", () => {
    const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
      output: readCaptured("phpunit-exit-mid-suite"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(selection.detector.name).toBe("phpunit");
  });

  it("parses the PHPUnit-error capture: the invalid-data-provider entry becomes a failures entry, counted in summary.errors", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-error-data-provider"),
      command: "vendor/bin/phpunit",
      exitCode: 2,
    });
    expect(parsed.summary.errors).toBe(1);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe(
      "DataProviderThrowsTest::testSomething",
    );
    expect(parsed.failures[0].file).toBe("tests/DataProviderThrowsTest.php");
    expect(parsed.failures[0].line).toBe(20);
    expect(parsed.failures[0].message).toContain(
      "The data provider specified for DataProviderThrowsTest::testSomething is invalid",
    );
    // The failures invariant still holds for this PHPUnit-11-only
    // section kind, same as it does for an ordinary `error` section.
    expect(
      parsed.summary.failed + parsed.summary.errors,
    ).toBeGreaterThanOrEqual(parsed.failures.length);
  });

  it("parses the two-word-deprecation-tally capture: both genuinely-run tests still count as passed, the PHPUnit Deprecations token is not mistaken for a not-executed category", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-two-word-deprecation-tally"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
  });

  it("the two-word-deprecation-tally capture is NOT read as zero tests executed (a real pass, not a hollow one)", () => {
    expect(zeroTests(readCaptured("phpunit-two-word-deprecation-tally"))).toBe(
      "not_zero",
    );
  });

  it("the exit-mid-suite capture parses to an all-zero summary with no failures (same graceful convention as No tests executed!)", () => {
    const parsed = phpunitDetector.parse({
      output: readCaptured("phpunit-exit-mid-suite"),
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
  });

  it("the exit-mid-suite capture reads as AMBIGUOUS, never as zero: its own single progress dot is one test that ran and passed before the kill", () => {
    const output = readCaptured("phpunit-exit-mid-suite");
    // The capture's own bytes: PHPUnit's banner, its `Runtime:` line,
    // and exactly one `.` -- `testFirst` genuinely ran and passed
    // before `testExits` killed the PHP process (see
    // test/fixtures/README.md). A `"zero"` verdict here would be false
    // about this very fixture, not merely unproven, which is why the
    // reading answers this shape with "cannot be read" instead.
    expect(output).toMatch(/\n\.$/);
    expect(zeroTests(output)).toBe("ambiguous");
    const reason = phpunitZeroTestsVerdict(output).reason;
    expect(reason).toContain("neither a result summary");
    expect(reason).toContain("nor a progress counter");
    expect(reason).toContain("Memory: <m>` line");
  });

  it("the 9.6.36 exit-mid-suite capture reads ambiguous too (this reading is not version-specific)", () => {
    // Same three-test class, same `exit(0)` in its second test, run
    // under PHPUnit 9.6.36 instead of 11.5.56: banner, blank line, one
    // dot, exit 0 (9.6 prints no `Runtime:` line at all). The reading
    // turns on absent completion evidence, not on a major version, so
    // both captures land in the same arm.
    const output = readCaptured("phpunit-exit-mid-suite-9");
    expect(output).toContain("PHPUnit 9.6.36 by");
    expect(output).not.toContain("Runtime:");
    expect(zeroTests(output)).toBe("ambiguous");
  });

  it("verify: the exit-mid-suite capture (exit 0) stays status pass and gets zero_tests_ambiguous, NOT the no_tests_executed claim", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-exit-mid-suite"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.detector).toBe("phpunit");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    const ambiguous = result.warnings.filter((w) =>
      w.includes("zero_tests_ambiguous:"),
    );
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toContain("test: zero_tests_ambiguous:");
    expect(ambiguous[0]).toContain("neither a result summary");
    expect(ambiguous[0]).toContain("mid-suite `exit()`/`die()`");
  });
});

/** One PHPUnit 11-shaped green tally tail with NO version banner in it,
 * standing in for a run long enough that `exec.ts`'s tail-keeping
 * truncation (last 60 lines / 6000 chars) dropped PHPUnit's very first
 * line while keeping its very last one. `lines` pads the progress block
 * so the same shape can be built at a realistic length. Every count
 * here is the shape the version question turns on: all 15 tests both ran
 * and raised a PHP-level warning, so PHPUnit 10+ reads this as 15
 * executed and passed while PHPUnit 9 reads the same token as 15
 * synthetic tests that never ran at all. */
function bannerlessGreenPhpunit11Tail(lines = 6): string {
  const progress = Array.from(
    { length: lines },
    (_, i) => `WWWWWWWWWWWWWWW${" ".repeat(20)}${(i + 1) * 15} / 225 (100%)`,
  );
  return [
    ...progress,
    "",
    "Time: 00:00.412, Memory: 10.00 MB",
    "",
    "OK, but there were issues!",
    "Tests: 15, Assertions: 15, Warnings: 15.",
    "",
  ].join("\n");
}

/** One synthetic PHPUnit banner over the plain-`Warnings` tally shape.
 * Synthetic on purpose and labelled as such: this suite has no captured
 * run for PHPUnit 10, nor for any prerelease banner, and the ONLY thing
 * these cases vary is the version string PHPUnit states about itself,
 * which is exactly what the reading turns on. The tally line itself is
 * `phpunit-warnings.txt`'s own captured one. */
function syntheticBanneredWarningsTally(version: string): string {
  return [
    `PHPUnit ${version} by Sebastian Bergmann and contributors.`,
    "",
    "W                                                                   1 / 1 (100%)",
    "",
    "Time: 00:00.031, Memory: 8.00 MB",
    "",
    "OK, but there were issues!",
    "Tests: 1, Assertions: 0, Warnings: 1.",
    "",
  ].join("\n");
}

const PHPUNIT_11_WARNINGS_MOVED_WARNING =
  "phpunit_warnings: PHPUnit 11 reads this run's `Warnings: 1` tally count as 1 test(s) that ran, so it is reported in summary.passed rather than in summary.warnings.";

describe("phpunitDetector: version-aware plain Warnings reading (PHPUnit 10 and up)", () => {
  it("real PHPUnit 11.5.56 capture: a single test that raises E_USER_WARNING is read as executed and passed, not as zero tests executed", () => {
    const output = readCaptured("phpunit-warning-test-executed");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    // passed equals the stated Tests count (1) minus real non-executed
    // categories (none here: no Skipped, no Incomplete).
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(zeroTests(output)).toBe("not_zero");
    // The count does not simply vanish along with `summary.warnings: 0`:
    // the version-aware reading folds it into `passed`, and the detector
    // says so, naming the count.
    expect(parsed.warnings).toEqual([PHPUNIT_11_WARNINGS_MOVED_WARNING]);
  });

  it("real PHPUnit 11.5.56 capture: three tests raising a warning, a deprecation, and a notice all still count as executed and passed", () => {
    const output = readCaptured(
      "phpunit-warnings-deprecations-notices-executed",
    );
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 3,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(zeroTests(output)).toBe("not_zero");
    // One `Warnings: 1` token among the three tests: only that one is
    // version-dependent, so only that one is named (the plain
    // `Deprecations`/`Notices` tokens are spent nowhere on any version).
    expect(parsed.warnings).toEqual([PHPUNIT_11_WARNINGS_MOVED_WARNING]);
  });

  it("verify: the plain-Warnings-executed PHPUnit 11 capture stays status pass, gets NO no_tests_executed warning, and carries the moved count", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-warning-test-executed"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.detector).toBe("phpunit");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
    expect(result.warnings).toContain(
      `test: ${PHPUNIT_11_WARNINGS_MOVED_WARNING}`,
    );
  });

  it("PHPUnit 9.6.36's own phpunit-warnings.txt capture is unaffected: a plain Warnings token still reads as not executed (fail-safe default kept byte-identical)", () => {
    const output = readCaptured("phpunit-warnings");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 1,
    });
    expect(zeroTests(output)).toBe("zero");
    // Nothing to move here: under 9 the count IS `summary.warnings`, so
    // the detector adds no warning about it.
    expect(parsed.warnings).toEqual([]);
  });

  it("a SYNTHETIC PHPUnit 10.5.0 banner over the same plain-Warnings tally reads as executed too (the threshold is major 10, not 11)", () => {
    const output = syntheticBanneredWarningsTally("10.5.0");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(zeroTests(output)).toBe("not_zero");
    expect(parsed.warnings).toEqual([
      "phpunit_warnings: PHPUnit 10 reads this run's `Warnings: 1` tally count as 1 test(s) that ran, so it is reported in summary.passed rather than in summary.warnings.",
    ]);
  });

  it("a SYNTHETIC prerelease banner (PHPUnit 11.0.0-RC1) is read at its own major, not as a banner-less output", () => {
    const output = syntheticBanneredWarningsTally("11.0.0-RC1");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    // A prerelease tail the version pattern does not accept would leave
    // no readable major at all, which is the banner-less case below:
    // `passed: 0` and an `ambiguous` reading instead of these two.
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(zeroTests(output)).toBe("not_zero");
    expect(parsed.warnings).toEqual([PHPUNIT_11_WARNINGS_MOVED_WARNING]);
  });

  it("a SYNTHETIC prerelease banner with a dotted tail (PHPUnit 12.0.0-alpha.1) is read at its own major too", () => {
    const output = syntheticBanneredWarningsTally("12.0.0-alpha.1");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
    expect(zeroTests(output)).toBe("not_zero");
    expect(parsed.warnings).toEqual([
      "phpunit_warnings: PHPUnit 12 reads this run's `Warnings: 1` tally count as 1 test(s) that ran, so it is reported in summary.passed rather than in summary.warnings.",
    ]);
  });

  it("no banner at all (front-truncated output): the zero-tests reading is ambiguous, while the summary keeps the fail-safe PHPUnit 9 reading", () => {
    // A tally-only fragment with no version banner line at all,
    // standing in for a front-truncated capture (`exec.ts` drops lines
    // off the front, so a long enough run can drop the banner near the
    // top while keeping the tally at the very end -- see
    // `PHPUNIT_BANNER`'s own docblock). There is no version to read, so
    // the SUMMARY keeps the fail-safe PHPUnit 9 reading (a number has to
    // be printed either way), but the zero-tests question, whose answer
    // flips entirely with the version here, is reported as unreadable
    // rather than answered.
    const output = "WARNINGS!\nTests: 1, Assertions: 0, Warnings: 1.\n";
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 1,
    });
    expect(zeroTests(output)).toBe("ambiguous");
    expect(phpunitZeroTestsVerdict(output).reason).toContain(
      "states no PHPUnit version banner",
    );
    expect(phpunitZeroTestsVerdict(output).reason).toContain("`Warnings: 1`");
  });

  it("no banner, but a tally whose two readings agree: the verdict is that agreed value, not ambiguous", () => {
    // 5 tests, one of which raised a warning: read as a 9 that is 4
    // executed, read as a 10+ it is 5, and both are nonzero -- the
    // count is unreadable, the zero-tests question is not. Pins that
    // `ambiguous` reports a genuinely undecidable verdict rather than
    // firing on every banner-less output that merely carries the token.
    const output = "WARNINGS!\nTests: 5, Assertions: 4, Warnings: 1.\n";
    expect(zeroTests(output)).toBe("not_zero");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 4,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 1,
    });
    // No banner, so no version states that the count moved: the
    // fail-safe reading keeps it in `summary.warnings` and the detector
    // stays quiet.
    expect(parsed.warnings).toEqual([]);
  });

  it("no banner, and the two readings disagree about EXECUTED while agreeing about PASSED: still ambiguous, because the question is what ran, not what passed", () => {
    // SYNTHETIC (banner-less by construction, and PHPUnit would print
    // `FAILURES!` rather than `WARNINGS!` above this tally): one test,
    // counted BOTH as a warning and as a failure. Read as a PHPUnit 9,
    // the warning token takes the single test out of the budget, so
    // nothing executed and nothing passed; read as a 10+, the test ran
    // and its failure takes it, so one executed and still nothing
    // passed. The two readings therefore disagree about `executed` and
    // agree about `passed` -- a disagreement check written on `passed`
    // finds nothing ambiguous here and falls through to `"zero"`,
    // asserting that nothing ran about a run that, read as a 10+, ran
    // its one test and failed it.
    const output =
      "WARNINGS!\nTests: 1, Assertions: 0, Warnings: 1, Failures: 1.\n";
    expect(zeroTests(output)).toBe("ambiguous");
    const reason = phpunitZeroTestsVerdict(output).reason;
    expect(reason).toContain("`Warnings: 1`");
    expect(reason).toContain("leaving 0 executed");
    expect(reason).toContain("leaving 1");
    // The fail-safe summary printed beside the warning, and the reading
    // it carries, are named in the warning text itself (Summary.warnings
    // documents the same version dependence).
    expect(reason).toContain("carries the PHPUnit 9 reading");
    const parsed = phpunitDetector.parse({
      output,
      command: "vendor/bin/phpunit",
      exitCode: 0,
    });
    expect(parsed.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 1,
    });
  });
});

describe("verify: phpunit zero_tests_ambiguous warning (a banner-less green PHPUnit 11 run)", () => {
  it("a banner-less PHPUnit-11-shaped green tally gets the ambiguity warning and NO no_tests_executed claim", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const output = bannerlessGreenPhpunit11Tail();
    // Read as a PHPUnit 9 this run executed nothing; read as a PHPUnit
    // 10+ it ran and passed all 15. The output itself does not say
    // which, so claiming `no_tests_executed:` here would be a false
    // claim about a green run whose banner merely fell out of the kept
    // tail.
    expect(zeroTests(output)).toBe("ambiguous");
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 0, stdoutTail: output },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    // Still this detector's own output (the tally line selects it), so
    // the ambiguity is reported rather than silently falling to generic.
    expect(check.detector).toBe("phpunit");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    const ambiguous = result.warnings.filter((w) =>
      w.includes("zero_tests_ambiguous:"),
    );
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toContain("test: zero_tests_ambiguous:");
    expect(ambiguous[0]).toContain("states no PHPUnit version banner");
    expect(ambiguous[0]).toContain("`Warnings: 15`");
    // The count the two readings disagree about is named on both sides,
    // so a reader can act on it without re-running anything.
    expect(ambiguous[0]).toContain("leaving 0 executed");
    expect(ambiguous[0]).toContain("leaving 15");
  });

  it("a genuinely zero-executed run whose version IS stated keeps the no_tests_executed claim and gets no ambiguity warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-warnings"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    expect(result.checks[0].status).toBe("pass");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      true,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
  });
});

describe("phpunitDetector: selection and banner-anchoring guards", () => {
  it("a non-phpunit detector selection with zero-test-looking output gets no no_tests_executed warning (the detector === phpunitDetector guard)", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    // `phpunit-warnings.txt` genuinely reads as zero tests executed
    // (asserted below), but `phpunitDetector` is deliberately left out
    // of the detector pool here, so `selectDetector` falls to the
    // generic fallback instead (vitest's own detector does not match
    // this output either -- pinned elsewhere: "vitest, tsc, and eslint
    // detectors do not match phpunit captured output"). The phpunit-only
    // `no_tests_executed:` warning must never fire for a non-phpunit
    // selection, however the underlying output reads: without the
    // `detector === phpunitDetector` guard, this exact case would get
    // the warning even though no phpunit-specific parsing ever ran.
    const output = readCaptured("phpunit-warnings");
    expect(zeroTests(output)).toBe("zero");
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: output,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [vitestDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.detector).toBe("generic");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
  });

  it("the banner selects this detector only on its own whole line: indented, prefixed, or reduced to the credit line, it does not", () => {
    const banner = "PHPUnit 11.5.56 by Sebastian Bergmann and contributors.";
    const matches = (output: string): boolean =>
      phpunitDetector.matches({ output, command: "", exitCode: 0 });

    // Control: PHPUnit's own real banner, alone on its line, IS this
    // detector's output (it is the only shape an `exit()` mid-suite run
    // leaves behind).
    expect(matches(`${banner}\n`)).toBe(true);

    // The REAL banner text, indented by a log forwarder that pads every
    // line: the pattern is anchored at the line start itself (`^`), not
    // at the first non-space character (`^\s*`), so this is not read as
    // PHPUnit's own output.
    expect(
      matches(`some other tool's log\n  ${banner}\nmore log lines\n`),
    ).toBe(false);

    // The REAL banner text, prefixed by a CI line-tagger: anchored
    // (`/^PHPUnit`), not merely "contains PHPUnit ... contributors."
    // anywhere in the line.
    expect(matches(`[ci] ${banner}\n[ci] Runtime:       PHP 8.3.33\n`)).toBe(
      false,
    );

    // The credit line WITHOUT the version prefix, mid-sentence and
    // indented: a changelog or a release note quoting PHPUnit's credit
    // line is not a PHPUnit run, so the version prefix is load-bearing
    // and not decoration.
    expect(
      matches(
        "This changelog entry mentions PHPUnit's own credit line, by Sebastian Bergmann and contributors. in passing, but is not real phpunit output.\n",
      ),
    ).toBe(false);
    expect(
      matches(
        "some other tool's log\n  by Sebastian Bergmann and contributors.\nmore log lines\n",
      ),
    ).toBe(false);
    // The same credit line at the very start of its own UNINDENTED line,
    // which is what a pattern reduced to the credit line -- or one whose
    // version prefix merely became optional -- would happily match. The
    // two cases above cannot tell those apart, since neither of them
    // starts at a line boundary at all: measured, a mutant making the
    // version prefix optional survives the whole suite without this
    // one case.
    expect(matches("by Sebastian Bergmann and contributors.\n")).toBe(false);
  });

  it("phpunitDetector does not match the phpstan/phpcs captured output (pin: the three PHP detectors never shadow each other)", () => {
    for (const name of [
      "phpstan-clean",
      "phpstan-errors",
      "phpcs-clean",
      "phpcs-errors",
      "phpcs-two-files",
      "phpcs-warnings-only",
    ]) {
      expect(
        phpunitDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: 1,
        }),
      ).toBe(false);
    }
  });
});

describe("phpunitDetector: exit-mid-suite front-truncation limit", () => {
  it("a banner-less exit-mid-suite tail (the banner itself truncated off the front) falls to the generic detector, with no no_tests_executed warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    // Stands in for a large suite whose `exit()` kill happens so far into
    // the run that even PHPUnit's own version banner (the very first
    // line it prints) has already been pushed out of exec.ts's kept tail
    // (60 lines / 6000 chars) by the time the process dies -- see
    // PHPUNIT_BANNER's own docblock on this limit. No banner, no marker,
    // no tally: none of this detector's `matches()` checks fire, so
    // selection falls to `generic` and the zero-tests reading is never
    // even consulted.
    const bannerlessTail = Array.from(
      { length: 5 },
      (_, i) => `.`.repeat(1) + ` progress line ${i}`,
    ).join("\n");
    expect(
      phpunitDetector.matches({
        output: bannerlessTail,
        command: "",
        exitCode: 0,
      }),
    ).toBe(false);
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: bannerlessTail,
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.detector).toBe("generic");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
  });
});

/** Every `phpunit-*` capture in `test/fixtures/captured/`, derived from
 * the directory itself rather than from a hand-kept list: a capture
 * added for a new shape joins the disjointness pins below by existing.
 * The hand-kept list this replaces named 19 captures and silently fell
 * behind every capture added after it. */
const CAPTURED_PHPUNIT_FIXTURES: readonly string[] = fs
  .readdirSync(CAPTURED_DIR)
  .filter((file) => file.startsWith("phpunit-") && file.endsWith(".txt"))
  .map((file) => file.slice(0, -".txt".length))
  .sort();

describe("phpunitDetector: every captured phpunit fixture is disjoint from the other detectors (list derived from the fixtures directory)", () => {
  it("the list is derived, not hand-kept: it covers more captures than the 19 the old array named, including the newest ones", () => {
    expect(CAPTURED_PHPUNIT_FIXTURES.length).toBeGreaterThan(19);
    expect(CAPTURED_PHPUNIT_FIXTURES).toContain("phpunit-no-results-green");
    expect(CAPTURED_PHPUNIT_FIXTURES).toContain("phpunit-no-results-red");
    expect(CAPTURED_PHPUNIT_FIXTURES).toContain(
      "phpunit-no-results-filter-miss",
    );
    expect(CAPTURED_PHPUNIT_FIXTURES).toContain("phpunit-list-tests");
    expect(CAPTURED_PHPUNIT_FIXTURES).toContain("phpunit-exit-mid-suite-9");
  });

  it("neither vitest, tsc, eslint, phpstan nor phpcs matches ANY captured phpunit output", () => {
    for (const name of CAPTURED_PHPUNIT_FIXTURES) {
      const input = { output: readCaptured(name), command: "", exitCode: 0 };
      for (const detector of [
        vitestDetector,
        tscDetector,
        eslintDetector,
        phpstanDetector,
        phpcsDetector,
      ]) {
        // Compared as a labelled string so a failure names the fixture
        // and the detector that shadowed it, not merely `true !== false`.
        expect(
          `${name} matched by ${detector.name}: ${detector.matches(input)}`,
        ).toBe(`${name} matched by ${detector.name}: false`);
      }
    }
  });

  it("selectDetector against DEFAULT_DETECTORS selects phpunit (never generic, never an ambiguous pair) for every captured phpunit output", () => {
    for (const name of CAPTURED_PHPUNIT_FIXTURES) {
      const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
        output: readCaptured(name),
        command: "vendor/bin/phpunit",
        exitCode: 0,
      });
      expect(`${name}: ${selection.detector.name}`).toBe(`${name}: phpunit`);
      expect(selection.ambiguousCandidates).toBeUndefined();
    }
  });
});

describe("phpunitDetector: a suppressed result report is not a missing one (PHPUnit 10+ --no-results, tracker 3a0c5242)", () => {
  it("(i) a COMPLETED green `--no-results` run reads not_zero: its progress counter and post-run Time/Memory line are the completion evidence", () => {
    const output = readCaptured("phpunit-no-results-green");
    // Captured real (PHPUnit 11.5.56, exit 0, two tests that both ran
    // and passed): banner, `Runtime:`, `..  2 / 2 (100%)`, `Time:
    // 00:00.007, Memory: 8.00 MB`. No `OK (`, no marker, no tally --
    // `--no-results` suppresses the result report, not the run. Read as
    // a killed run (as this arm did before this change), `verify`
    // claims `no_tests_executed` about a green suite and `probe`
    // refuses every baseline of a project that runs PHPUnit this way.
    expect(output).toMatch(/^\.\.\s+2 \/ 2 \(100%\)$/m);
    expect(output).toContain("Time: 00:00.007, Memory: 8.00 MB");
    expect(output).not.toContain("OK (");
    expect(zeroTests(output)).toBe("not_zero");
  });

  it("(i) verify: the completed `--no-results` run stays pass with NO zero-tests warning of either kind", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-no-results-green"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(check.detector).toBe("phpunit");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
    // The suppressed report leaves no tally to read, so the counts stay
    // at the same graceful all-zero convention `No tests executed!`
    // already uses: this fixture's own `2 / 2 (100%)` counter is
    // deliberately NOT turned into `passed: 2`, since the RED capture
    // below prints the very same counter (see `PROGRESS_COUNTER_LINE`).
    expect(check.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it("(ii) `--no-results` plus a `--filter` that matches nothing reads ambiguous: banner and `Runtime:` alone, no completion evidence at all", () => {
    const output = readCaptured("phpunit-no-results-filter-miss");
    expect(output).toContain("Runtime:");
    expect(output).not.toMatch(/\d+ \/ \d+ \(/);
    expect(output).not.toContain("Time:");
    expect(zeroTests(output)).toBe("ambiguous");
    // Measured contrast: the SAME filter miss WITHOUT `--no-results`
    // prints PHPUnit's own `No tests executed!` line on both majors
    // (captured real as `phpunit-no-tests-executed.txt`), which is a
    // statement, not an absence, and reads `"zero"`.
    expect(zeroTests(readCaptured("phpunit-no-tests-executed"))).toBe("zero");
  });

  it("(iii) `--list-tests` reads ambiguous: documented over-caution, a listing never claimed to run anything", () => {
    const output = readCaptured("phpunit-list-tests");
    expect(output).toContain("Available tests:");
    expect(zeroTests(output)).toBe("ambiguous");
  });

  it("(iv) a RED `--no-results` run (exit 1) is status fail, so the pass-only zero-tests guard never fires", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const output = readCaptured("phpunit-no-results-red");
    // Captured real (PHPUnit 11.5.56, exit 1): the same counter and
    // Time/Memory shape as the green capture, with `.F` progress
    // characters -- which is exactly why the counter is read as
    // evidence of completion and never as a passed count.
    expect(output).toMatch(/^\.F\s+2 \/ 2 \(100%\)$/m);
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 1, stdoutTail: output },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("fail");
    expect(check.detector).toBe("phpunit");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
  });

  it("(vii) `--no-results --no-progress` and `--no-output` print NOTHING at all, so the output is not phpunit's to read (generic selection, no phpunit claim)", async () => {
    // Measured (PHPUnit 11.5.56, exit 0, both flag combinations): zero
    // bytes on stdout and stderr. Constructed here as empty strings
    // rather than kept as zero-byte fixture files: a zero-byte file
    // pins nothing about which tool produced it, and an empty capture
    // carries no PHPUnit evidence whatsoever -- which is the point.
    for (const output of ["", "\n"]) {
      expect(
        phpunitDetector.matches({ output, command: "", exitCode: 0 }),
      ).toBe(false);
      const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
        output,
        command: "vendor/bin/phpunit --no-results --no-progress",
        exitCode: 0,
      });
      expect(selection.detector.name).toBe("generic");
    }
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": { exitCode: 0, stdoutTail: "" },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].detector).toBe("generic");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
    expect(
      result.warnings.some((w) => w.includes("zero_tests_ambiguous:")),
    ).toBe(false);
  });

  it("the post-run Time/Memory line alone is enough completion evidence (SYNTHETIC: banner plus Time, no counter)", () => {
    // SYNTHETIC, and labelled as such: no measured PHPUnit invocation
    // produces a Time/Memory line without a progress counter (both
    // print together at the end of a completed run, and
    // `--no-results --no-progress` prints neither because it prints
    // nothing at all). Its only job is to isolate the Time conjunct:
    // with that conjunct alone removed from the reading, this input
    // would be reported as an unreadable result.
    const output = [
      "PHPUnit 11.5.56 by Sebastian Bergmann and contributors.",
      "",
      "Runtime:       PHP 8.3.33",
      "",
      "Time: 00:00.007, Memory: 8.00 MB",
      "",
    ].join("\n");
    expect(output).not.toMatch(/\d+ \/ \d+ \(/);
    expect(zeroTests(output)).toBe("not_zero");
  });

  it("the progress counter alone is enough completion evidence, which is also this reading's second documented limit (SYNTHETIC: banner plus counter, no Time)", () => {
    // SYNTHETIC, and labelled as such: this is the shape a mid-suite
    // `exit()`/`die()` leaves once the suite is long enough to have
    // finished a whole progress ROW (PHPUnit prints the `N / M (P%)`
    // counter at the end of each row) before the kill. Reproducing it
    // for real needs a suite of more than 63 tests, so it is
    // constructed here instead, and the limit it pins is documented in
    // the README: such a kill falls silent (`"not_zero"`) rather than
    // being reported as unreadable.
    const output = [
      "PHPUnit 11.5.56 by Sebastian Bergmann and contributors.",
      "",
      "Runtime:       PHP 8.3.33",
      "",
      `${".".repeat(63)}  63 / 200 ( 31%)`,
      "....",
    ].join("\n");
    expect(output).not.toContain("Time:");
    expect(zeroTests(output)).toBe("not_zero");
  });

  it("the banner conjunct is load-bearing: an output with no phpunit shape in it at all is never reported as an unreadable phpunit result", () => {
    // The unreadable-result reading is about PHPUnit's OWN output, and
    // the banner is the only thing that says the output is PHPUnit's at
    // all. Without that conjunct, ANY silent output -- a front-truncated
    // tail, another tool's log, an empty string -- would be reported as
    // a phpunit run whose result cannot be read.
    for (const output of [
      "some other tool said nothing useful\n",
      Array.from({ length: 5 }, (_, i) => `. progress line ${i}`).join("\n"),
      "",
    ]) {
      expect(zeroTests(output)).toBe("not_zero");
      expect(phpunitZeroTestsVerdict(output).reason).toContain(
        "no phpunit summary line",
      );
    }
  });
});

describe("verify: phpunit no_tests_executed detector warning (AC-005)", () => {
  it("a warnings-only phpunit run stays status pass but gets the no_tests_executed warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-warnings"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      true,
    );
  });

  it("an all-skipped phpunit run (exit 0) also gets the warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-all-skipped"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      true,
    );
  });

  it("an empty/filtered phpunit run (No tests executed!, exit 0) also gets the warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-no-tests-executed"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      true,
    );
  });

  it("a genuine green phpunit run (phpunit-pass.txt) does NOT get the warning", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 0,
        stdoutTail: readCaptured("phpunit-pass"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
  });

  it("a failing (non-zero exit) phpunit run never gets the pass-only warning, even if its tally shows zero executed", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 1,
        stdoutTail: readCaptured("phpunit-warnings"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
    });
    const check = result.checks[0];
    expect(check.status).toBe("fail");
    // `phpunit-warnings.txt` (PHPUnit 9.6.36, plain `Warnings: 1`, not
    // executed under 9, its own banner stating that 9) genuinely reads
    // as zero executed tests, independent of exit code (asserted
    // below); only `status === "pass"` gates the warning, so a mutant
    // widening that condition to `true` would add the warning here even
    // though `status` is `fail`. A capture that executed a real test
    // would read `not_zero` and let the assertion below pass for the
    // wrong reason under that mutant.
    expect(zeroTests(readCaptured("phpunit-warnings"))).toBe("zero");
    expect(result.warnings.some((w) => w.includes("no_tests_executed:"))).toBe(
      false,
    );
  });

  it("the warning wording names the status, not the exit code, since --pass-regex can decide pass on a non-zero exit", async () => {
    const cwd = makeTmpDir();
    writePackageJson(cwd, { test: "te" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run test --silent": {
        exitCode: 7,
        stdoutTail: readCaptured("phpunit-warnings"),
      },
    });
    const result = await verify({
      cwd,
      logDir,
      checks: ["test"],
      execFn: fn,
      detectors: [phpunitDetector],
      passRegexes: { test: compilePassRegex("Warnings: 1") },
    });
    const check = result.checks[0];
    expect(check.status).toBe("pass");
    expect(
      result.warnings.some((w) =>
        w.includes(
          "no_tests_executed: phpunit executed no test at all even though the check passed: phpunit's own tally line leaves zero executed tests once every not-executed category is taken out of its stated total.",
        ),
      ),
    ).toBe(true);
    // The old wording claimed an exit code of 0, which is false here
    // (exit 7, matched only via --pass-regex): pin that the message
    // never claims that.
    expect(
      result.warnings.some((w) => w.includes("even though the check exited 0")),
    ).toBe(false);
  });
});

describe("phpstanDetector: captured real output", () => {
  it("matches a clean run and an errors run, not vitest/tsc/eslint/phpunit output", () => {
    expect(
      phpstanDetector.matches({
        output: readCaptured("phpstan-clean"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      phpstanDetector.matches({
        output: readCaptured("phpstan-errors"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
    for (const name of [
      "vitest-pass",
      "tsc-errors",
      "eslint-errors",
      "phpunit-pass",
      "phpunit-fail",
      "phpcs-errors",
    ]) {
      expect(
        phpstanDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: 1,
        }),
      ).toBe(false);
    }
  });

  it("parses a clean run as one pass, no failures", () => {
    const parsed = phpstanDetector.parse({
      output: readCaptured("phpstan-clean"),
      command: "vendor/bin/phpstan analyse",
      exitCode: 0,
    });
    expect(parsed.failures).toEqual([]);
    expect(parsed.summary).toEqual({
      passed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it("parses an errors run: every table row, file from the table header, and the tool's own total", () => {
    const parsed = phpstanDetector.parse({
      output: readCaptured("phpstan-errors"),
      command: "vendor/bin/phpstan analyse",
      exitCode: 1,
    });
    expect(parsed.summary.errors).toBe(2);
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0].file).toBe("Bad.php");
    expect(parsed.failures[0].line).toBe(7);
    expect(parsed.failures[0].message).toContain("should return int");
    expect(parsed.failures[1].line).toBe(12);
    expect(parsed.failures[1].message).toContain("Undefined variable");
  });

  it("selectDetector against DEFAULT_DETECTORS: a real phpstan fixture selects phpstan (pin: deleting phpstanDetector from the array must fail this, not tsc)", () => {
    const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
      output: readCaptured("phpstan-errors"),
      command: "vendor/bin/phpstan analyse",
      exitCode: 1,
    });
    expect(selection.detector.name).toBe("phpstan");
  });
});

describe("phpcsDetector: captured real output", () => {
  it("matches an errors run, not the clean (empty) case, and not vitest/tsc/eslint/phpunit/phpstan output", () => {
    expect(
      phpcsDetector.matches({
        output: readCaptured("phpcs-errors"),
        command: "",
        exitCode: 2,
      }),
    ).toBe(true);
    expect(
      phpcsDetector.matches({
        output: readCaptured("phpcs-clean"),
        command: "",
        exitCode: 0,
      }),
    ).toBe(false);
    for (const name of [
      "vitest-pass",
      "tsc-errors",
      "eslint-errors",
      "phpunit-pass",
      "phpunit-fail",
      "phpstan-errors",
    ]) {
      expect(
        phpcsDetector.matches({
          output: readCaptured(name),
          command: "",
          exitCode: 1,
        }),
      ).toBe(false);
    }
  });

  it("parses an errors run: every ERROR row, file from the FILE header, and the tool's own total (exact count, not merely > 0)", () => {
    const parsed = phpcsDetector.parse({
      output: readCaptured("phpcs-errors"),
      command: "vendor/bin/phpcs --standard=PSR12",
      exitCode: 2,
    });
    expect(parsed.summary.errors).toBe(12);
    expect(parsed.failures).toHaveLength(12);
    expect(parsed.summary.warnings).toBe(0);
    expect(parsed.failures[0].file).toBe("phpcs-errors/Bad.php");
    expect(parsed.failures[0].line).toBe(1);
    expect(parsed.failures[0].message).toContain(
      "Header blocks must be separated",
    );
  });

  it("parses a warnings-only run: 0 errors, the tool's own warning total, no rows in failures (WARNING rows excluded)", () => {
    const parsed = phpcsDetector.parse({
      output: readCaptured("phpcs-warnings-only"),
      command: "vendor/bin/phpcs --standard=PSR12",
      exitCode: 1,
    });
    expect(parsed.summary.errors).toBe(0);
    expect(parsed.summary.warnings).toBe(2);
    expect(parsed.failures).toEqual([]);
  });

  it("matches and parses a warnings-only run (exit 1: PHPCS's own measured mapping is 0 clean, 1 warnings-only, 2 errors, 3 processing error)", () => {
    expect(
      phpcsDetector.matches({
        output: readCaptured("phpcs-warnings-only"),
        command: "",
        exitCode: 1,
      }),
    ).toBe(true);
  });

  it("parses a two-file run: sums every file's own FOUND block instead of reading only the first (round-1 review fixture: 8+8, not 8)", () => {
    const parsed = phpcsDetector.parse({
      output: readCaptured("phpcs-two-files"),
      command: "vendor/bin/phpcs --standard=PSR12",
      exitCode: 2,
    });
    expect(parsed.summary.errors).toBe(16);
    expect(parsed.failures).toHaveLength(16);
    // Both files' findings are present, not only the first block's.
    expect(
      parsed.failures.some((f) => f.file === "phpcs-two-files/FileA.php"),
    ).toBe(true);
    expect(
      parsed.failures.some((f) => f.file === "phpcs-two-files/FileB.php"),
    ).toBe(true);
  });

  it("selectDetector against DEFAULT_DETECTORS: a real phpcs fixture selects phpcs (pin: deleting phpcsDetector from the array must fail this)", () => {
    const selection = selectDetector(DEFAULT_DETECTORS, genericDetector, {
      output: readCaptured("phpcs-errors"),
      command: "vendor/bin/phpcs --standard=PSR12",
      exitCode: 2,
    });
    expect(selection.detector.name).toBe("phpcs");
  });
});
