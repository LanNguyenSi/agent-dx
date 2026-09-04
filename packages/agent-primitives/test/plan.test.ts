import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, probePlan, type ProbePlanOptions } from "../src/probe/index.js";
import {
  parsePlanFile,
  validatePlan,
  PLAN_MAX_BYTES,
  type PlanMutantSpec,
} from "../src/probe/plan.js";
import { readMarkerFor } from "../src/lock.js";
import { sha256File } from "../src/hash.js";
import { execCommand } from "../src/exec.js";
import { computeMutant } from "../src/probe/mutant.js";
import {
  beginInplace,
  beginWorktree,
  cleanupWorktree,
} from "../src/probe/isolation.js";

// Call-through partial mocks, the same shape `probe.test.ts` uses: every
// call runs the real implementation unless a test explicitly overrides
// it. This is what lets a test count how often the plan synced a
// worktree, or hand one target a session whose restore verifies against
// something other than the file the next mutant lands on (`vi.spyOn`
// cannot be used directly on an ESM named export).
vi.mock("../src/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/exec.js")>();
  return { ...actual, execCommand: vi.fn(actual.execCommand) };
});
vi.mock("../src/probe/mutant.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/mutant.js")>();
  return { ...actual, computeMutant: vi.fn(actual.computeMutant) };
});
vi.mock("../src/probe/isolation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/isolation.js")>();
  return {
    ...actual,
    beginInplace: vi.fn(actual.beginInplace),
    beginWorktree: vi.fn(actual.beginWorktree),
    cleanupWorktree: vi.fn(actual.cleanupWorktree),
  };
});

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-plan-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

