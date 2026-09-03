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
  DEFAULT_CHECKS,
  DEFAULT_DETECTORS,
} from "../src/verify/index.js";
import { UsageError } from "../src/envelope.js";
import type {
  Detector,
  DetectorParseResult,
  ExecLike,
} from "../src/verify/types.js";
import type { ExecResult } from "../src/exec.js";
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

  it("a check with neither an override nor a matching script is skipped and never invoked", async () => {
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
      failures: [],
    });
    expect(result.status).toBe("pass");
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
    expect(result.status).toBe("pass");
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
    expect(result.status).toBe("fail");
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

describe("verify: tailAtBound line-count boundary (a trailing newline is not a phantom line)", () => {
  it("58 real lines: not truncated", async () => {
    const stdoutTail = Array.from({ length: 58 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": { exitCode: 2, stdoutTail },
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

  it('59 real lines with a trailing newline (60 elements from split("\\n"), one of them the phantom empty tail): not truncated -- discriminates the off-by-one on the trailing-newline split element', async () => {
    const stdoutTail =
      Array.from({ length: 59 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": { exitCode: 2, stdoutTail },
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

  it("60 real lines: truncated", async () => {
    const stdoutTail = Array.from({ length: 60 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": { exitCode: 2, stdoutTail },
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

  it("exactly 6000 characters: truncated (the character bound, independent of the line-count bound)", async () => {
    const stdoutTail = "a".repeat(6000);
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": { exitCode: 2, stdoutTail },
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

  it("5999 characters: not truncated", async () => {
    const stdoutTail = "a".repeat(5999);
    const cwd = makeTmpDir();
    writePackageJson(cwd, { typecheck: "run-tsc" });
    const logDir = makeTmpDir();
    const { fn } = makeStubExec({
      "npm run typecheck --silent": { exitCode: 2, stdoutTail },
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
      "npm run lint --silent": { exitCode: 1, stdoutTail },
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
