import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  probe,
  probePlan,
  type ExpectVerdict,
  type ProbePlanOptions,
  type ProbePlanResult,
} from "../src/probe/index.js";
import {
  parsePlanFile,
  validatePlan,
  PLAN_MAX_BYTES,
  type PlanMutantSpec,
} from "../src/probe/plan.js";
import { readMarkerFor } from "../src/lock.js";
import { initNodeTestDotRepo } from "./helpers/node-test-dot-repo.js";
import { expectNoIsolationLeftovers } from "./helpers/no-leftovers.js";
import { sha256File } from "../src/hash.js";
import { execCommand } from "../src/exec.js";
import { applyPatchForReal, computeMutant } from "../src/probe/mutant.js";
import { beginPyCacheIsolation } from "../src/probe/pycache.js";
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
  return {
    ...actual,
    computeMutant: vi.fn(actual.computeMutant),
    applyPatchForReal: vi.fn(actual.applyPatchForReal),
  };
});
vi.mock("../src/probe/pycache.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/pycache.js")>();
  return {
    ...actual,
    beginPyCacheIsolation: vi.fn(actual.beginPyCacheIsolation),
  };
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The built library entry point, imported by the spawned script the
 * plan-level SIGTERM test below uses: that script has to be a library
 * caller in a process of its own, not this one (same reasoning as
 * `probe.test.ts`'s own `DIST_INDEX`). */
const DIST_INDEX = path.join(__dirname, "..", "dist", "index.js");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  it("accepts plan.link as an array of repo-root-relative paths", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        link: ["vendor", "../shared-cache"],
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.link).toEqual(["vendor", "../shared-cache"]);
  });

  it("plan.link is optional; a plan with none carries no link key at all", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.link).toBeUndefined();
  });

  it("refuses plan.link that is not an array", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        link: "vendor",
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.link");
  });

  it("refuses an empty-string plan.link entry, naming the entry", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        link: ["vendor", ""],
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.link[1]");
  });

  it("rejects a plan.link entry carrying a $(...) command substitution or a backtick, naming the entry -- the same validation --link itself applies", () => {
    for (const bad of ["vendor/$(rm -rf /)", "vendor/`rm -rf /`"]) {
      const parsed = parsePlanFile(
        writePlan({
          test: "npm test",
          link: [bad],
          mutants: [{ file: "a.ts", line: 1, replace: "x" }],
        }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe("plan_invalid");
      expect(parsed.message).toContain("plan.link[0]");
      expect(parsed.message).toMatch(/\$\(|backtick/);
    }
  });
});

describe("probePlan(): one baseline, every mutant against it (I1)", () => {
  it("resolves a parent-relative log directory once against the plan invocation cwd", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logName = `plan-relative-parent-${Date.now()}-${Math.random()}`;
    const expectedRoot = path.resolve(repo, "..", logName);
    try {
      const result = await probePlan(
        planOptions(repo, [replaceMutant(2, "  return false;")], {
          isolation: "worktree",
          logDir: path.join("..", logName),
        }),
      );

      expect(result.status).toBe("killed");
      expect(path.dirname(path.dirname(result.isolation.path as string))).toBe(
        expectedRoot,
      );
    } finally {
      fs.rmSync(expectedRoot, { recursive: true, force: true });
    }
  });

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
      build_failed: 0,
      met: 3,
      violated: 0,
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
        // A mutant the suite does NOT catch (actual outcome: survived),
        // declared as one that must leave the test passing: the
        // expectation is met under `expect: "pass"`.
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
    expect(result.results[0].status).toBe("survived");
    expect(result.results[0].mutation_probe?.expectation).toBe("met");
    expect(result.results[1].expect).toBe("fail");
    expect(result.results[1].status).toBe("killed");
    expect(result.results[1].mutation_probe?.expectation).toBe("met");
    // Neither mutant's own expectation was violated, so the plan
    // concludes `killed` even though one of its mutants' actual outcome
    // is `survived`.
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
    vi.mocked(beginInplace).mockImplementationOnce(
      (targetPath, logDir, boundRoot) => {
        const real = beginInplace(targetPath, logDir, boundRoot);
        fs.copyFileSync(targetPath, decoy);
        return {
          backupPath: real.backupPath,
          targetPath: decoy,
          takeRestoreWarnings: () => [],
          restore: () => {
            fs.copyFileSync(real.backupPath, decoy);
            return true;
          },
        };
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

describe("probePlan(): the final rebuild after the last mutant is restored", () => {
  /** A counter script (same shape `probe.test.ts` uses for the single
   * probe's own rebuild tests): appends one line per invocation, so a
   * test can assert exactly how many times `--pre` ran. */
  function counterScript(counterFile: string): string {
    const scriptPath = path.join(makeTmpDir(), "count.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('fs');",
        `const n = Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) + 1;`,
        `fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));`,
        "",
      ].join("\n"),
    );
    return `node ${JSON.stringify(scriptPath)}`;
  }

  it("a two-target plan whose first mutant's own test command rewrites the second target names the stale-build clause on the target_not_restored warning, without touching top-level warnings", async () => {
    useLockDir();
    const { repo } = initRepo();
    const secondPath = path.join(repo, "second.js");
    fs.writeFileSync(
      secondPath,
      "function triple(n) {\n  return n * 3;\n}\nmodule.exports = { triple };\n",
    );
    // Stands in for a test suite whose side effect happens to touch a
    // second file: once the mutant on `fixture.js` is live, this write
    // lands on `second.js` DURING the first mutant's own test phase,
    // before that mutant is even restored -- exactly the ordering the
    // between-mutants hash check (I2) exists to catch.
    const testScript = path.join(makeTmpDir(), "test.js");
    fs.writeFileSync(
      testScript,
      [
        "const fs = require('node:fs');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('MUTATED_A')) {",
        "  fs.writeFileSync('second.js', 'CORRUPTED\\n');",
        "}",
        "const { isPositive } = require(process.cwd() + '/fixture.js');",
        "process.exit(isPositive(5) === true ? 0 : 1);",
        "",
      ].join("\n"),
    );

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false; // MUTATED_A"),
          replaceMutant(2, "  return n * 9;", "second.js"),
        ],
        {
          testCommand: `node ${JSON.stringify(testScript)}`,
          preCommand: "true",
        },
      ),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_not_restored");
    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].reason).toBe("target_not_restored");
    // The shared clause `restoreFailedRebuildClause` appends, naming the
    // stale-build risk: present on the per-mutant warning this fix
    // targets.
    expect(result.results[1].warnings.join(" ")).toContain(
      "rebuild it by hand before trusting it",
    );
    // The fix only appends to the per-mutant warning above; top-level
    // `warnings` stays exactly as it was before this fix (empty here).
    expect(result.warnings).toEqual([]);
  }, 30000);

  it("runs --pre baseline+N+1 times with exactly one success notice, leaving a build marker matching the restored source", async () => {
    useLockDir();
    const { repo } = initRepo();
    const markerPath = path.join(repo, "dist-marker.js");
    const counterFile = path.join(makeTmpDir(), "counter.txt");
    fs.writeFileSync(counterFile, "0");
    const preCommand = `cp fixture.js dist-marker.js && ${counterScript(counterFile)}`;

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ],
        { preCommand },
      ),
    );

    expect(result.status).toBe("killed");
    expect(result.summary.killed).toBe(2);
    // baseline (1) + 2 mutants (1 each) + the final rebuild (1) = 4.
    expect(fs.readFileSync(counterFile, "utf8")).toBe("4");
    const successNotices = result.warnings.filter((w) =>
      w.includes(
        "--pre was re-run after the last mutant was restored and exited 0",
      ),
    );
    expect(successNotices).toHaveLength(1);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(FIXTURE_JS);
    // The rebuild's own log path is folded into the envelope's
    // `dryRunLogPaths` -- for a plan that runs clean to completion (no
    // setup refusal seeding it), this array holds exactly the rebuild's
    // log and nothing else, so it is distinct from the baseline's own
    // log and from every mutant's own `test.logPath`, and it exists on
    // disk. Dropping the `setupLogPaths.push(rebuildLogPath)` call this
    // asserts leaves `dryRunLogPaths` undefined here instead.
    expect(result.dryRunLogPaths).toBeDefined();
    expect(result.dryRunLogPaths).toHaveLength(1);
    const rebuildLogPath = (result.dryRunLogPaths ?? [])[0];
    expect(rebuildLogPath).not.toBe(result.baseline?.logPath);
    for (const r of result.results) {
      expect(rebuildLogPath).not.toBe(r.test?.logPath);
    }
    expect(fs.existsSync(rebuildLogPath)).toBe(true);
  }, 30000);

  it("a --pre that fails only on its last (rebuild) invocation leaves the plan's own status/summary unchanged and warns of the stale risk with a log path", async () => {
    useLockDir();
    const { repo } = initRepo();
    const counterFile = path.join(makeTmpDir(), "counter.txt");
    fs.writeFileSync(counterFile, "0");
    const failScript = path.join(makeTmpDir(), "fail-last.js");
    fs.writeFileSync(
      failScript,
      [
        "const fs = require('fs');",
        `const counterFile = ${JSON.stringify(counterFile)};`,
        "const n = Number(fs.readFileSync(counterFile, 'utf8')) + 1;",
        "fs.writeFileSync(counterFile, String(n));",
        // baseline (1) + 2 mutants = invocations 1-3 succeed; the 4th
        // (the final rebuild) is the only one that fails.
        "if (n >= 4) process.exit(1);",
        "",
      ].join("\n"),
    );

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ],
        { preCommand: `node ${JSON.stringify(failScript)}` },
      ),
    );

    expect(result.status).toBe("killed");
    expect(result.summary.killed).toBe(2);
    expect(fs.readFileSync(counterFile, "utf8")).toBe("4");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(
            "--pre was re-run after the last mutant was restored but",
          ) && w.includes("may still be stale, see"),
      ),
    ).toBe(true);
    // The rebuild's own log path is folded into `dryRunLogPaths`
    // even when that rebuild itself failed -- `runFinalRebuild` returns
    // `{ logPath }` on both branches, and the warning above already
    // names the same path, so this asserts the envelope carries it too.
    expect(result.dryRunLogPaths).toBeDefined();
    expect(result.dryRunLogPaths).toHaveLength(1);
    const rebuildLogPath = (result.dryRunLogPaths ?? [])[0];
    expect(rebuildLogPath).not.toBe(result.baseline?.logPath);
    for (const r of result.results) {
      expect(rebuildLogPath).not.toBe(r.test?.logPath);
    }
    expect(fs.existsSync(rebuildLogPath)).toBe(true);
    expect(result.warnings.some((w) => w.includes(rebuildLogPath))).toBe(true);
  }, 30000);

  it("under -i worktree, no rebuild notice is printed and the original tree's build output is never touched", async () => {
    useLockDir();
    const { repo } = initRepo();
    const markerPath = path.join(repo, "dist-marker.js");

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ],
        { isolation: "worktree", preCommand: "cp fixture.js dist-marker.js" },
      ),
    );

    expect(result.status).toBe("killed");
    expect(
      result.warnings.some((w) =>
        w.includes("--pre was re-run after the last mutant was restored"),
      ),
    ).toBe(false);
    // `-i worktree`'s `--pre` only ever ran against the worktree's own
    // copy: the original tree never gets this file at all.
    expect(fs.existsSync(markerPath)).toBe(false);
  }, 30000);

  it("a mutant_not_applicable outcome runs --pre once (the baseline only) and emits no rebuild notice", async () => {
    useLockDir();
    const { repo } = initRepo();
    const counterFile = path.join(makeTmpDir(), "counter.txt");
    fs.writeFileSync(counterFile, "0");

    const result = await probePlan(
      planOptions(
        repo,
        // Line 99 does not exist: the dry run fails before anything is
        // ever applied to the tree (`prepareMutant`'s own validation,
        // never `runMutantAttempt`).
        [replaceMutant(99, "  return false;")],
        { preCommand: counterScript(counterFile) },
      ),
    );

    expect(result.results[0].reason).toBe("mutant_not_applicable");
    // Only the shared baseline ever invoked `--pre`: nothing this plan
    // applied ever reached the tree, so there is no stale build output
    // for the final rebuild to fix, and it does not run.
    expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
    expect(
      result.warnings.some((w) =>
        w.includes("--pre was re-run after the last mutant was restored"),
      ),
    ).toBe(false);
  }, 30000);

  it("a real git-apply failure (exit code, not timeout/abort) is also mutant_not_applicable and does not trigger the rebuild", async () => {
    useLockDir();
    const { repo } = initRepo();
    const counterFile = path.join(makeTmpDir(), "counter.txt");
    fs.writeFileSync(counterFile, "0");
    const patchPath = realDiffPatch(
      repo,
      "fixture.js",
      FIXTURE_JS.replace("  return n > 0;", "  return n >= 0;"),
    );
    vi.mocked(applyPatchForReal).mockImplementationOnce(
      async (_p, _r, logDir) => ({
        exitCode: 1,
        durationMs: 5,
        stdout: "",
        stderr: "error: patch does not apply",
        logPath: path.join(logDir, "apply.log"),
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        logWriteFailed: false,
        stdioClosed: true,
      }),
    );

    const result = await probePlan(
      planOptions(repo, [{ file: "fixture.js", form: "patch", patchPath }], {
        preCommand: counterScript(counterFile),
      }),
    );

    expect(result.results[0].reason).toBe("mutant_not_applicable");
    // The real apply itself was attempted (and failed) after the dry
    // run succeeded, but the mutant's own `--pre`/test phase never ran:
    // only the baseline's one call happened.
    expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
    expect(
      result.warnings.some((w) =>
        w.includes("--pre was re-run after the last mutant was restored"),
      ),
    ).toBe(false);
  }, 30000);

  it("a plan whose first mutant applies and whose second is mutant_not_applicable still runs the rebuild exactly once", async () => {
    useLockDir();
    const { repo } = initRepo();
    const counterFile = path.join(makeTmpDir(), "counter.txt");
    fs.writeFileSync(counterFile, "0");

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          // Line 99 does not exist: the dry run refuses before this
          // mutant's own `--pre`/test phase ever runs (same shape as
          // the mutant_not_applicable-outcome test above), so
          // `anyMutantApplied` must come from the FIRST mutant alone.
          replaceMutant(99, "  return false;"),
        ],
        { preCommand: counterScript(counterFile) },
      ),
    );

    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].reason).toBe("mutant_not_applicable");
    // baseline (1) + mutant 1's own --pre (1) + the final rebuild (1) =
    // 3; mutant 2 never calls --pre at all (its dry run refuses first).
    expect(fs.readFileSync(counterFile, "utf8")).toBe("3");
    const successNotices = result.warnings.filter((w) =>
      w.includes(
        "--pre was re-run after the last mutant was restored and exited 0",
      ),
    );
    expect(successNotices).toHaveLength(1);
    expect(result.dryRunLogPaths).toBeDefined();
    expect(result.dryRunLogPaths).toHaveLength(1);
  }, 30000);

  it("with --pre, an aborted library-mode plan run warns the build output may be stale instead of rebuilding or staying silent", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const logDir = makeTmpDir();
    const ready = path.join(repo, "ready.txt");
    const markerPath = path.join(repo, "dist-marker.js");

    // Same shape as `probe.test.ts`'s own aborted-library-mode test:
    // only the mutant-phase test (its content carries SLOW_MARKER)
    // signals readiness and then hangs until interrupted.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) {",
        "  fs.writeFileSync('ready.txt', 'go');",
        "  setTimeout(() => { process.exit(0); }, 10000);",
        "} else { process.exit(0); }",
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
      "slow test",
    ]);

    // A library caller with `--pre`: stands in for a rebuild step, same
    // as the other rebuild tests in this file (`cp fixture.js
    // dist-marker.js`). Its own last run, before the mutant's test hung
    // and was interrupted, wrote `dist-marker.js` from the MUTATED
    // source -- exactly the stale build output the aborted-path warning
    // this test targets exists to name, now reached through
    // `probePlan`'s own pipeline (`finalRebuildOrWarn` shared with the
    // single probe).
    const scriptPath = path.join(makeTmpDir(), "library-plan-pre.mjs");
    fs.writeFileSync(
      scriptPath,
      [
        `import { probePlan } from ${JSON.stringify(pathToFileURL(DIST_INDEX).href)};`,
        "const result = await probePlan({",
        "  mutants: [",
        '    { file: "fixture.js", line: 2, form: "replace", replaceText: "  return false; // SLOW_MARKER" },',
        "  ],",
        '  testCommand: "node fixture.test.js",',
        '  preCommand: "cp fixture.js dist-marker.js",',
        '  isolation: "inplace",',
        '  expect: "fail",',
        `  cwd: ${JSON.stringify(repo)},`,
        `  logDir: ${JSON.stringify(logDir)},`,
        "});",
        "process.stdout.write(JSON.stringify(result));",
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [scriptPath], {
      cwd: repo,
      env: { ...process.env, AGENT_PRIMITIVES_LOCK_DIR: lockDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const deadline = Date.now() + 20000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("the mutant-phase test never signalled readiness");
      }
      await sleep(50);
    }
    // The mutant's own `--pre` already ran (before its test started and
    // hung) by the time `ready.txt` exists: the marker now carries the
    // mutated source, not the original.
    const markerAtSignalTime = fs.readFileSync(markerPath, "utf8");
    expect(markerAtSignalTime).toContain("SLOW_MARKER");

    child.kill("SIGTERM");
    const [code, signal] = await new Promise<
      [number | null, NodeJS.Signals | null]
    >((resolve) => {
      child.on("close", (c, sig) => resolve([c, sig]));
    });

    expect(signal).toBeNull();
    expect(code).toBe(0);

    const result = JSON.parse(stdout) as ProbePlanResult;
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    // The target itself IS restored (this run's normal restore-on-abort
    // path), but the rebuild the signal check skips never ran, so this
    // must warn rather than either (a) claiming success it never
    // measured, or (b) staying silent about a build artifact that still
    // holds the mutant.
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(
      result.warnings.some((w) =>
        w.includes("--pre was re-run after the last mutant was restored"),
      ),
    ).toBe(false);
    expect(
      result.warnings.some((w) =>
        w.includes(
          "The working tree's build output may still be built from the mutant",
        ),
      ),
    ).toBe(true);
    // The build artifact was never touched by a rebuild: it still holds
    // exactly what the mutant's own `--pre` last wrote.
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerAtSignalTime);
    expect(fs.readFileSync(markerPath, "utf8")).toContain("SLOW_MARKER");
  }, 60000);
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
    // A mutant the plan never reached carries no `mutation_probe` at
    // all (never attempted, so no verdict to report an `expectation`
    // about). This pins the envelope shape of a `not_run` entry, not
    // the expectation logic in step.ts, which this path never reaches.
    expect(result.results[0].mutation_probe).toBeUndefined();
    expect(result.results[1].mutation_probe).toBeUndefined();
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
      build_failed: 0,
      met: 0,
      violated: 0,
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