let savedLockDir: string | undefined;
afterEach(() => {
  // Restores each `vi.fn(actual)` above to the real implementation it
  // was created with, so a `mockImplementationOnce` a failing test left
  // unconsumed can never reach the next one.
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

/** Every test gets its own lock dir, so a leftover lock/marker from one
 * test can never be observed by another. */
function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function isNegative(n) {",
  "  return n < 0;",
  "}",
  "module.exports = { isPositive, isNegative };",
  "",
].join("\n");

/** Appends the line-2 content it sees to `runs.txt` in the invocation
 * cwd before asserting, so a test can count how often the command ran
 * AND what each run observed, rather than inferring either. Exits
 * non-zero for any mutant of the two functions it covers. */
const FIXTURE_TEST_JS = [
  "const fs = require('node:fs');",
  "const content = fs.readFileSync('fixture.js', 'utf8');",
  "fs.appendFileSync('runs.txt', content.split('\\n')[1] + '\\n');",
  "const { isPositive, isNegative } = require('./fixture.js');",
  "if (isPositive(5) !== true) process.exit(1);",
  "if (isPositive(-5) !== false) process.exit(1);",
  "if (isPositive(0) !== false) process.exit(1);",
  "if (isNegative(-5) !== true) process.exit(1);",
  "if (isNegative(5) !== false) process.exit(1);",
  "",
].join("\n");

function initRepo(): { repo: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  // Pin the config the real-`git diff` fixtures below depend on
  // (headers with an `a/`/`b/` prefix, LF line endings) against whatever
  // the ambient global git config on the machine running these tests
  // happens to be.
  git(repo, ["config", "diff.noprefix", "false"]);
  git(repo, ["config", "diff.mnemonicPrefix", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo };
}

/** A patch produced by git itself rather than hand-written, restoring
 * the working tree afterwards so the plan under test sees the original
 * content. */
function realDiffPatch(repo: string, relPath: string, edited: string): string {
  const abs = path.join(repo, relPath);
  const original = fs.readFileSync(abs, "utf8");
  fs.writeFileSync(abs, edited);
  const diff = gitOutput(repo, ["diff", "--", relPath]);
  git(repo, ["checkout", "--", relPath]);
  expect(fs.readFileSync(abs, "utf8")).toBe(original);
  expect(diff).not.toBe("");
  const patchPath = path.join(makeTmpDir(), "real.patch");
  fs.writeFileSync(patchPath, diff);
  return patchPath;
}

function planOptions(
  repo: string,
  mutants: PlanMutantSpec[],
  overrides: Partial<ProbePlanOptions> = {},
): ProbePlanOptions {
  return {
    mutants,
    testCommand: "node fixture.test.js",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

function replaceMutant(
  line: number,
  replaceText: string,
  file = "fixture.js",
): PlanMutantSpec {
  return { file, line, form: "replace", replaceText };
}

/** The lines the test command recorded, one per invocation. */
function runsSeen(repo: string): string[] {
  const runsFile = path.join(repo, "runs.txt");
  if (!fs.existsSync(runsFile)) return [];
  return fs.readFileSync(runsFile, "utf8").split("\n").filter(Boolean);
}

function writePlan(contents: unknown): string {
  const planPath = path.join(makeTmpDir(), "plan.json");
  fs.writeFileSync(
    planPath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  return planPath;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Whether this host can create a FIFO. Node has no `mkfifo` binding, so
 * the test that needs one shells out; where the binary is absent the test
 * is skipped rather than silently weakened. */
const HAS_MKFIFO = (() => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-plan-mkfifo-probe-"),
  );
  try {
    execFileSync("mkfifo", [path.join(dir, "fifo")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe("plan file validation (before the lock, the marker or any run)", () => {
  it("accepts a full plan and converts timeout seconds to milliseconds", () => {
    const planPath = writePlan({
      test: "npm test",
      pre: "npm run build",
      isolation: "inplace",
      expect: "pass",
      timeout: 90,
      mutants: [
        { file: "src/a.ts", line: 3, replace: "return false;" },
        { file: "src/b.ts", line: 7, match: "n > 0", with: "n >= 0" },
        { file: "src/c.ts", patch: "mutant.patch", expect: "fail" },
      ],
    });
    const parsed = parsePlanFile(planPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.testCommand).toBe("npm test");
    expect(parsed.plan.preCommand).toBe("npm run build");
    expect(parsed.plan.isolation).toBe("inplace");
    expect(parsed.plan.expect).toBe("pass");
    expect(parsed.plan.timeoutMs).toBe(90_000);
    expect(parsed.plan.mutants.map((m) => m.form)).toEqual([
      "replace",
      "match",
      "patch",
    ]);
    expect(parsed.plan.mutants[2].expect).toBe("fail");
    expect(parsed.plan.mutants[0].expect).toBeUndefined();
  });

  it("refuses a plan with no test command, naming the offending path", () => {
    const planPath = writePlan({ mutants: [{ file: "a.ts", line: 1 }] });
    const parsed = parsePlanFile(planPath);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.test");
    expect(parsed.message).toContain(planPath);
  });

  it("refuses an empty mutant list with plan_empty, not plan_invalid", () => {
    const parsed = parsePlanFile(writePlan({ test: "npm test", mutants: [] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_empty");
  });

  it("refuses a mutant with two forms, naming the entry", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        mutants: [
          { file: "a.ts", line: 1, replace: "x" },
          { file: "b.ts", line: 2, replace: "x", patch: "p.patch" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.mutants[1]");
    expect(parsed.message).toContain("exactly one mutant form");
  });

  it("refuses a mutant with no form at all", () => {
    const parsed = parsePlanFile(
      writePlan({ test: "npm test", mutants: [{ file: "a.ts", line: 1 }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.mutants[0]");
  });

  it("refuses match without with (and with without match)", () => {
    for (const mutant of [
      { file: "a.ts", line: 1, match: "x" },
      { file: "a.ts", line: 1, with: "y" },
    ]) {
      const parsed = parsePlanFile(
        writePlan({ test: "npm test", mutants: [mutant] }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toBe("plan_invalid");
    }
  });

  it("refuses a replace/match mutant with no line", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        mutants: [{ file: "a.ts", replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.mutants[0].line");
  });

  it("refuses an unknown key at both levels rather than ignoring it", () => {
    const top = parsePlanFile(
      writePlan({ test: "npm test", timeoutMs: 5, mutants: [] }),
    );
    expect(top.ok).toBe(false);
    if (!top.ok) {
      expect(top.reason).toBe("plan_invalid");
      expect(top.message).toContain("plan.timeoutMs");
    }
    const nested = parsePlanFile(
      writePlan({
        test: "npm test",
        mutants: [
          { file: "a.ts", line: 1, replace: "x", isolation: "inplace" },
        ],
      }),
    );
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      expect(nested.reason).toBe("plan_invalid");
      expect(nested.message).toContain("plan.mutants[0].isolation");
    }
  });

  it("refuses a plan that is not a JSON object, and one that is not JSON at all", () => {
    const array = parsePlanFile(writePlan([{ test: "npm test" }]));
    expect(array.ok).toBe(false);
    if (!array.ok) expect(array.reason).toBe("plan_invalid");
    const notJson = parsePlanFile(writePlan("{ test: nope"));
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) {
      expect(notJson.reason).toBe("plan_invalid");
      expect(notJson.message).toContain("not valid JSON");
    }
  });

  it("refuses a missing plan, a directory, and an oversized file as plan_not_readable, by metadata alone", () => {
    const dir = makeTmpDir();
    const missing = parsePlanFile(path.join(dir, "nope.json"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("plan_not_readable");

    const asDirectory = parsePlanFile(dir);
    expect(asDirectory.ok).toBe(false);
    if (!asDirectory.ok) {
      expect(asDirectory.reason).toBe("plan_not_readable");
      expect(asDirectory.message).toContain("not a regular file");
    }

    const oversized = path.join(dir, "big.json");
    fs.writeFileSync(oversized, "x".repeat(PLAN_MAX_BYTES + 1));
    const tooBig = parsePlanFile(oversized);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) {
      expect(tooBig.reason).toBe("plan_not_readable");
      expect(tooBig.message).toContain("cap");
    }
  });

  it.skipIf(!HAS_MKFIFO)(
    "refuses a FIFO as plan_not_readable without blocking on it (needs mkfifo; skipped where the host has none)",
    () => {
      // The type check runs on an open descriptor, so the open itself
      // must not be the thing that hangs: a FIFO opened for reading
      // blocks until a writer appears, and there is none here. A test
      // that hangs instead of failing is the regression this guards.
      const planPath = path.join(makeTmpDir(), "fifo.json");
      execFileSync("mkfifo", [planPath]);
      const parsed = parsePlanFile(planPath);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe("plan_not_readable");
        expect(parsed.message).toContain("not a regular file");
      }
    },
    10000,
  );

  it.skipIf(isRoot)(
    "refuses a plan whose permissions deny reading (root bypasses permissions, so this only discriminates as a normal user)",
    () => {
      const planPath = writePlan({
        test: "npm test",
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      });
      fs.chmodSync(planPath, 0o000);
      const parsed = parsePlanFile(planPath);
      fs.chmodSync(planPath, 0o600);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("plan_not_readable");
    },
  );

  it("validatePlan works on an already-parsed value, without a file", () => {
    const result = validatePlan(
      { test: "npm test", mutants: [{ file: "a.ts", line: 1, replace: "x" }] },
      "<memory>",
    );
    expect(result.ok).toBe(true);
  });
});

describe("probePlan(): one baseline, every mutant against it (I1)", () => {
  it("runs the baseline exactly once and the test once per mutant, with one contract field set per mutant", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(5, "  return true;"),
        {
          file: "fixture.js",
          line: 2,
          form: "match",
          matchText: "n > 0",
          withText: "n >= 0",
        },
      ]),
    );

    // One baseline plus one run per mutant: four in total, never one
    // baseline per mutant.
    const runs = runsSeen(repo);
    expect(runs).toHaveLength(4);
    expect(runs[0]).toBe("  return n > 0;");
    expect(result.baseline?.exitCode).toBe(0);

    expect(result.status).toBe("killed");
    expect(result.summary).toEqual({
      total: 3,
      killed: 3,
      survived: 0,
      inconclusive: 0,
      not_run: 0,
    });
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2]);
    for (const [i, entry] of result.results.entries()) {
      expect(entry.status).toBe("killed");
      expect(entry.expect).toBe("fail");
      expect(entry.mutation_probe?.result).toBe("killed");
      expect(entry.mutation_probe?.restored_verified).toBe(true);
      expect(entry.mutation_probe?.mutant).toContain("fixture.js:");
      expect(entry.mutation_probe?.verified_applied_via).toContain(
        "fixture.js:",
      );
      expect(entry.mutant?.file).toBe(path.join(repo, "fixture.js"));
      expect(entry.test?.command).toBe("node fixture.test.js");
      expect(entry.test?.exitCode).not.toBe(0);
      expect(runs[i + 1]).toBe(
        i === 1 ? "  return n > 0;" : entry.mutant?.after,
      );
    }
    // Every mutant restored, and the file byte-identical afterwards.
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
    expect(
      readMarkerFor(fs.realpathSync(path.join(repo, "fixture.js"))),
    ).toBeUndefined();
  }, 30000);

  it("reports a survivor as survived while the killed mutants stay killed, and the plan cannot be exit-class ok", async () => {
    useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        // Nothing asserts anything about this function's `unused`
        // branch, so replacing it is not caught by the suite.
        replaceMutant(
          7,
          "module.exports = { isPositive, isNegative, extra: 1 };",
        ),
      ]),
    );

    expect(result.status).toBe("survived");
    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].status).toBe("survived");
    expect(result.summary.killed).toBe(1);
    expect(result.summary.survived).toBe(1);
  }, 30000);

  it("honours a per-mutant expect over the plan-level default", async () => {
    useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(repo, [
        // A mutant the suite does NOT catch, declared as one that must
        // leave the test passing: killed under `expect: "pass"`.
        {
          ...replaceMutant(
            7,
            "module.exports = { isPositive, isNegative, extra: 1 };",
          ),
          expect: "pass",
        },
        replaceMutant(2, "  return false;"),
      ]),
    );

    expect(result.results[0].expect).toBe("pass");
    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].expect).toBe("fail");
    expect(result.results[1].status).toBe("killed");
    expect(result.status).toBe("killed");
  }, 30000);
});

describe("probePlan(): the target is restored between mutants (I2)", () => {
  it("restores the target to its pre-mutation content before the next mutant is applied, verified by hash", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const beforeHash = await sha256File(target);

    // A `patch` mutant in the middle is the mechanism-level check: its
    // real `git apply` runs against the file on disk, with the lines
    // around its hunk as context, so a target still carrying the
    // previous mutant's content cannot take it.
    const patchPath = realDiffPatch(
      repo,
      "fixture.js",
      FIXTURE_JS.replace("  return n < 0;", "  return true;"),
    );

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        { file: "fixture.js", form: "patch", patchPath },
        {
          file: "fixture.js",
          line: 2,
          form: "match",
          matchText: "n > 0",
          withText: "n >= 0",
        },
      ]),
    );

    expect(result.status).toBe("killed");
    expect(result.summary.killed).toBe(3);
    for (const entry of result.results) {
      expect(entry.mutation_probe?.restored_verified).toBe(true);
    }
    expect(await sha256File(target)).toBe(beforeHash);
  }, 30000);

  it("stops the plan when the target is not back at its pre-mutation content, instead of applying the next mutant on top of it", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const originalContent = fs.readFileSync(target, "utf8");

    // A session whose restore verifies against a decoy copy while the
    // real target keeps whatever the mutant wrote: exactly the state the
    // between-mutants hash check exists for (a restore that "verified"
    // but not on the file the next mutant would land on).
    const decoy = path.join(makeTmpDir(), "decoy.js");
    vi.mocked(beginInplace).mockImplementationOnce((targetPath, logDir) => {
      const real = beginInplace(targetPath, logDir);
      fs.copyFileSync(targetPath, decoy);
      return {
        backupPath: real.backupPath,
        targetPath: decoy,
        restore: () => {
          fs.copyFileSync(real.backupPath, decoy);
          return true;
        },
      };
    });

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(5, "  return true;"),
        replaceMutant(7, "module.exports = {};"),
      ]),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_not_restored");
    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].status).toBe("inconclusive");
    expect(result.results[1].reason).toBe("target_not_restored");
    expect(result.results[1].warnings.join(" ")).toContain("backup path");
    // Nothing further was applied: the third mutant never ran, and the
    // file still carries the FIRST mutant, never the second's content.
    expect(result.results[2].status).toBe("not_run");
    expect(fs.readFileSync(target, "utf8")).toContain("  return false;");
    expect(fs.readFileSync(target, "utf8")).not.toContain("  return true;");
    // Only the baseline and the first mutant ever ran the test command.
    expect(runsSeen(repo)).toHaveLength(2);

    fs.writeFileSync(target, originalContent);
  }, 30000);
});

