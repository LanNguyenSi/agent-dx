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
      logWriteFailed: false,
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

  function makeAlphaBetaGeneric(
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
    return [alpha, beta, genericDetector];
  }

  it("zero candidates: selects the fallback (last, generic) detector", () => {
    const detectors = makeAlphaBetaGeneric(false, false);
    const selection = selectDetector(detectors, {
      output: "anything",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(selection.detector).toBe(genericDetector);
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("one candidate: selects that candidate, never the fallback", () => {
    const detectors = makeAlphaBetaGeneric(true, false);
    const selection = selectDetector(detectors, {
      output: "anything",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(selection.detector.name).toBe("alpha");
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("two or more candidates, exactly one named by the command text: selects that one", () => {
    const detectors = makeAlphaBetaGeneric(true, true);
    const selection = selectDetector(detectors, {
      output: "anything",
      command: "npm run test --silent -- alpha",
      exitCode: 1,
    });
    expect(selection.detector.name).toBe("alpha");
    expect(selection.ambiguousCandidates).toBeUndefined();
  });

  it("two or more candidates, none (or more than one) named by the command text: falls back to generic with the candidate shapes listed", () => {
    const detectors = makeAlphaBetaGeneric(true, true);
    const selection = selectDetector(detectors, {
      output: "anything",
      command: "npm run test --silent",
      exitCode: 1,
    });
    expect(selection.detector).toBe(genericDetector);
    expect(selection.ambiguousCandidates).toEqual(["alpha", "beta"]);
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
    // exec.ts derives the log file path as `<logDir>/verify/<name>.log`;
    // pre-creating a directory at that exact path forces the write
    // stream `createWriteStream` opens there to fail (EISDIR) without
    // touching exec.ts itself or relying on filesystem permission bits
    // (which sandboxes and CI runners do not treat uniformly).
    const verifySubdir = path.join(logDir, "verify");
    fs.mkdirSync(verifySubdir, { recursive: true });
    fs.mkdirSync(path.join(verifySubdir, "test.log"));

    const result = await verify({ cwd, logDir, checks: ["test"] });

    expect(result.logs).toEqual([]);
    expect(
      result.warnings.some(
        (w) => w.startsWith("test: log write failed") && w.includes("EISDIR"),
      ),
    ).toBe(true);
  }, 20000);
});