/** A patch whose applied result is "the target file no longer exists",
 * produced by git itself (`git rm` plus `git diff --cached`) and with
 * the working tree and index restored afterwards, so the plan under
 * test still sees the original committed content. The same helper
 * `probe.test.ts` uses for the single-probe deletion tests. */
function deletionPatch(repo: string, relPath: string): string {
  const abs = path.join(repo, relPath);
  const original = fs.readFileSync(abs, "utf8");
  git(repo, ["rm", "-q", "--", relPath]);
  const diff = gitOutput(repo, ["diff", "--cached", "--", relPath]);
  git(repo, ["checkout", "HEAD", "--", relPath]);
  expect(fs.readFileSync(abs, "utf8")).toBe(original);
  expect(diff).not.toBe("");
  const patchPath = path.join(makeTmpDir(), "delete.patch");
  fs.writeFileSync(patchPath, diff);
  return patchPath;
}

describe("probePlan(): a -p mutant that deletes the whole target file", () => {
  for (const isolation of ["inplace", "worktree"] as const) {
    it(`runs a deletion mutant beside an ordinary replace mutant on the same file under --isolation ${isolation}: both classify, the deletion reports mutant.deleted, and the file is back before the next mutant is computed`, async () => {
      useLockDir();
      const { repo } = initRepo();
      const target = path.join(repo, "fixture.js");
      const before = fs.readFileSync(target, "utf8");
      const beforeHash = await sha256File(target);
      const patchPath = deletionPatch(repo, "fixture.js");

      const result = await probePlan(
        planOptions(
          repo,
          [
            { file: "fixture.js", form: "patch", patchPath },
            replaceMutant(2, "  return false;"),
          ],
          { isolation },
        ),
      );

      expect(result.status).toBe("killed");
      expect(result.summary.killed).toBe(2);
      const [deletion, replace] = result.results;
      expect(deletion.status).toBe("killed");
      expect(deletion.mutant?.deleted).toBe(true);
      expect(deletion.mutant?.line).toBe(1);
      expect(deletion.mutant?.after).toBe("");
      expect(deletion.mutation_probe?.mutant).toContain("(whole file deleted)");
      expect(deletion.mutation_probe?.restored_verified).toBe(true);
      // The second mutant is computed and applied only against a
      // target the plan has proved is back at its pre-mutation
      // content (I2), which a deletion whose restore did not recreate
      // the file could never satisfy: `before` here is the ORIGINAL
      // line 2, not anything the deletion left behind.
      expect(replace.status).toBe("killed");
      expect(replace.reason).toBeUndefined();
      expect(replace.mutant?.before).toBe("  return n > 0;");
      expect(replace.mutant?.deleted).toBeUndefined();
      expect(await sha256File(target)).toBe(beforeHash);
      expect(fs.readFileSync(target, "utf8")).toBe(before);
      // Tracked paths only: `-i inplace` runs the fixture's test
      // command in the repository itself, which writes its own
      // untracked `runs.txt` there by design.
      expect(
        gitOutput(repo, ["status", "--porcelain", "--untracked-files=no"]),
      ).toBe("");
    }, 60000);
  }
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

  it("refuses a test command that escapes -i worktree's isolation copy, with every mutant not_run, and leaves no worktree, lock, or marker behind", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ],
        {
          isolation: "worktree",
          testCommand: `cd ${repo} && node fixture.test.js`,
        },
      ),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    expect(result.warnings.join(" ")).toContain(repo);
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    // The plan side of this refusal is pinned the same way as the
    // single-probe side (`probe-refusal-contract.test.ts`): not only
    // the reason, but that no worktree, lock, or marker was left
    // behind.
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("refuses a --plan file's own `link` entry naming a directory that does not exist, naming it as given, the resolved path against the repository root, and the plan file, with nothing left behind (#242)", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const planPath = writePlan({
      test: "node fixture.test.js",
      link: ["nope"],
      mutants: [{ file: "fixture.js", line: 2, replace: "  return false;" }],
    });
    const parsed = parsePlanFile(planPath);
    if (!parsed.ok) throw new Error("test setup: plan file failed to parse");

    const result = await probePlan(
      planOptions(repo, [replaceMutant(2, "  return false;")], {
        planLinks: parsed.plan.link ?? [],
        planPath,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("link_source_not_found");
    const message = result.warnings.join(" ");
    expect(message).toContain('"nope"');
    expect(message).toContain(path.join(repo, "nope"));
    expect(message).toContain("the repository root");
    expect(message).toContain(`named in the "link" list of ${planPath}`);
    // The remedy end to end: create it, or remove the entry from the
    // plan file that named it.
    expect(message).toContain(
      `create it, or remove the entry from ${planPath}`,
    );
    expectNoIsolationLeftovers(repo, lockDir);
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
    expect(result.expectation).toBeUndefined();
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  }, 30000);
});

/**
 * Makes exec call number `signalAtCall` (1-based) land a signal on the
 * run AFTER its own command has finished, with a result that is NOT
 * itself aborted: the shape where the run's crash handler is already
 * handling a signal (`crashHandlers.isHandling()` is true) while the
 * phase in hand reports some other outcome. The handler is the very
 * SIGTERM listener this run installed, called directly rather than by
 * signalling this test process (which would also reach vitest's own
 * handlers, see the I5 test below); library mode, so it restores and
 * releases the lock but never exits. Returns how many exec calls ran.
 */
async function signalAfterExecCall(
  signalAtCall: number,
  run: () => Promise<ProbePlanResult>,
): Promise<{ result: ProbePlanResult; calls: number }> {
  const actualExec =
    await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
  const before = new Set(process.listeners("SIGTERM"));
  let calls = 0;
  let signalled = false;
  vi.mocked(execCommand).mockImplementation(
    async (...args: Parameters<typeof execCommand>) => {
      calls += 1;
      const result = await actualExec.execCommand(...args);
      if (calls === signalAtCall) {
        const ours = process
          .listeners("SIGTERM")
          .filter((listener) => !before.has(listener));
        expect(ours).toHaveLength(1);
        (ours[0] as (signal: NodeJS.Signals) => void)("SIGTERM");
        signalled = true;
      }
      return result;
    },
  );
  try {
    const result = await run();
    expect(signalled).toBe(true);
    // The handler finishes on its own schedule; let it settle before the
    // caller inspects the files it may also have written.
    await sleep(100);
    return { result, calls };
  } finally {
    vi.mocked(execCommand).mockImplementation(actualExec.execCommand);
  }
}

describe("probePlan(): a stopped run never starts the next mutant (I5)", () => {
  it("ends the plan aborted when the signal handler is already handling a signal by the time a mutant turns out not to be applicable", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    vi.mocked(computeMutant).mockClear();

    // Call 1 is the baseline: it passes, and the signal lands right after
    // it. The first mutant replaces line 2 with itself, so it is refused
    // before anything is applied, for a reason that is not `aborted`.
    const { result, calls } = await signalAfterExecCall(1, () =>
      probePlan(
        planOptions(repo, [
          replaceMutant(2, "  return n > 0;"),
          replaceMutant(5, "  return true;"),
        ]),
      ),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["inconclusive", "mutant_not_applicable"],
      ["not_run", undefined],
    ]);
    expect(vi.mocked(computeMutant)).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 30000);

  it("ends the plan aborted when the signal handler is already handling a signal after a mutant whose own outcome was not aborted", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    vi.mocked(computeMutant).mockClear();

    // Call 1 is the baseline, call 2 the first mutant's own test run: it
    // fails (the mutant is caught), and the signal lands right after it.
    const { result, calls } = await signalAfterExecCall(2, () =>
      probePlan(
        planOptions(repo, [
          replaceMutant(2, "  return false;"),
          replaceMutant(5, "  return true;"),
        ]),
      ),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    // The first mutant's own verdict stands; the second is never started.
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["killed", undefined],
      ["not_run", undefined],
    ]);
    expect(result.results[0].mutation_probe?.restored_verified).toBe(true);
    expect(vi.mocked(computeMutant)).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 30000);

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
    // The middle mutant is the in-flight one this test drives into the
    // emergency-restore path; a `patch` form (rather than `replace`,
    // used for the other two) is what gives it its own non-empty `logs`
    // to assert (`replace`/`match` never produce a dry-run log at all,
    // per `computeMutant`), applied via `git apply` directly (not
    // `execCommand`, so it does not shift which invocation the mock
    // below throws on).
    const patchPath = realDiffPatch(
      repo,
      "fixture.js",
      FIXTURE_JS.replace("  return n < 0;", "  return true;"),
    );
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
        { file: "fixture.js", form: "patch", patchPath },
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
      build_failed: 0,
      met: 1,
      violated: 0,
    });
    // The baseline is still reported, and so is the log path of the
    // baseline run, which the emergency path used to drop.
    expect(result.baseline?.exitCode).toBe(0);
    expect(typeof result.baseline?.logPath).toBe("string");
    expect(fs.existsSync(result.baseline?.logPath ?? "")).toBe(true);
    // The in-flight (second) mutant's own dry-run logs (its `patch`
    // form's numstat and dry-run `git apply`, computed before the
    // mutant was ever applied) are carried on its own result rather
    // than dropped by the emergency path, the same way the baseline's
    // own log path above survives it.
    expect(result.results[1].logs.length).toBeGreaterThan(0);
    for (const logPath of result.results[1].logs) {
      expect(fs.existsSync(logPath)).toBe(true);
    }
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