describe("probePlan(): a failing baseline applies no mutant at all", () => {
  it("ends inconclusive/baseline_failed with every mutant not_run, the target untouched and zero apply attempts", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const beforeHash = await sha256File(target);
    vi.mocked(computeMutant).mockClear();

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ],
        { testCommand: "exit 1" },
      ),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
    expect(result.baseline?.exitCode).toBe(1);
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    expect(result.summary.not_run).toBe(2);
    // Nothing was even computed, let alone applied.
    expect(vi.mocked(computeMutant)).not.toHaveBeenCalled();
    expect(await sha256File(target)).toBe(beforeHash);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 30000);
});

describe("probePlan(): a restore failure is terminal (I3)", () => {
  it("reports restore_failed, applies nothing further, reports the rest not_run, and keeps the marker and the backup", async () => {
    useLockDir();
    const { repo } = initRepo();
    // The test command replaces the target with a directory once it sees
    // the first mutant, so only the restore step fails (the baseline run
    // is a no-op).
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "fs.appendFileSync('runs.txt', 'run\\n');",
        "if (content.includes('CORRUPT_MARKER')) {",
        "  fs.rmSync('fixture.js', { force: true });",
        "  fs.mkdirSync('fixture.js');",
        "}",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "corrupting test",
    ]);

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false; // CORRUPT_MARKER"),
        replaceMutant(5, "  return true;"),
        replaceMutant(7, "module.exports = {};"),
      ]),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("restore_failed");
    expect(result.results[0].status).toBe("inconclusive");
    expect(result.results[0].reason).toBe("restore_failed");
    expect(result.results[0].mutation_probe?.result).toBe("inconclusive");
    expect(result.results[0].mutation_probe?.restored_verified).toBe(false);
    expect(result.results.slice(1).map((r) => r.status)).toEqual([
      "not_run",
      "not_run",
    ]);
    expect(result.summary).toEqual({
      total: 3,
      killed: 0,
      survived: 0,
      inconclusive: 1,
      not_run: 2,
    });
    // The test command ran for the baseline and the first mutant only.
    expect(runsSeen(repo)).toHaveLength(2);

    // The marker and the backup stay, exactly as the single probe leaves
    // them, so a human (or `doctor`) can recover the target.
    const marker = readMarkerFor(
      fs.realpathSync(path.join(repo, "fixture.js")),
    );
    expect(marker).toBeDefined();
    const backupWarning = result.results[0].warnings.find((w) =>
      w.includes("backup path"),
    );
    expect(backupWarning).toBeDefined();
    const backupPath = /backup path (\S+)/.exec(backupWarning ?? "")?.[1];
    expect(backupPath).toBeDefined();
    if (backupPath) expect(fs.existsSync(backupPath)).toBe(true);
  }, 30000);
});

