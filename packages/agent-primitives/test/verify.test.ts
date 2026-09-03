import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  verify,
  selectDetector,
  genericDetector,
  DEFAULT_CHECKS,
} from "../src/verify/index.js";
import { UsageError } from "../src/envelope.js";
import type {
  Detector,
  DetectorParseResult,
  ExecLike,
} from "../src/verify/types.js";
import type { ExecResult } from "../src/exec.js";

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
      };
    };
    await verify({ cwd, logDir, checks: ["test"], execFn: fn });
    expect(seen).toEqual([undefined]);
  });
});