/**
 * Reproduces (and pins the absence of) a discrepancy a reviewer once
 * reported: inside a `probe --plan` batch, a mutant declared
 * `expect: "pass"` came back `killed`, while the identical single-mutant
 * `-p`/`-r` invocation came back `survived` for the same mutant --
 * standalone runs were treated as authoritative. `runMutantAttempt`'s
 * classify step (`step.ts`) is shared verbatim between `probe()` and
 * `probePlan()` (see `probePlan`'s own docblock, invariant I6), so this
 * suite's job is to prove that sharing actually holds for every
 * `killed`/`survived` combination `expect` can produce, not just the one
 * this file's other tests already exercise.
 *
 * A first investigation (see this package's own CHANGELOG, 0.2.0)
 * found no divergence between `probe()` and `probePlan()`: both already
 * agreed in all four combinations below. The report recurred anyway
 * (see the CHANGELOG's current Unreleased entry): `killed`/`survived`
 * used to report whether the mutant's outcome MATCHED `--expect`, not
 * the outcome itself, so a reader who did not already know `--expect`
 * misread a `killed` `expect: "pass"` mutant as one the suite caught.
 * `killed`/`survived` now always report the actual, measured outcome
 * (independent of `--expect`) and a new `mutation_probe.expectation`
 * (`"met"`/`"violated"`) carries the match; the combinations below are
 * updated for that, and this suite's job -- single and plan agree -- is
 * unchanged.
 */