describe("probePlan(): the worktree is synced once and cleaned up once (I4)", () => {
  it("syncs one worktree for the whole plan, cleans it up once, and leaves the original tree untouched", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const beforeHash = await sha256File(target);
    vi.mocked(beginWorktree).mockClear();
    vi.mocked(cleanupWorktree).mockClear();
    const logDir = makeTmpDir();

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
          replaceMutant(7, "module.exports = {};"),
        ],
        { isolation: "worktree", logDir },
      ),
    );

    expect(result.status).toBe("killed");
    expect(result.summary.killed).toBe(3);
    expect(vi.mocked(beginWorktree)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cleanupWorktree)).toHaveBeenCalledTimes(1);
    expect(result.isolation.mode).toBe("worktree");
    expect(result.isolation.path).not.toBeNull();
    // One scratch worktree directory, and it is gone afterwards.
    const scratchDirs = fs
      .readdirSync(logDir)
      .filter((entry) => entry.startsWith("wt-"));
    expect(scratchDirs).toHaveLength(1);
    expect(fs.existsSync(result.isolation.path ?? "")).toBe(false);
    expect(
      gitOutput(repo, ["worktree", "list", "--porcelain"]).split("worktree ")
        .length - 1,
    ).toBe(1);
    // The original tree was never mutated, and the test ran in the
    // worktree: `runs.txt` was written there, not here.
    expect(await sha256File(target)).toBe(beforeHash);
    expect(runsSeen(repo)).toEqual([]);
    expect(gitOutput(repo, ["status", "--porcelain"])).toBe("");
  }, 60000);
});

describe("probePlan(): refusals before the lock, the marker or any worktree", () => {
  it("refuses a file outside the containment root as usage_error/file_outside_root, with nothing left behind", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const outside = path.join(makeTmpDir(), "outside.js");
    fs.writeFileSync(outside, "let x = 1;\n");

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(1, "let x = 2;", outside),
      ]),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("file_outside_root");
    expect(result.warnings.join(" ")).toContain(outside);
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    // Nothing ran, nothing was locked, nothing was marked.
    expect(runsSeen(repo)).toEqual([]);
    expect(fs.readdirSync(lockDir)).toEqual([]);
  });

  it("refuses an unreadable patch by metadata, naming the mutant it belongs to", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        {
          file: "fixture.js",
          form: "patch",
          patchPath: path.join(repo, "nope.patch"),
        },
      ]),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("patch_not_readable");
    expect(result.warnings.join(" ")).toContain("plan.mutants[1].patch");
    expect(fs.readdirSync(lockDir)).toEqual([]);
  });

  it("refuses an empty plan and a replace mutant with no line", async () => {
    useLockDir();
    const { repo } = initRepo();

    const empty = await probePlan(planOptions(repo, []));
    expect(empty.status).toBe("usage_error");
    expect(empty.reason).toBe("plan_empty");

    const noLine = await probePlan(
      planOptions(repo, [
        { file: "fixture.js", form: "replace", replaceText: "  return false;" },
      ]),
    );
    expect(noLine.status).toBe("usage_error");
    expect(noLine.reason).toBe("plan_invalid");
    expect(noLine.warnings.join(" ")).toContain("plan.mutants[0].line");
  });

  it("reports a missing target file as usage_error/file_not_found, naming the plan entry rather than the plan file", async () => {
    useLockDir();
    const { repo } = initRepo();
    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(1, "x", "does-not-exist.js"),
      ]),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("file_not_found");
    // The refusal points at the entry that named the path, not at the
    // plan file (which was read fine) and not at `--file` (which a plan
    // has none of).
    expect(result.warnings.join(" ")).toContain(
      `plan.mutants[1].file not found: ${path.join(repo, "does-not-exist.js")}`,
    );
  });
});