describe("probe() and probePlan(): the same mutant and expectation produce the same verdict (parity)", () => {
  const CAUGHT_LINE = 2;
  const CAUGHT_REPLACEMENT = "  return false;";
  // The suite asserts nothing about the `extra` key this adds, so the
  // mutant leaves every assertion in FIXTURE_TEST_JS passing -- the
  // same "leaves tests green" mutant `probePlan()`'s own
  // "honours a per-mutant expect" test above already relies on.
  const UNCAUGHT_LINE = 7;
  const UNCAUGHT_REPLACEMENT =
    "module.exports = { isPositive, isNegative, extra: 1 };";

  async function runSingle(
    repo: string,
    line: number,
    replaceText: string,
    expectVerdict: ExpectVerdict,
  ) {
    return probe({
      file: "fixture.js",
      line,
      form: "replace",
      replaceText,
      testCommand: "node fixture.test.js",
      isolation: "inplace",
      expect: expectVerdict,
      cwd: repo,
      logDir: makeTmpDir(),
    });
  }

  async function runPlan(
    repo: string,
    line: number,
    replaceText: string,
    expectVerdict: ExpectVerdict,
  ) {
    return probePlan(
      planOptions(repo, [replaceMutant(line, replaceText)], {
        expect: expectVerdict,
      }),
    );
  }

  it("expect: fail, mutant the suite catches -- killed in both, expectation met", async () => {
    useLockDir();
    const single = await runSingle(
      initRepo().repo,
      CAUGHT_LINE,
      CAUGHT_REPLACEMENT,
      "fail",
    );
    const plan = await runPlan(
      initRepo().repo,
      CAUGHT_LINE,
      CAUGHT_REPLACEMENT,
      "fail",
    );
    expect(single.status).toBe("killed");
    expect(single.mutation_probe?.expectation).toBe("met");
    expect(plan.results[0].status).toBe("killed");
    expect(plan.results[0].mutation_probe?.expectation).toBe("met");
    expect(plan.results[0].status).toBe(single.status);
  }, 30000);

  it("expect: fail, mutant the suite does not catch -- survived in both, expectation violated", async () => {
    useLockDir();
    const single = await runSingle(
      initRepo().repo,
      UNCAUGHT_LINE,
      UNCAUGHT_REPLACEMENT,
      "fail",
    );
    const plan = await runPlan(
      initRepo().repo,
      UNCAUGHT_LINE,
      UNCAUGHT_REPLACEMENT,
      "fail",
    );
    expect(single.status).toBe("survived");
    expect(single.mutation_probe?.expectation).toBe("violated");
    expect(plan.results[0].status).toBe("survived");
    expect(plan.results[0].mutation_probe?.expectation).toBe("violated");
    expect(plan.results[0].status).toBe(single.status);
  }, 30000);

  it("expect: pass, mutant the suite does not catch (matches the expectation) -- survived in both, expectation met -- the exact shape the reviewer reported disagreeing", async () => {
    useLockDir();
    const single = await runSingle(
      initRepo().repo,
      UNCAUGHT_LINE,
      UNCAUGHT_REPLACEMENT,
      "pass",
    );
    const plan = await runPlan(
      initRepo().repo,
      UNCAUGHT_LINE,
      UNCAUGHT_REPLACEMENT,
      "pass",
    );
    // The suite does not catch this mutant, so its actual outcome is
    // `survived` regardless of `--expect` -- what used to come back
    // `killed` (the old, expectation-matched label) is exactly the
    // report a reader misread.
    expect(single.status).toBe("survived");
    expect(single.mutation_probe?.expectation).toBe("met");
    expect(plan.results[0].status).toBe("survived");
    expect(plan.results[0].mutation_probe?.expectation).toBe("met");
    expect(plan.results[0].status).toBe(single.status);
  }, 30000);

  it("expect: pass, mutant the suite catches (breaks the expectation) -- killed in both, expectation violated", async () => {
    useLockDir();
    const single = await runSingle(
      initRepo().repo,
      CAUGHT_LINE,
      CAUGHT_REPLACEMENT,
      "pass",
    );
    const plan = await runPlan(
      initRepo().repo,
      CAUGHT_LINE,
      CAUGHT_REPLACEMENT,
      "pass",
    );
    // The suite catches this mutant, so its actual outcome is `killed`
    // regardless of `--expect` -- `--expect pass` wanted the opposite,
    // so the expectation is violated.
    expect(single.status).toBe("killed");
    expect(single.mutation_probe?.expectation).toBe("violated");
    expect(plan.results[0].status).toBe("killed");
    expect(plan.results[0].mutation_probe?.expectation).toBe("violated");
    expect(plan.results[0].status).toBe(single.status);
  }, 30000);

  it("a mutant's own `expect` overrides the plan-level default (plan-level fail, mutant-level pass) -- agrees with the single `--expect pass` run", async () => {
    useLockDir();
    const single = await runSingle(
      initRepo().repo,
      UNCAUGHT_LINE,
      UNCAUGHT_REPLACEMENT,
      "pass",
    );
    const plan = await probePlan(
      planOptions(
        initRepo().repo,
        [
          {
            ...replaceMutant(UNCAUGHT_LINE, UNCAUGHT_REPLACEMENT),
            expect: "pass",
          },
        ],
        { expect: "fail" },
      ),
    );
    expect(single.status).toBe("survived");
    expect(single.mutation_probe?.expectation).toBe("met");
    expect(plan.results[0].status).toBe("survived");
    expect(plan.results[0].mutation_probe?.expectation).toBe("met");
    expect(plan.results[0].status).toBe(single.status);
  }, 30000);

  it("expect: fail, mutant the suite catches, via a real -p/--patch (not just -r/--replace) -- killed in both", async () => {
    useLockDir();
    const editedFixture = FIXTURE_JS.split("\n")
      .map((textLine, i) =>
        i === CAUGHT_LINE - 1 ? CAUGHT_REPLACEMENT : textLine,
      )
      .join("\n");

    const singleRepo = initRepo().repo;
    const singlePatchPath = realDiffPatch(
      singleRepo,
      "fixture.js",
      editedFixture,
    );
    const single = await probe({
      file: "fixture.js",
      form: "patch",
      patchPath: singlePatchPath,
      testCommand: "node fixture.test.js",
      isolation: "inplace",
      expect: "fail",
      cwd: singleRepo,
      logDir: makeTmpDir(),
    });

    const planRepo = initRepo().repo;
    const planPatchPath = realDiffPatch(planRepo, "fixture.js", editedFixture);
    const plan = await probePlan(
      planOptions(
        planRepo,
        [{ file: "fixture.js", form: "patch", patchPath: planPatchPath }],
        { expect: "fail" },
      ),
    );

    expect(single.status).toBe("killed");
    expect(plan.results[0].status).toBe("killed");
    expect(plan.results[0].status).toBe(single.status);
  }, 30000);
});

// --- `--require-baseline-evidence` threaded through `probePlan`'s own
// setup. A plan runs every mutant against ONE shared baseline, so there
// is no second source for this value to conflict with. Mirrors
// `test/probe-zero-tests.test.ts`'s "generic byte-identical fallback,
// --require-baseline-evidence opt-out" describe block, for the plan
// path. -----------------------------------------------------------------

// `initNodeTestDotRepo` lives in ./helpers/node-test-dot-repo.ts, shared
// with test/probe-zero-tests.test.ts's own use of it (this suite's `git`
// helper is not used by the shared builder, which shells out to git
// directly the same way both call sites always have).

/** Mutates only the untested `unused` function, so the dot reporter's
 * `..` output is unaffected either way: a genuine, legitimate survivor. */
function dotReporterPlanOptions(
  repo: string,
  overrides: Partial<ProbePlanOptions> = {},
): ProbePlanOptions {
  return planOptions(
    repo,
    [
      {
        file: "calc.js",
        line: 5,
        form: "replace",
        replaceText: "  return a - b;",
      },
    ],
    {
      testCommand: "node --test --test-reporter=dot calc.test.js",
      ...overrides,
    },
  );
}