describe("probePlan(): several files in one plan", () => {
  it("backs up, mutates and restores each target on its own, against one shared baseline", async () => {
    useLockDir();
    const { repo } = initRepo();
    const second = path.join(repo, "other.js");
    fs.writeFileSync(second, "module.exports = { two: () => 2 };\n");
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "fs.appendFileSync('runs.txt', 'run\\n');",
        "const { isPositive } = require('./fixture.js');",
        "const { two } = require('./other.js');",
        "if (isPositive(5) !== true) process.exit(1);",
        "if (two() !== 2) process.exit(1);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "two files",
    ]);
    const hashes = {
      fixture: await sha256File(path.join(repo, "fixture.js")),
      other: await sha256File(second),
    };

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(1, "module.exports = { two: () => 3 };", "other.js"),
      ]),
    );

    expect(result.status).toBe("killed");
    expect(result.summary.killed).toBe(2);
    expect(result.results[0].file).toBe(path.join(repo, "fixture.js"));
    expect(result.results[1].file).toBe(second);
    expect(runsSeen(repo)).toHaveLength(3);
    expect(await sha256File(path.join(repo, "fixture.js"))).toBe(
      hashes.fixture,
    );
    expect(await sha256File(second)).toBe(hashes.other);
  }, 30000);
});