describe("probePlan(): zero-tests-executed detection through the shared baseline", () => {
  it("without --require-baseline-evidence, a genuine dot-reporter survivor is read as inconclusive/no_tests_executed by design, per mutant", async () => {
    useLockDir();
    const repo = initNodeTestDotRepo(makeTmpDir);

    const result = await probePlan(dotReporterPlanOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_inconclusive");
    expect(result.results[0].status).toBe("inconclusive");
    expect(result.results[0].reason).toBe("no_tests_executed");
    expect(result.results[0].mutation_probe?.result).toBe("not_run");
  }, 30000);

  it("with a matching --require-baseline-evidence, the same dot-reporter survivor stays survived, not second-guessed", async () => {
    useLockDir();
    const repo = initNodeTestDotRepo(makeTmpDir);

    const result = await probePlan(
      dotReporterPlanOptions(repo, { requireBaselineEvidence: /\.\./ }),
    );

    expect(result.status).toBe("survived");
    expect(result.results[0].status).toBe("survived");
    expect(result.results[0].reason).toBeUndefined();
  }, 30000);

  it("a non-matching --require-baseline-evidence refuses the whole plan at the top level, before any mutant is reached", async () => {
    // Round-2 review survivor: disabling this wiring (forcing
    // `requireBaselineEvidenceMatched: true` regardless of what the
    // caller passed) left a genuine survivor with no opt-out under
    // `--plan`, and no test caught it. This is the mirror case: a
    // regex that genuinely does not match must still refuse, at the
    // PLAN's own top level (the unremapped `inconclusive`/
    // `baseline_evidence_not_matched` pair, the same as `baseline_failed`
    // is for a plan -- see docs/probe.md's `--plan` section), with every
    // mutant reported `not_run`.
    useLockDir();
    const repo = initNodeTestDotRepo(makeTmpDir);

    const result = await probePlan(
      dotReporterPlanOptions(repo, {
        requireBaselineEvidence: /this text never appears/,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_evidence_not_matched");
    expect(result.results.map((r) => r.status)).toEqual(["not_run"]);
  }, 30000);

  it("a truncated baseline tail that missed the pattern names the truncation in the warning", async () => {
    // Plan-path twin of `probe-zero-tests.test.ts`'s "a truncated
    // baseline tail that missed the pattern names the truncation in
    // the warning" (`setup.ts`'s `--require-baseline-evidence` check is
    // shared by `probe()` and `probePlan()`, so the same truncation
    // note applies here): a pattern printed first, then scrolled out
    // of the captured tail (`exec.ts`'s 60-line/6000-char bound) by 120
    // filler lines, must not read as a plain miss without the warning
    // naming the truncation.
    useLockDir();
    const repo = initNodeTestDotRepo(makeTmpDir);
    const fillerLines = Array.from(
      { length: 120 },
      (_, i) => `console.log('filler line ${i}');`,
    ).join(" ");

    const result = await probePlan(
      dotReporterPlanOptions(repo, {
        testCommand: `node -e "console.log('EVIDENCE-LINE'); ${fillerLines}"`,
        requireBaselineEvidence: /EVIDENCE-LINE/,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_evidence_not_matched");
    expect(
      result.warnings.some((w) => /captured stdout tail was truncated/.test(w)),
    ).toBe(true);
  }, 30000);
});

describe("plan.passWhen.regex: the plan-file equivalent of --pass-regex", () => {
  it("parses to a RegExp on plan.passRegex", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        passWhen: { regex: "^OK \\(" },
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.passRegex).toBeInstanceOf(RegExp);
    expect(parsed.plan.passRegex?.source).toBe("^OK \\(");
    // Compiled through the same shared `compilePassRegex` `cli.ts` uses
    // for `--pass-regex`, so `^`/`$` anchor per line, not only to the
    // whole combined buffer (see `pass-regex.ts`'s own docblock).
    expect(parsed.plan.passRegex?.flags).toBe("m");
  });

  it("an invalid regex is plan_invalid, naming plan.passWhen.regex", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        passWhen: { regex: "(" },
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.passWhen.regex");
  });

  it("an unknown passWhen key, or a non-object passWhen, is plan_invalid rather than silently ignored", () => {
    const extraKey = parsePlanFile(
      writePlan({
        test: "npm test",
        passWhen: { regex: "OK", flags: "i" },
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(extraKey.ok).toBe(false);
    if (!extraKey.ok) {
      expect(extraKey.reason).toBe("plan_invalid");
      expect(extraKey.message).toContain("plan.passWhen.flags");
    }

    const notObject = parsePlanFile(
      writePlan({
        test: "npm test",
        passWhen: "OK",
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) {
      expect(notObject.reason).toBe("plan_invalid");
      expect(notObject.message).toContain("plan.passWhen");
    }
  });

  it("a missing (non-string) regex field is plan_invalid", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        passWhen: {},
        mutants: [{ file: "a.ts", line: 1, replace: "x" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.passWhen.regex");
  });
});

describe("probePlan(): --pass-regex, threaded through the shared baseline and every mutant", () => {
  // Same fake phpunit-style runner as `probe.test.ts`'s own --pass-regex
  // describe block (GitHub issue #225): a green suite that still exits 1
  // over deprecation notices.
  const RUNNER_JS = [
    "function summary() {",
    '  return "OK (3 tests, 5 assertions)";',
    "}",
    "console.log(summary());",
    "process.exit(1);",
    "",
  ].join("\n");

  function initRunnerRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "runner.js"), RUNNER_JS);
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  function runnerPlanOptions(
    repo: string,
    overrides: Partial<ProbePlanOptions> = {},
  ): ProbePlanOptions {
    return planOptions(
      repo,
      [replaceMutant(2, '  return "FAILURES!";', "runner.js")],
      {
        testCommand: "node runner.js",
        ...overrides,
      },
    );
  }

  it("without passRegex, the plan's shared baseline reports baseline_failed for the whole plan", async () => {
    useLockDir();
    const repo = initRunnerRepo();

    const result = await probePlan(runnerPlanOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
    expect(result.results.map((r) => r.status)).toEqual(["not_run"]);
  });

  it("with passRegex, the shared baseline passes despite exit 1, and the FAILURES! mutant is killed", async () => {
    useLockDir();
    const repo = initRunnerRepo();

    const result = await probePlan(
      runnerPlanOptions(repo, { passRegex: /^OK \(/ }),
    );

    expect(result.baseline?.exitCode).toBe(1);
    expect(result.status).toBe("killed");
    expect(result.results[0].status).toBe("killed");
  });
});

describe("probePlan(): the plan's own top-level status is an expectation aggregate, not the raw per-mutant outcome", () => {
  it("one mutant the suite does not catch under --expect pass: results[0].status is survived/met, but the plan's own top-level status is killed", async () => {
    useLockDir();
    const repo = initRepo().repo;

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(
            7,
            "module.exports = { isPositive, isNegative, extra: 1 };",
          ),
        ],
        { expect: "pass" },
      ),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("survived");
    expect(result.results[0].mutation_probe?.expectation).toBe("met");
    // The plan's own top-level `status` reports whether any mutant's
    // expectation was VIOLATED, not whether any mutant's own outcome
    // was literally `survived` (see the comment above `violatedCount` and
    // `PlanSummaryField`'s `met`/`violated` pair in index.ts, and
    // `docs/probe.md`'s `--plan` Output paragraph): a reader who expects
    // it to mirror `results[0].status` misreads this exact shape, the
    // one a dogfood run once reported as a mismatch. Pinning it here
    // catches a naive "fix" that switches this branch back to the raw
    // `summary.survived` count. The additive top-level `expectation`
    // field spells the same aggregate in the unambiguous `met`/`violated`
    // words instead of reusing `killed`/`survived`.
    expect(result.status).toBe("killed");
    expect(result.expectation).toBe("met");
    expect(result.reason).toBeUndefined();
    expect(result.summary).toMatchObject({
      total: 1,
      killed: 0,
      survived: 1,
      inconclusive: 0,
      not_run: 0,
      build_failed: 0,
      met: 1,
      violated: 0,
    });
  });

  it("one mutant the suite catches under --expect pass: results[0].status is killed/violated, and the plan's own top-level status and expectation are both survived/violated", async () => {
    useLockDir();
    const repo = initRepo().repo;

    const result = await probePlan(
      planOptions(repo, [replaceMutant(2, "  return false;")], {
        expect: "pass",
      }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("killed");
    expect(result.results[0].mutation_probe?.expectation).toBe("violated");
    // The mirror image of the test above: the one mutant this plan ran
    // violated its own `--expect pass`, so the plan's own top-level
    // `status` reads `"survived"` (a finding, exit 1) even though the
    // per-mutant, raw-outcome word for the same mutant is `"killed"`.
    // `expectation` spells the same verdict without reusing that word:
    // reads `"violated"` here, the aggregate `summary.violated` also
    // pins.
    expect(result.status).toBe("survived");
    expect(result.expectation).toBe("violated");
    expect(result.reason).toBeUndefined();
    expect(result.summary).toMatchObject({
      total: 1,
      killed: 1,
      survived: 0,
      inconclusive: 0,
      not_run: 0,
      build_failed: 0,
      met: 0,
      violated: 1,
    });
  });
});

describe("probePlan(): --env NAME=VALUE reaches the baseline and every mutant, the same as the single form", () => {
  const ENV_TEST_COMMAND =
    "node -e \"process.exit(process.env.PROBE_MARKER === '1' ? 0 : 1)\"";

  it("without --env the shared baseline fails; with it, the same command passes and the override is echoed at the plan's own top level and each mutant's test.env", async () => {
    useLockDir();

    const withoutEnv = await probePlan(
      planOptions(initRepo().repo, [replaceMutant(2, "  return n >= 0;")], {
        testCommand: ENV_TEST_COMMAND,
      }),
    );
    expect(withoutEnv.status).toBe("inconclusive");
    expect(withoutEnv.reason).toBe("baseline_failed");
    expect(withoutEnv.results.map((r) => r.status)).toEqual(["not_run"]);

    const withEnv = await probePlan(
      planOptions(initRepo().repo, [replaceMutant(2, "  return n >= 0;")], {
        testCommand: ENV_TEST_COMMAND,
        env: { PROBE_MARKER: "1" },
      }),
    );
    // The command never reads fixture.js, only PROBE_MARKER, so a real
    // verdict (not baseline_failed) proves the baseline itself saw the
    // override; "survived" is the correct verdict for a mutant this
    // command cannot react to (default --expect fail, so this is also a
    // finding).
    expect(withEnv.status).toBe("survived");
    expect(withEnv.results[0].status).toBe("survived");
    expect(withEnv.results[0].test?.env).toEqual({ PROBE_MARKER: "1" });
    // Echoed once at the plan's own top level too, a sibling of
    // `results`/`summary`, the same as the single form's own top-level
    // `env`.
    expect(withEnv.env).toEqual({ PROBE_MARKER: "1" });
  });
});

describe("plan file validation: a test command per mutant", () => {
  it("accepts a per-mutant test beside the plan-level one, and a mutant without one inherits nothing at parse time", () => {
    const parsed = parsePlanFile(
      writePlan({
        test: "npm test",
        mutants: [
          { file: "a.ts", line: 1, replace: "x", test: "npm run test:a" },
          { file: "b.ts", line: 2, replace: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.testCommand).toBe("npm test");
    expect(parsed.plan.mutants[0].testCommand).toBe("npm run test:a");
    // Inheritance is `probePlan`'s (it resolves every mutant's command
    // the same way for a library caller), not the parser's.
    expect(parsed.plan.mutants[1].testCommand).toBeUndefined();
  });

  it("accepts a plan with no plan-level test when every mutant has its own", () => {
    const parsed = parsePlanFile(
      writePlan({
        mutants: [
          { file: "a.ts", line: 1, replace: "x", test: "npm run test:a" },
          { file: "b.ts", line: 2, replace: "y", test: "npm run test:b" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.testCommand).toBeUndefined();
    expect(parsed.plan.mutants.map((m) => m.testCommand)).toEqual([
      "npm run test:a",
      "npm run test:b",
    ]);
  });

  it("refuses a plan without a plan-level test when one mutant has none, naming plan.test and that mutant", () => {
    const planPath = writePlan({
      mutants: [
        { file: "a.ts", line: 1, replace: "x", test: "npm run test:a" },
        { file: "b.ts", line: 2, replace: "y" },
      ],
    });
    const parsed = parsePlanFile(planPath);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.test");
    expect(parsed.message).toContain("plan.mutants[1] has none");
    expect(parsed.message).toContain(planPath);
  });

  it("refuses a non-string or empty per-mutant test, naming the entry", () => {
    for (const test of [42, "", ["npm test"], null]) {
      const parsed = validatePlan(
        {
          test: "npm test",
          mutants: [
            { file: "a.ts", line: 1, replace: "x" },
            { file: "b.ts", line: 2, replace: "y", test },
          ],
        },
        "/plan.json",
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe("plan_invalid");
      expect(parsed.message).toContain(
        "plan.mutants[1].test must be a non-empty string",
      );
    }
  });

  it("a plan-level test that is present but empty is refused as before, even when every mutant has its own", () => {
    const parsed = validatePlan(
      {
        test: "",
        mutants: [{ file: "a.ts", line: 1, replace: "x", test: "npm test" }],
      },
      "/plan.json",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("plan.test must be a non-empty string");
    expect(parsed.message).not.toContain("unless every mutant");
  });
});

describe("probePlan(): one baseline per distinct test command", () => {
  /** Writes `lines` as a script outside the repository and returns the
   * command that runs it: a test command of its own, for a plan naming
   * more than one. */
  function scriptCommand(name: string, lines: string[]): string {
    const scriptPath = path.join(makeTmpDir(), name);
    fs.writeFileSync(scriptPath, lines.join("\n"));
    return `node ${JSON.stringify(scriptPath)}`;
  }

  /** The same suite as `node fixture.test.js` (it appends to `runs.txt`
   * too), plus one line in `b-runs.txt` per invocation: a second test
   * command whose own runs can be counted apart from the first's. */
  function commandB(): string {
    return scriptCommand("b.test.js", [
      "require('node:fs').appendFileSync('b-runs.txt', 'b\\n');",
      "require(process.cwd() + '/fixture.test.js');",
      "",
    ]);
  }

  function linesIn(repo: string, name: string): string[] {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  }

  it("groups three mutants with two commands, the middle one inherited, into two baselines in first-appearance order, run before any mutant", async () => {
    useLockDir();
    const { repo } = initRepo();
    const B = commandB();
    const preCounter = scriptCommand("pre.js", [
      "require('node:fs').appendFileSync('pre-runs.txt', 'p\\n');",
      "",
    ]);
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probePlan(
      planOptions(
        repo,
        [
          {
            ...replaceMutant(2, "  return false;"),
            testCommand: "node fixture.test.js",
          },
          // No command of its own: the plan-level one (B).
          replaceMutant(5, "  return true;"),
          {
            file: "fixture.js",
            line: 2,
            form: "match",
            matchText: "n > 0",
            withText: "n >= 0",
            testCommand: "node fixture.test.js",
          },
        ],
        { testCommand: B, preCommand: preCounter },
      ),
    );

    expect(result.status).toBe("killed");
    expect(
      result.baselines.map((b) => [b.index, b.command, b.status, b.entries]),
    ).toEqual([
      [0, "node fixture.test.js", "passed", [0, 2]],
      [1, B, "passed", [1]],
    ]);
    expect(result.baselines[0].logPath).toBe(result.baseline?.logPath);
    expect(result.baselines[1].exitCode).toBe(0);
    expect(typeof result.baselines[1].logPath).toBe("string");
    expect(result.results.map((r) => r.baseline_index)).toEqual([0, 1, 0]);
    expect(result.results.map((r) => r.test_command)).toEqual([
      "node fixture.test.js",
      B,
      "node fixture.test.js",
    ]);
    expect(result.results.map((r) => r.test?.command)).toEqual([
      "node fixture.test.js",
      B,
      "node fixture.test.js",
    ]);
    expect(result.results.map((r) => r.status)).toEqual([
      "killed",
      "killed",
      "killed",
    ]);
    // Both baselines first (each sees the unmutated line 2), then one
    // run per mutant in plan order.
    expect(runsSeen(repo)).toEqual([
      "  return n > 0;",
      "  return n > 0;",
      "  return false;",
      "  return n > 0;",
      "  return n >= 0;",
    ]);
    // B ran for its baseline and its one mutant, nothing else.
    expect(linesIn(repo, "b-runs.txt")).toHaveLength(2);
    // `--pre` once per baseline, once per mutant, and once to rebuild.
    expect(linesIn(repo, "pre-runs.txt")).toHaveLength(2 + 3 + 1);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  }, 60000);

  it("runs the baselines of three commands in first-appearance order, all before any mutant, with the results in plan order", async () => {
    useLockDir();
    const { repo } = initRepo();
    /** Appends its own name to `order.txt`, then runs the fixture suite. */
    const named = (name: string): string =>
      scriptCommand(`${name}.test.js`, [
        `require('node:fs').appendFileSync('order.txt', '${name}\\n');`,
        "require(process.cwd() + '/fixture.test.js');",
        "",
      ]);
    const [A, B, C] = [named("A"), named("B"), named("C")];

    const result = await probePlan(
      planOptions(
        repo,
        [
          { ...replaceMutant(2, "  return false;"), testCommand: C },
          replaceMutant(5, "  return true;"),
          {
            ...replaceMutant(2, "  return n >= 0;"),
            testCommand: B,
          },
          { ...replaceMutant(5, "  return n > 0;"), testCommand: C },
        ],
        { testCommand: A },
      ),
    );

    expect(result.status).toBe("killed");
    expect(result.baselines.map((b) => [b.command, b.entries])).toEqual([
      [C, [0, 3]],
      [A, [1]],
      [B, [2]],
    ]);
    expect(result.results.map((r) => [r.index, r.baseline_index])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 0],
    ]);
    expect(linesIn(repo, "order.txt")).toEqual([
      "C",
      "A",
      "B",
      "C",
      "A",
      "B",
      "C",
    ]);
  }, 60000);

  it("a command written the same way twice is one group, and so is one that differs only by surrounding whitespace; another spelling is its own group", async () => {
    useLockDir();
    const same = await probePlan(
      planOptions(
        initRepo().repo,
        [
          {
            ...replaceMutant(2, "  return false;"),
            testCommand: "node fixture.test.js",
          },
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node fixture.test.js",
          },
        ],
        { testCommand: undefined },
      ),
    );
    expect(same.status).toBe("killed");
    expect(same.baselines).toHaveLength(1);
    expect(same.results.map((r) => r.baseline_index)).toEqual([0, 0]);

    const trailing = await probePlan(
      planOptions(
        initRepo().repo,
        [
          {
            ...replaceMutant(2, "  return false;"),
            testCommand: "node fixture.test.js",
          },
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node fixture.test.js ",
          },
        ],
        { testCommand: undefined },
      ),
    );
    expect(trailing.baselines).toHaveLength(1);
    expect(trailing.baselines[0].entries).toEqual([0, 1]);
    // The group runs its first spelling, for every mutant in it.
    expect(trailing.results.map((r) => r.test?.command)).toEqual([
      "node fixture.test.js",
      "node fixture.test.js",
    ]);

    const respelled = await probePlan(
      planOptions(
        initRepo().repo,
        [
          {
            ...replaceMutant(2, "  return false;"),
            testCommand: "node fixture.test.js",
          },
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node  fixture.test.js",
          },
        ],
        { testCommand: undefined },
      ),
    );
    expect(respelled.status).toBe("killed");
    expect(respelled.baselines.map((b) => b.command)).toEqual([
      "node fixture.test.js",
      "node  fixture.test.js",
    ]);
    expect(respelled.results.map((r) => r.baseline_index)).toEqual([0, 1]);
  }, 60000);

  it("a failing baseline of a later command marks only that command's mutants not_run with its reason; the others are measured as usual", async () => {
    useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        { ...replaceMutant(5, "  return true;"), testCommand: "exit 3" },
        replaceMutant(
          7,
          "module.exports = { isPositive, isNegative, extra: 1 };",
        ),
      ]),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_inconclusive");
    expect(result.expectation).toBeUndefined();
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["killed", undefined],
      ["not_run", "baseline_failed"],
      ["survived", undefined],
    ]);
    expect(result.results[1].mutation_probe).toBeUndefined();
    expect(result.summary).toEqual({
      total: 3,
      killed: 1,
      survived: 1,
      inconclusive: 0,
      not_run: 1,
      build_failed: 0,
      met: 1,
      violated: 1,
    });
    expect(
      result.baselines.map((b) => [b.status, b.reason, b.exitCode]),
    ).toEqual([
      ["passed", undefined, 0],
      ["failed", "baseline_failed", 3],
    ]);
    // The first command's own baseline plus its two mutants: the failing
    // command's mutant never ran at all.
    expect(runsSeen(repo)).toHaveLength(3);
  }, 60000);

  it("a failing first baseline refuses the plan the way a plan naming one command does, and so does a plan whose every baseline would fail", async () => {
    useLockDir();
    const { repo } = initRepo();
    vi.mocked(computeMutant).mockClear();

    const result = await probePlan(
      planOptions(repo, [
        { ...replaceMutant(2, "  return false;"), testCommand: "exit 1" },
        replaceMutant(5, "  return true;"),
      ]),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
    expect(result.baseline?.exitCode).toBe(1);
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["not_run", undefined],
      ["not_run", undefined],
    ]);
    expect(result.baselines.map((b) => [b.status, b.reason])).toEqual([
      ["failed", "baseline_failed"],
      ["not_run", undefined],
    ]);
    expect(runsSeen(repo)).toEqual([]);
    expect(vi.mocked(computeMutant)).not.toHaveBeenCalled();

    const allFailing = await probePlan(
      planOptions(
        initRepo().repo,
        [
          { ...replaceMutant(2, "  return false;"), testCommand: "exit 1" },
          { ...replaceMutant(5, "  return true;"), testCommand: "exit 2" },
        ],
        { testCommand: undefined },
      ),
    );
    expect(allFailing.status).toBe("inconclusive");
    expect(allFailing.reason).toBe("baseline_failed");
    expect(allFailing.results.map((r) => r.status)).toEqual([
      "not_run",
      "not_run",
    ]);
  }, 60000);

  it("a mutant is classified against its own command's baseline output, not the first command's", async () => {
    useLockDir();
    const { repo } = initRepo();
    // Prints the same line whatever the code does, so the first
    // command's baseline output is exactly "same output".
    const first = scriptCommand("first.test.js", [
      "console.log('same output');",
      "",
    ]);
    // Prints something else on the unmutated tree, and the first
    // command's exact baseline output once its own mutant is applied.
    const second = scriptCommand("second.test.js", [
      "const content = require('node:fs').readFileSync('fixture.js', 'utf8');",
      "console.log(content.includes('MUTATED') ? 'same output' : 'group two baseline');",
      "",
    ]);

    const result = await probePlan(
      planOptions(
        repo,
        [
          { ...replaceMutant(2, "  return false;"), testCommand: first },
          {
            ...replaceMutant(
              7,
              "module.exports = { isPositive, isNegative }; // MUTATED",
            ),
            testCommand: second,
          },
        ],
        { testCommand: undefined },
      ),
    );

    // Against its own baseline ("same output" twice), the first
    // command's mutant shows no sign a test ran: the generic fallback.
    expect(result.results[0].status).toBe("inconclusive");
    expect(result.results[0].reason).toBe("no_tests_executed");
    // The second command's mutant printed something its own baseline did
    // not: a real survivor. Measured against the first command's baseline
    // instead, the identical output would read as no test executed.
    expect(result.results[1].status).toBe("survived");
    expect(result.results[1].reason).toBeUndefined();
    expect(result.results[1].test?.stdoutTail).toContain("same output");
  }, 60000);

  it("--require-baseline-evidence is checked on a later command's own baseline: a miss marks only its mutants not_run", async () => {
    useLockDir();
    const { repo } = initRepo();
    const withEvidence = scriptCommand("evidence.test.js", [
      "console.log('EVIDENCE');",
      "require(process.cwd() + '/fixture.test.js');",
      "",
    ]);

    const result = await probePlan(
      planOptions(
        repo,
        [
          { ...replaceMutant(2, "  return false;"), testCommand: withEvidence },
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node fixture.test.js",
          },
        ],
        { testCommand: undefined, requireBaselineEvidence: /EVIDENCE/ },
      ),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_inconclusive");
    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].status).toBe("not_run");
    expect(result.results[1].reason).toBe("baseline_evidence_not_matched");
    expect(result.baselines[1].status).toBe("failed");
    expect(result.baselines[1].reason).toBe("baseline_evidence_not_matched");
    expect(
      result.warnings.some((w) =>
        w.startsWith(
          "plan.baselines[1] (node fixture.test.js): --require-baseline-evidence (EVIDENCE) did not match the baseline output",
        ),
      ),
    ).toBe(true);
  }, 60000);

  it("--pass-regex decides a later command's own baseline: a miss marks only its mutants not_run", async () => {
    useLockDir();
    const { repo } = initRepo();
    const marking = scriptCommand("marking.test.js", [
      "require(process.cwd() + '/fixture.test.js');",
      "console.log('PASSMARK');",
      "",
    ]);

    const result = await probePlan(
      planOptions(
        repo,
        [
          { ...replaceMutant(2, "  return false;"), testCommand: marking },
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node fixture.test.js",
          },
        ],
        { testCommand: undefined, passRegex: /PASSMARK/ },
      ),
    );

    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].status).toBe("not_run");
    expect(result.results[1].reason).toBe("baseline_failed");
    expect(result.baselines[1].exitCode).toBe(0);
    expect(
      result.warnings.some((w) =>
        w.startsWith(
          "plan.baselines[1] (node fixture.test.js): --pass-regex (PASSMARK) did not match the baseline output",
        ),
      ),
    ).toBe(true);
  }, 60000);

  it("a failing --pre on a later command's baseline marks only its mutants not_run with pre_failed, and names the --pre log", async () => {
    useLockDir();
    const { repo } = initRepo();
    // Fails on its second invocation only: the second command's baseline.
    const pre = scriptCommand("pre.js", [
      "const fs = require('node:fs');",
      "fs.appendFileSync('pre-runs.txt', 'p\\n');",
      "const n = fs.readFileSync('pre-runs.txt', 'utf8').split('\\n').filter(Boolean).length;",
      "process.exit(n === 2 ? 1 : 0);",
      "",
    ]);

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          { ...replaceMutant(5, "  return true;"), testCommand: commandB() },
        ],
        { preCommand: pre },
      ),
    );

    expect(result.results[0].status).toBe("killed");
    expect(result.results[1].status).toBe("not_run");
    expect(result.results[1].reason).toBe("pre_failed");
    expect(result.baselines[1].status).toBe("failed");
    expect(result.baselines[1].reason).toBe("pre_failed");
    expect(result.baselines[1].logPath).toBeUndefined();
    const preWarning = result.warnings.find((w) =>
      w.includes("--pre exited 1 during the baseline run; see "),
    );
    expect(preWarning?.startsWith("plan.baselines[1] (")).toBe(true);
    const preLog = (preWarning ?? "").split("; see ")[1];
    expect(result.dryRunLogPaths).toContain(preLog);
    expect(linesIn(repo, "b-runs.txt")).toEqual([]);
  }, 60000);

  it("--expect pass on a later command's mutant is honoured, and -i inplace restores the target exactly across both commands", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const beforeHash = await sha256File(target);

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        {
          ...replaceMutant(
            7,
            "module.exports = { isPositive, isNegative, extra: 1 };",
          ),
          testCommand: commandB(),
          expect: "pass",
        },
        { ...replaceMutant(5, "  return true;"), testCommand: commandB() },
      ]),
    );

    expect(result.isolation.mode).toBe("inplace");
    expect(result.results[1].baseline_index).toBe(1);
    expect(result.results[1].expect).toBe("pass");
    expect(result.results[1].status).toBe("survived");
    expect(result.results[1].mutation_probe?.expectation).toBe("met");
    // Two separately written `commandB()` scripts are two commands.
    expect(result.results[2].baseline_index).toBe(2);
    expect(result.results[2].status).toBe("killed");
    expect(result.status).toBe("killed");
    expect(result.expectation).toBe("met");
    for (const entry of result.results) {
      expect(entry.mutation_probe?.restored_verified).toBe(true);
    }
    expect(await sha256File(target)).toBe(beforeHash);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 60000);

  it("a later command's passing baseline that rewrites a target ends the plan target_changed_during_baseline before any mutant, every backup dropped", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    vi.mocked(beginInplace).mockClear();
    vi.mocked(computeMutant).mockClear();
    const rewriting = `node -e "require('fs').writeFileSync('fixture.js', 'REWRITTEN')"`;

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        { ...replaceMutant(5, "  return true;"), testCommand: rewriting },
      ]),
    );
    const backups = backupPathsTaken();

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_changed_during_baseline");
    // Terminal: the first command's mutant is never reached either.
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["not_run", undefined],
      ["not_run", undefined],
    ]);
    expect(vi.mocked(computeMutant)).not.toHaveBeenCalled();
    expect(result.baselines.map((b) => [b.status, b.reason])).toEqual([
      ["passed", undefined],
      ["failed", "target_changed_during_baseline"],
    ]);
    expect(result.warnings).toContain(
      `plan.baselines[1] (${rewriting}): ${target} changed during the baseline run (before any mutation was applied); the target is left as the baseline run wrote it, not restored`,
    );
    // Left as the baseline wrote it, the backup dropped: the handling
    // the first command's own passing baseline gives the same rewrite.
    expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN");
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.filter((backup) => fs.existsSync(backup))).toEqual([]);
  }, 60000);

  it("a later command's failing baseline that rewrites a target ends the plan target_changed_during_baseline, keeping that target's backup as a failing first baseline does", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const original = fs.readFileSync(target, "utf8");
    // A second target the failing baseline leaves alone: its backup is
    // dropped, exactly as a failing first baseline drops it.
    const untouched = path.join(repo, "second.js");
    fs.writeFileSync(untouched, "module.exports = 2;\n");
    vi.mocked(beginInplace).mockClear();
    vi.mocked(computeMutant).mockClear();
    const rewriting = "echo '// x' >> fixture.js; exit 1";

    const result = await probePlan(
      planOptions(repo, [
        replaceMutant(2, "  return false;"),
        {
          ...replaceMutant(1, "module.exports = 3;", "second.js"),
          testCommand: rewriting,
        },
      ]),
    );
    const backups = backupPathsTaken();

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_changed_during_baseline");
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["not_run", undefined],
      ["not_run", undefined],
    ]);
    expect(vi.mocked(computeMutant)).not.toHaveBeenCalled();
    expect(result.baselines.map((b) => [b.status, b.reason])).toEqual([
      ["passed", undefined],
      ["failed", "baseline_failed"],
    ]);
    expect(fs.readFileSync(target, "utf8")).toBe(`${original}// x\n`);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
    // The rewritten target's pre-baseline content is kept, and the
    // warning names where; the untouched target's backup is gone.
    const prefix = `plan.baselines[1] (${rewriting}): `;
    const kept = result.warnings.find((w) =>
      w.startsWith(
        `${prefix}the failing baseline run also rewrote ${target}; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at `,
      ),
    );
    expect(kept).toBeDefined();
    const keptPath = (kept ?? "").split("is kept at ")[1];
    expect(fs.readFileSync(keptPath, "utf8")).toBe(original);
    expect(backups).toHaveLength(2);
    expect(backups.filter((backup) => fs.existsSync(backup))).toEqual([
      keptPath,
    ]);

    // The same failing, rewriting command as a plan's FIRST command: the
    // same warning (without the prefix), the same backup kept.
    useLockDir();
    const { repo: firstRepo } = initRepo();
    const firstTarget = path.join(firstRepo, "fixture.js");
    vi.mocked(beginInplace).mockClear();
    const first = await probePlan(
      planOptions(firstRepo, [replaceMutant(2, "  return false;")], {
        testCommand: rewriting,
      }),
    );
    expect(first.reason).toBe("baseline_failed");
    const firstKept = first.warnings.find((w) =>
      w.startsWith(
        `the failing baseline run also rewrote ${firstTarget}; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at `,
      ),
    );
    expect(firstKept).toBeDefined();
    expect(
      backupPathsTaken().filter((backup) => fs.existsSync(backup)),
    ).toHaveLength(1);
  }, 60000);

  it("a later command's failing baseline ends the plan aborted when the signal handler is already handling a signal, before any mutant", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    vi.mocked(beginInplace).mockClear();
    vi.mocked(computeMutant).mockClear();

    // Call 1 is the first command's baseline, call 2 the second's: it
    // fails on its own (baseline_failed, not aborted), and the signal
    // lands right after it.
    const { result, calls } = await signalAfterExecCall(2, () =>
      probePlan(
        planOptions(repo, [
          replaceMutant(2, "  return false;"),
          { ...replaceMutant(5, "  return true;"), testCommand: "exit 1" },
        ]),
      ),
    );
    const backups = backupPathsTaken();

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["not_run", undefined],
      ["not_run", undefined],
    ]);
    expect(vi.mocked(computeMutant)).not.toHaveBeenCalled();
    expect(calls).toBe(2);
    expect(
      result.baselines.map((b) => [b.status, b.reason, b.exitCode]),
    ).toEqual([
      ["passed", undefined, 0],
      ["failed", "baseline_failed", 1],
    ]);
    // Settled as a stopped baseline: nothing rewrote the target, so its
    // backup is gone and the target is as it was.
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.filter((backup) => fs.existsSync(backup))).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 60000);

  it("a later command's baseline stopped by a signal ends the plan aborted before any mutant, leaving no backup behind", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    vi.mocked(beginInplace).mockClear();
    vi.mocked(computeMutant).mockClear();
    // The library-mode signal contract, forced the same way the I5 test
    // above forces it (signalling this test process would race vitest's
    // own handlers): call 1 is the first command's baseline, call 2 the
    // second command's, reported as stopped.
    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    let callCount = 0;
    vi.mocked(execCommand).mockImplementation(
      async (...args: Parameters<typeof execCommand>) => {
        callCount += 1;
        const result = await actualExec.execCommand(...args);
        return callCount === 2 ? { ...result, aborted: true } : result;
      },
    );

    let result: ProbePlanResult;
    try {
      result = await probePlan(
        planOptions(repo, [
          replaceMutant(2, "  return false;"),
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node fixture.test.js && true",
          },
          replaceMutant(7, "module.exports = {};"),
        ]),
      );
    } finally {
      vi.mocked(execCommand).mockImplementation(actualExec.execCommand);
    }
    const backups = backupPathsTaken();

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["not_run", undefined],
      ["not_run", undefined],
      ["not_run", undefined],
    ]);
    expect(vi.mocked(computeMutant)).not.toHaveBeenCalled();
    expect(callCount).toBe(2);
    expect(result.baselines.map((b) => [b.status, b.reason])).toEqual([
      ["passed", undefined],
      ["failed", "aborted"],
    ]);
    expect(result.warnings).toContain(
      `plan.baselines[1] (node fixture.test.js && true): the baseline run was aborted; see ${result.baselines[1].logPath}`,
    );
    // Nothing rewrote the target, so its backup went with the decision to
    // stop, and the target is as it was.
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.filter((backup) => fs.existsSync(backup))).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 60000);

  it("names the first command by its mutant's plan path when it escapes -i worktree's isolation copy and the plan has no plan-level test", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(
        repo,
        [
          {
            ...replaceMutant(2, "  return false;"),
            testCommand: `node ${path.join(repo, "fixture.test.js")}`,
          },
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: "node fixture.test.js",
          },
        ],
        { isolation: "worktree", testCommand: undefined },
      ),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    const message = result.warnings.join("\n");
    expect(message).toContain(
      "plan.mutants[0].test names an absolute path under the real repository root",
    );
    expect(message).not.toContain("the test command (-t)");
    expect(runsSeen(repo)).toEqual([]);
    expectNoIsolationLeftovers(repo, lockDir);

    // A plan-level `test` keeps the label it always had.
    const { repo: planLevelRepo } = initRepo();
    const planLevel = await probePlan(
      planOptions(planLevelRepo, [replaceMutant(2, "  return false;")], {
        isolation: "worktree",
        testCommand: `node ${path.join(planLevelRepo, "fixture.test.js")}`,
      }),
    );
    expect(planLevel.reason).toBe("test_command_escapes_isolation");
    expect(planLevel.warnings.join("\n")).toContain(
      "the test command (-t) names an absolute path",
    );
  }, 60000);

  /** A plan over a Python target, so every `--pre`/test invocation gets
   * its own bytecode cache directory; `failingCall` names the one
   * `beginPyCacheIsolation` call (1-based) that cannot create it. */
  async function pycachePlan(failingCall: number): Promise<ProbePlanResult> {
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.py"),
      ["def positive(n):", "    return n > 0", ""].join("\n"),
    );
    const catches = scriptCommand("py-catches.test.js", [
      "const content = require('node:fs').readFileSync('fixture.py', 'utf8');",
      "process.exit(content.includes('n < 0') ? 1 : 0);",
      "",
    ]);
    const actualPycache = await vi.importActual<
      typeof import("../src/probe/pycache.js")
    >("../src/probe/pycache.js");
    let calls = 0;
    vi.mocked(beginPyCacheIsolation).mockImplementation(
      (...args: Parameters<typeof beginPyCacheIsolation>) => {
        calls += 1;
        return calls === failingCall
          ? { ok: false, message: "synthetic isolation failure" }
          : actualPycache.beginPyCacheIsolation(...args);
      },
    );
    try {
      return await probePlan(
        planOptions(
          repo,
          [
            {
              file: "fixture.py",
              line: 2,
              form: "replace",
              replaceText: "    return n < 0",
              testCommand: catches,
            },
            {
              file: "fixture.py",
              line: 2,
              form: "replace",
              replaceText: "    return n >= 0",
              testCommand: "true",
            },
          ],
          { testCommand: undefined },
        ),
      );
    } finally {
      vi.mocked(beginPyCacheIsolation).mockImplementation(
        actualPycache.beginPyCacheIsolation,
      );
    }
  }

  it("a later command whose baseline cannot get its Python bytecode cache directory marks only its own mutants not_run, and that baseline not_run: nothing was started", async () => {
    useLockDir();
    // Call 1 is the first command's baseline, call 2 the second's.
    const result = await pycachePlan(2);

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_inconclusive");
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["killed", undefined],
      ["not_run", "pycache_isolation_failed"],
    ]);
    expect(result.baselines[0].status).toBe("passed");
    expect(result.baselines[1]).toEqual({
      index: 1,
      command: "true",
      status: "not_run",
      reason: "pycache_isolation_failed",
      entries: [1],
    });
    expect(result.warnings).toContain(
      "plan.baselines[1] (true): synthetic isolation failure",
    );
  }, 60000);

  it("a first command whose baseline cannot get its Python bytecode cache directory refuses the plan, that baseline recorded not_run with the reason", async () => {
    useLockDir();
    const result = await pycachePlan(1);

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("pycache_isolation_failed");
    expect(result.baseline).toBeUndefined();
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    expect(result.baselines.map((b) => [b.status, b.reason])).toEqual([
      ["not_run", "pycache_isolation_failed"],
      ["not_run", undefined],
    ]);
    expect(result.baselines[0].exitCode).toBeUndefined();
  }, 60000);

  it("refuses a later command that escapes -i worktree's isolation copy before anything runs, naming the plan path of that command", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(
        repo,
        [
          replaceMutant(2, "  return false;"),
          {
            ...replaceMutant(5, "  return true;"),
            testCommand: `node ${path.join(repo, "fixture.test.js")}`,
          },
        ],
        { isolation: "worktree" },
      ),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    expect(result.warnings.join("\n")).toContain(
      "plan.mutants[1].test names an absolute path under the real repository root",
    );
    expect(result.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    expect(result.baselines.map((b) => b.status)).toEqual([
      "not_run",
      "not_run",
    ]);
    expect(runsSeen(repo)).toEqual([]);
    expectNoIsolationLeftovers(repo, lockDir);
  }, 60000);

  it("a library caller whose mutant has no command at all, its own or the plan's, is refused plan_invalid before anything runs", async () => {
    useLockDir();
    const { repo } = initRepo();

    const result = await probePlan(
      planOptions(
        repo,
        [
          {
            ...replaceMutant(2, "  return false;"),
            testCommand: "node fixture.test.js",
          },
          replaceMutant(5, "  return true;"),
        ],
        { testCommand: undefined },
      ),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("plan_invalid");
    expect(result.warnings.join("\n")).toContain("plan.mutants[1] has none");
    expect(result.baselines).toEqual([]);
    expect(runsSeen(repo)).toEqual([]);
  });

  it("a plan naming one command reports exactly one baseline, the same one `baseline` names", async () => {
    useLockDir();
    const result = await probePlan(
      planOptions(initRepo().repo, [
        replaceMutant(2, "  return false;"),
        replaceMutant(5, "  return true;"),
      ]),
    );
    expect(result.baselines).toEqual([
      {
        index: 0,
        command: "node fixture.test.js",
        status: "passed",
        exitCode: result.baseline?.exitCode,
        durationMs: result.baseline?.durationMs,
        logPath: result.baseline?.logPath,
        timedOut: result.baseline?.timedOut,
        entries: [0, 1],
      },
    ]);
    expect(
      result.results.map((r) => [r.test_command, r.baseline_index]),
    ).toEqual([
      ["node fixture.test.js", 0],
      ["node fixture.test.js", 0],
    ]);
  }, 60000);
});