describe("probePlan(): a mutant that cannot be applied is inconclusive on its own", () => {
  it("keeps running the remaining mutants and reports the plan inconclusive", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probePlan(
      planOptions(repo, [
        // Line 99 does not exist: nothing is applied for this mutant.
        replaceMutant(99, "  return false;"),
        replaceMutant(2, "  return false;"),
      ]),
    );

    expect(result.results[0].status).toBe("inconclusive");
    expect(result.results[0].reason).toBe("mutant_not_applicable");
    expect(result.results[0].mutation_probe).toBeUndefined();
    expect(result.results[1].status).toBe("killed");
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_inconclusive");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  }, 30000);
});

describe("probePlan(): a stopped run never starts the next mutant (I5)", () => {
  it("ends the plan aborted and reports the remaining mutants not_run when a mutant's own run was stopped", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    // The library-mode half of the signal contract: a run reported as
    // aborted (what `exec.ts` reports once the signal handler has killed
    // the in-flight child) must stop the plan where it stands. The CLI
    // half -- exit 130/143 with no output at all -- is covered through
    // the built CLI in `cli.test.ts`, since there the handler ends the
    // process itself. Forced here rather than by signalling this test
    // process, which would race vitest's own handlers.
    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    let callCount = 0;
    vi.mocked(execCommand).mockImplementation(
      async (...args: Parameters<typeof execCommand>) => {
        callCount += 1;
        const result = await actualExec.execCommand(...args);
        // Call 1 is the baseline (which must pass for the plan to reach
        // a mutant at all); call 2 is the first mutant's own test run.
        return callCount === 2 ? { ...result, aborted: true } : result;
      },
    );

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(5, "  return true;"),
        replaceMutant(7, "module.exports = {};"),
      ]),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.results[0].status).toBe("inconclusive");
    expect(result.results[0].reason).toBe("aborted");
    // Never a verdict about a mutant nothing measured, and never a
    // fourth run: the second and third mutants were not attempted.
    expect(result.results.slice(1).map((r) => r.status)).toEqual([
      "not_run",
      "not_run",
    ]);
    expect(callCount).toBe(2);
    expect(runsSeen(repo)).toHaveLength(2);
    // The in-flight mutant was still restored.
    expect(result.results[0].mutation_probe?.restored_verified).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  }, 30000);
});

/** Every backup `beginInplace` handed out during the run under test,
 * read off the call-through mock's own recorded return values rather
 * than by guessing at paths. */
function backupPathsTaken(): string[] {
  return vi
    .mocked(beginInplace)
    .mock.results.filter((result) => result.type === "return")
    .map((result) => result.value.backupPath);
}

describe("probePlan(): a target the baseline itself rewrote", () => {
  // The plan used to leave that target's backup file behind while the
  // single probe discarded it, because each pipeline carried its own
  // copy of this step. They run the same code now, so this test states
  // the shared contract and compares the two runs directly.
  const REWRITING_TEST =
    "node -e \"require('fs').writeFileSync('fixture.js', 'REWRITTEN')\"";

  it("ends target_changed_during_baseline leaving the target as the baseline wrote it, with no backup left behind: the same handling as the single probe", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    vi.mocked(beginInplace).mockClear();

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ],
        { testCommand: REWRITING_TEST },
      ),
    );
    const planBackups = backupPathsTaken();

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_changed_during_baseline");
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    // Never restored: the baseline's own write stands, since it was not
    // this plan's mutation to undo.
    expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN");
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
    // ...and the backup went with the decision not to restore from it.
    expect(planBackups.length).toBeGreaterThan(0);
    expect(planBackups.filter((backup) => fs.existsSync(backup))).toEqual([]);

    // The single probe, on the same fixture: same reason, same shape of
    // warning (only the subject differs, since a plan may carry several
    // targets), and the same empty aftermath.
    vi.mocked(beginInplace).mockClear();
    const { repo: soloRepo } = initRepo();
    const solo = await probe({
      file: "fixture.js",
      line: 2,
      form: "replace",
      replaceText: "  return false;",
      testCommand: REWRITING_TEST,
      isolation: "inplace",
      expect: "fail",
      cwd: soloRepo,
      logDir: makeTmpDir(),
    });
    const soloBackups = backupPathsTaken();

    expect(solo.reason).toBe(result.reason);
    expect(soloBackups.length).toBeGreaterThan(0);
    expect(soloBackups.filter((backup) => fs.existsSync(backup))).toEqual([]);
    const tail =
      " changed during the baseline run (before any mutation was applied); the target is left as the baseline run wrote it, not restored";
    expect(solo.warnings).toContain(`the target${tail}`);
    expect(result.warnings).toContain(`${target}${tail}`);
  }, 30000);
});

describe("probePlan(): an unexpected error while a mutant is applied", () => {
  it("reports the verdicts it already collected, the in-flight mutant as restore_failed, and only the unreached mutants not_run", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    // The third command this plan runs is the SECOND mutant's test (the
    // baseline is the first): it destroys the target, so no restore can
    // succeed, and then fails the way an unexpected internal error does
    // -- by throwing, which is the only way into the emergency-restore
    // path in `finally`.
    let commands = 0;
    vi.mocked(execCommand).mockImplementation((cmd, options) => {
      commands += 1;
      if (commands === 3) {
        fs.rmSync(target, { force: true });
        fs.mkdirSync(target);
        throw new Error("exec exploded");
      }
      return actualExec.execCommand(cmd, options);
    });

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(5, "  return true;"),
        replaceMutant(7, "module.exports = {};"),
      ]),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("restore_failed");
    expect(result.warnings.join(" ")).toContain(
      "restore failed after an unexpected error",
    );
    expect(result.warnings.join(" ")).toContain("exec exploded");
    // The verdict the plan had already reached is reported, not thrown
    // away: the first mutant really was killed.
    expect(result.results[0].status).toBe("killed");
    expect(result.results[0].mutation_probe?.result).toBe("killed");
    // The mutant that was applied when the error hit is reported as
    // applied-and-not-restored, never as `not_run`.
    expect(result.results[1].status).toBe("inconclusive");
    expect(result.results[1].reason).toBe("restore_failed");
    expect(result.results[1].mutation_probe?.restored_verified).toBe(false);
    // Only the mutant the plan never reached is `not_run`.
    expect(result.results[2].status).toBe("not_run");
    expect(result.summary).toEqual({
      total: 3,
      killed: 1,
      survived: 0,
      inconclusive: 1,
      not_run: 1,
    });
    // The baseline is still reported, and so is the log path of the
    // baseline run, which the emergency path used to drop.
    expect(result.baseline?.exitCode).toBe(0);
  }, 30000);
});

describe("probePlan(): a target that was never synced into the worktree", () => {
  it("refuses partway through the target-open loop with target_not_synced, leaving no backup, marker or restore slot from the target it already opened", async () => {
    useLockDir();
    const { repo } = initRepo();
    const ignored = path.join(repo, "ignored.js");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.js\n");
    fs.writeFileSync(ignored, "module.exports = { two: () => 2 };\n");
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "gitignore",
    ]);
    const target = path.join(repo, "fixture.js");
    const beforeHash = await sha256File(target);
    vi.mocked(beginInplace).mockClear();

    const result = await probePlan(
      planOptions(
        repo,
        [
          // The first target opens (and is backed up) before the second
          // is even looked at.
          replaceMutant(2, "  return false;"),
          replaceMutant(1, "module.exports = { two: () => 3 };", "ignored.js"),
        ],
        { isolation: "worktree" },
      ),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_not_synced");
    expect(result.warnings.join(" ")).toContain("plan.mutants[1].file");
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    // The first target's backup was taken and then dropped again: no
    // stray backup file, no marker, and (the same call that removes the
    // backup) no restore armed for a run that never mutated anything.
    const backups = backupPathsTaken();
    expect(backups.length).toBe(1);
    expect(backups.filter((backup) => fs.existsSync(backup))).toEqual([]);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
    expect(readMarkerFor(fs.realpathSync(repo))).toBeUndefined();
    expect(await sha256File(target)).toBe(beforeHash);
    // The worktree was cleaned up with the refusal.
    expect(
      gitOutput(repo, ["worktree", "list"]).trim().split("\n"),
    ).toHaveLength(1);
  }, 60000);
});
