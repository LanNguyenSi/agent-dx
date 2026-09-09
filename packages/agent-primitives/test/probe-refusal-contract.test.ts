import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  probe,
  type ProbeOptions,
  type ProbeResult,
} from "../src/probe/index.js";
import {
  REFUSAL_RESULT_SHAPE,
  type RefusalReason,
} from "../src/probe/session.js";
import { writeMarker } from "../src/lock.js";
import { execCommand } from "../src/exec.js";
import { computeMutant } from "../src/probe/mutant.js";
import { beginInplace } from "../src/probe/isolation.js";
import {
  ISOLATION_ESCAPE_CHANNEL_LABEL,
  ISOLATION_ESCAPE_FIX_HINT,
  resolveDeepestExisting,
} from "../src/probe/containment.js";
import { expectNoIsolationLeftovers } from "./helpers/no-leftovers.js";
import { runArgv } from "../src/probe/run.js";

/**
 * The `REFUSAL_RESULT_SHAPE` contract (`session.ts`) is exhaustive over
 * `RefusalReason` at the type level already (it is typed
 * `Record<RefusalReason, ...>`), so a reason with no entry fails to
 * compile there. This file is the runtime half: `provocations` below is
 * typed `Record<RefusalReason, Provocation>`, so a `RefusalReason` added
 * without a provocation here ALSO fails to compile (not merely to
 * pass), and the loop at the bottom drives every provocation through
 * `probe()` for real and asserts the envelope it reports matches the
 * contract's `mutant`/`mutation_probe` presence exactly for that
 * reason. A reason whose contract entry drifts from what the site
 * actually reports fails the relevant `it()`.
 */

// Call-through partial mocks, same shape and same reason as
// probe.test.ts's and probe-worktree.test.ts's own (see either file's
// docblock): only a provocation that names one of these explicitly
// overrides a call, and always restores the call-through default before
// it finishes.
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
  return { ...actual, beginInplace: vi.fn(actual.beginInplace) };
});
vi.mock("../src/probe/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/probe/run.js")>();
  return { ...actual, runArgv: vi.fn(actual.runArgv) };
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-refusal-contract-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

/** Every provocation gets its own lock dir, so a leftover lock/marker
 * from one cannot be observed by another. */
function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function unused(n) {",
  "  return n * 2;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

/** A fresh git repo (built in a mkdtemp dir) with a committed
 * fixture.js and fixture.test.js. Same fixture and same git config
 * pins as probe.test.ts's own `initRepo`. */
function initRepo(): { repo: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "diff.noprefix", "false"]);
  git(repo, ["config", "diff.mnemonicPrefix", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo };
}

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 2,
    form: "replace",
    replaceText: "  return false;",
    testCommand: "node fixture.test.js",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

// Permission bits mean nothing to root (it bypasses them), so
// lock_unavailable only discriminates as a non-root user.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// --- One provocation per RefusalReason -------------------------------

async function provokeWorktreeAllowOutsideUnsupported(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(
    baseOptions(repo, { isolation: "worktree", allowOutside: true }),
  );
}

/** The D-033 shape (batch 45): a `-t` command that `cd`s back into the
 * real repository root under `-i worktree`, which never touches the
 * isolated worktree copy at all. */
async function provokeTestCommandEscapesIsolation(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(
    baseOptions(repo, {
      isolation: "worktree",
      testCommand: `cd ${repo} && node fixture.test.js`,
    }),
  );
}

async function provokeFileOutsideRoot(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  const outsideDir = makeTmpDir();
  const outsideFile = path.join(outsideDir, "outside.js");
  fs.writeFileSync(outsideFile, "x");
  return probe(
    baseOptions(repo, { file: outsideFile, line: 1, replaceText: "y" }),
  );
}

async function provokeProbeInProgress(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  const first = probe(
    baseOptions(repo, { testCommand: "sleep 1 && node fixture.test.js" }),
  );
  await sleep(200);
  const second = await probe(
    baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
  );
  await first;
  return second;
}

async function provokeLockUnavailable(): Promise<ProbeResult> {
  const savedEnv = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const parent = makeTmpDir();
  const unwritable = path.join(parent, "locks");
  fs.mkdirSync(unwritable, { mode: 0o500 });
  process.env.AGENT_PRIMITIVES_LOCK_DIR = unwritable;
  const { repo } = initRepo();
  try {
    return await probe(baseOptions(repo));
  } finally {
    // Restore write access so afterEach's rmSync can clean it up.
    fs.chmodSync(unwritable, 0o700);
    if (savedEnv === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
    else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedEnv;
  }
}

async function provokeStaleProbeMarker(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  const absFile = path.join(repo, "fixture.js");
  const markerKey = fs.realpathSync(absFile);
  const originalContent = fs.readFileSync(absFile, "utf8");

  const backupDir = makeTmpDir();
  const backupPath = path.join(backupDir, "backup-fixture.js");
  fs.writeFileSync(backupPath, originalContent);

  // Foreign content: neither the recorded pre-hash nor the recorded
  // "mutated" hash matches what is actually on disk right now.
  fs.writeFileSync(
    absFile,
    "totally unrelated content, not what was mutated\n",
  );

  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  if (!deadPid) throw new Error("failed to obtain a dead pid for the test");

  writeMarker(markerKey, {
    targetPath: absFile,
    backupPath,
    preHash: "a".repeat(64),
    mutatedHash: "b".repeat(64),
    pid: deadPid,
    timestamp: new Date().toISOString(),
  });

  return probe(baseOptions(repo));
}

async function provokeFileNotFound(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(baseOptions(repo, { file: "does-not-exist.js" }));
}

async function provokeStaleWorktree(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  const outside = path.join(makeTmpDir(), "somebody-elses-directory");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep me\n");
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
  const realRoot = resolveDeepestExisting(repo);
  writeMarker(realRoot, {
    targetPath: outside,
    backupPath: realRoot,
    preHash: "",
    mutatedHash: "",
    pid: deadPid,
    timestamp: new Date().toISOString(),
    scratchRoot: path.dirname(outside),
  });
  return probe(baseOptions(repo, { isolation: "worktree" }));
}

async function provokeWorktreeSyncFailed(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  const actualRun = await vi.importActual<typeof import("../src/probe/run.js")>(
    "../src/probe/run.js",
  );
  const mockRun = vi.mocked(runArgv);
  mockRun.mockImplementation(async (file, args, options) => {
    const result = await actualRun.runArgv(file, args, options);
    if (args[0] === "diff" && args.includes("--binary")) {
      const outputArg = args.find((a) => a.startsWith("--output="));
      if (outputArg === undefined) {
        throw new Error("expected a --output= argument on this diff call");
      }
      const diffPath = outputArg.slice("--output=".length);
      // A hunk whose context matches nothing in fixture.js: cannot
      // apply cleanly against a freshly checked-out HEAD worktree.
      fs.writeFileSync(
        diffPath,
        [
          "diff --git a/fixture.js b/fixture.js",
          "index 0000000..1111111 100644",
          "--- a/fixture.js",
          "+++ b/fixture.js",
          "@@ -1,1 +1,1 @@",
          "-this line does not exist in fixture.js",
          "+neither does this one",
          "",
        ].join("\n"),
      );
    }
    return result;
  });
  try {
    return await probe(baseOptions(repo, { isolation: "worktree" }));
  } finally {
    mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
      actualRun.runArgv(...args),
    );
  }
}

async function provokeTargetNotSynced(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.js\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "gitignore"]);
  fs.writeFileSync(path.join(repo, "ignored.js"), FIXTURE_JS);
  return probe(
    baseOptions(repo, { isolation: "worktree", file: "ignored.js" }),
  );
}

async function provokeBackupVerificationFailed(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  const actualIsolation = await vi.importActual<
    typeof import("../src/probe/isolation.js")
  >("../src/probe/isolation.js");
  const mockBeginInplace = vi.mocked(beginInplace);
  mockBeginInplace.mockImplementationOnce((targetPath, logDir) => {
    const session = actualIsolation.beginInplace(targetPath, logDir);
    fs.writeFileSync(session.backupPath, "truncated backup\n");
    return session;
  });
  try {
    return await probe(baseOptions(repo));
  } finally {
    mockBeginInplace.mockImplementation(
      (...args: Parameters<typeof beginInplace>) =>
        actualIsolation.beginInplace(...args),
    );
  }
}

async function provokeMutantNotApplicable(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(
    baseOptions(repo, {
      form: "match",
      replaceText: undefined,
      matchText: "not-on-this-line",
      withText: "x",
    }),
  );
}

async function provokeGitApplyTimeout(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  // Stubs the dry run itself (`prepareMutant`'s call to `computeMutant`,
  // before the baseline ever runs), the same seam
  // `backup_verification_failed` above uses for `beginInplace`: a real
  // `git apply` timeout during the dry run is what this reason names,
  // and this reaches the same `reasonCode` `computePatch` itself would
  // report for one, without needing a genuinely slow `git apply`.
  vi.mocked(computeMutant).mockImplementationOnce(async () => ({
    applicable: false,
    reasonCode: "git_apply_timeout",
    reason: "the dry-run git apply hit its timeout and was killed",
    logPaths: [],
  }));
  return probe(baseOptions(repo));
}

async function provokeBaselineFailed(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(baseOptions(repo, { testCommand: "exit 1" }));
}

async function provokePreFailed(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(baseOptions(repo, { preCommand: "exit 1" }));
}

async function provokeTargetChangedDuringBaseline(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(
    baseOptions(repo, {
      testCommand:
        "node -e \"require('fs').writeFileSync('fixture.js', 'REWRITTEN')\"",
    }),
  );
}

/** A baseline that exits `0` (a real pass, per the shell) but whose own
 * output is a vitest all-skipped `Tests` summary: the exact shape a `-t`
 * filter that matches no test inside files vitest still loaded produces
 * (batch 43's real bug, see the CHANGELOG entry for task `273b3851`).
 * `console.log` rather than a real vitest run: the detector is a pure
 * text parser, so reproducing its exact input is enough to provoke it
 * without needing vitest itself in this fixture repo. */
async function provokeNoTestsExecuted(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(
    baseOptions(repo, {
      testCommand:
        "node -e \"console.log(' Test Files  1 skipped (1)'); console.log('      Tests  2 skipped (2)');\"",
    }),
  );
}

/** A baseline that passes normally (the default fixture test) but whose
 * output never matches an opt-in `--require-baseline-evidence` the
 * caller supplied. */
async function provokeBaselineEvidenceNotMatched(): Promise<ProbeResult> {
  useLockDir();
  const { repo } = initRepo();
  return probe(
    baseOptions(repo, {
      requireBaselineEvidence: /this pattern never matches/,
    }),
  );
}

/** Runs `probe` with the nth `execCommand` call reported as aborted
 * (the shape `exec.ts` returns once its `signal` fired: killed child, no
 * exit code of its own), every other call running for real. Same helper
 * shape as probe.test.ts's own `probeWithAbortedCall`. */
async function probeWithAbortedCall(
  nth: number,
  overrides: Partial<ProbeOptions>,
): Promise<ProbeResult> {
  const actualExec =
    await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
  const mockExec = vi.mocked(execCommand);
  let callCount = 0;
  mockExec.mockImplementation(
    async (...args: Parameters<typeof execCommand>) => {
      callCount += 1;
      const result = await actualExec.execCommand(...args);
      return callCount === nth
        ? { ...result, aborted: true, exitCode: null }
        : result;
    },
  );
  try {
    useLockDir();
    const { repo } = initRepo();
    return await probe(baseOptions(repo, overrides));
  } finally {
    mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
      actualExec.execCommand(...args),
    );
  }
}

/** The "aborted" contract entry covers BOTH of the baseline phase's own
 * abort paths (an aborted `--pre` and an aborted baseline test, see
 * `RefusalReason`'s own docblock in session.ts); this provocation runs
 * the baseline-test one for the generic loop below, and a dedicated
 * `it()` beside the loop separately drives the `--pre` one through the
 * same assertions. */
async function provokeAbortedBaselineTest(): Promise<ProbeResult> {
  // Call 1 with no --pre is the baseline test itself.
  return probeWithAbortedCall(1, {});
}

type Provocation = () => Promise<ProbeResult>;

const provocations: Record<RefusalReason, Provocation> = {
  worktree_allow_outside_unsupported: provokeWorktreeAllowOutsideUnsupported,
  test_command_escapes_isolation: provokeTestCommandEscapesIsolation,
  file_outside_root: provokeFileOutsideRoot,
  probe_in_progress: provokeProbeInProgress,
  lock_unavailable: provokeLockUnavailable,
  stale_probe_marker: provokeStaleProbeMarker,
  file_not_found: provokeFileNotFound,
  stale_worktree: provokeStaleWorktree,
  worktree_sync_failed: provokeWorktreeSyncFailed,
  target_not_synced: provokeTargetNotSynced,
  backup_verification_failed: provokeBackupVerificationFailed,
  mutant_not_applicable: provokeMutantNotApplicable,
  git_apply_timeout: provokeGitApplyTimeout,
  aborted: provokeAbortedBaselineTest,
  pre_failed: provokePreFailed,
  baseline_failed: provokeBaselineFailed,
  target_changed_during_baseline: provokeTargetChangedDuringBaseline,
  no_tests_executed: provokeNoTestsExecuted,
  baseline_evidence_not_matched: provokeBaselineEvidenceNotMatched,
};

/**
 * The expected `mutant`/`mutation_probe` presence, hardcoded here
 * rather than read from `REFUSAL_RESULT_SHAPE` at assertion time: if
 * this test instead compared a provoked result against the SAME table
 * `refuse()`/`index.ts` compute their own fields from, a change to that
 * table (a flipped entry, say) would move the expectation and the
 * actual result together and the test would keep passing -- caught
 * directly, provoking `session.ts`'s own `aborted: { mutant: false,
 * mutationProbe: false }` mutation through `agent-primitives probe`:
 * the self-referential version of this function passed. This literal
 * is typed `Record<RefusalReason, ...>` too, so it still fails to
 * compile on an added `RefusalReason` with no entry here, the same
 * exhaustiveness guarantee `provocations` above already gives; it is
 * simply never DERIVED from the table under test.
 */
const EXPECTED_SHAPE: Record<
  RefusalReason,
  { mutant: boolean; mutationProbe: boolean }
> = {
  worktree_allow_outside_unsupported: { mutant: false, mutationProbe: false },
  test_command_escapes_isolation: { mutant: false, mutationProbe: false },
  file_outside_root: { mutant: false, mutationProbe: false },
  probe_in_progress: { mutant: false, mutationProbe: false },
  lock_unavailable: { mutant: false, mutationProbe: false },
  stale_probe_marker: { mutant: false, mutationProbe: false },
  file_not_found: { mutant: false, mutationProbe: false },
  stale_worktree: { mutant: false, mutationProbe: false },
  worktree_sync_failed: { mutant: false, mutationProbe: false },
  target_not_synced: { mutant: false, mutationProbe: false },
  backup_verification_failed: { mutant: false, mutationProbe: false },
  mutant_not_applicable: { mutant: false, mutationProbe: false },
  git_apply_timeout: { mutant: false, mutationProbe: false },
  aborted: { mutant: true, mutationProbe: true },
  pre_failed: { mutant: true, mutationProbe: true },
  baseline_failed: { mutant: true, mutationProbe: true },
  target_changed_during_baseline: { mutant: true, mutationProbe: true },
  no_tests_executed: { mutant: true, mutationProbe: true },
  baseline_evidence_not_matched: { mutant: true, mutationProbe: true },
};

/** Asserts a provoked `ProbeResult` matches the hardcoded
 * `EXPECTED_SHAPE` for `reason` exactly: `mutant`/`mutation_probe`
 * present or absent per the contract, and, where present,
 * `mutation_probe`'s own fixed shape (`result: "not_run"`, `reason`
 * echoing, `restored_verified: true`). Also cross-checks `REFUSAL_RESULT_SHAPE`
 * itself against the same hardcoded literal, so a change to the code
 * contract that this file's own literal was not updated to match fails
 * here too, independent of what any provocation observes. */
function expectMatchesContract(
  result: ProbeResult,
  reason: RefusalReason,
): void {
  expect(result.reason).toBe(reason);
  const shape = EXPECTED_SHAPE[reason];
  expect(REFUSAL_RESULT_SHAPE[reason]).toEqual(shape);
  if (shape.mutant) {
    expect(result.mutant).toBeDefined();
  } else {
    expect(result.mutant).toBeUndefined();
  }
  if (shape.mutationProbe) {
    expect(result.mutation_probe).toBeDefined();
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe(reason);
    expect(result.mutation_probe?.restored_verified).toBe(true);
  } else {
    expect(result.mutation_probe).toBeUndefined();
  }
}

describe("probe(): REFUSAL_RESULT_SHAPE contract, every RefusalReason provoked for real", () => {
  for (const reason of Object.keys(REFUSAL_RESULT_SHAPE) as RefusalReason[]) {
    const run = reason === "lock_unavailable" && isRoot ? it.skip : it;
    run(
      `${reason}: mutant/mutation_probe presence matches the contract`,
      async () => {
        const result = await provocations[reason]();
        expectMatchesContract(result, reason);
      },
      30000,
    );
  }

  it("aborted: the other baseline-phase abort path (an aborted --pre) also matches the contract", async () => {
    const result = await probeWithAbortedCall(1, { preCommand: "true" });
    expectMatchesContract(result, "aborted");
  }, 30000);

  it("aborted: the dry run's OWN abort (before the baseline ever runs) reports neither mutant nor mutation_probe, unlike the baseline-phase pair above", async () => {
    // Same seam and idiom as `provokeGitApplyTimeout` above (stubs
    // `computeMutant`, the call `prepareMutant`'s dry run makes, before
    // the baseline ever runs), but with `reasonCode: "aborted"` instead
    // of `"git_apply_timeout"`: this is the `step.ts:110-122` abort
    // path the round-3 review named, distinct from the baseline-phase
    // `aborted` the loop above already provokes through
    // `provokeAbortedBaselineTest`. `REFUSAL_RESULT_SHAPE.aborted.mutant`
    // is `true` (it also covers the baseline-phase pair, where a mutant
    // HAS been computed by then), but `index.ts` only attaches `mutant`/
    // `mutation_probe` once the dry run actually produced one
    // (`mutantField`/`mutantSummary`/`verifiedAppliedVia` stay
    // `undefined` on this path) -- so this dry-run-phase `aborted`
    // reports neither field even though the table says `true`.
    useLockDir();
    const { repo } = initRepo();
    vi.mocked(computeMutant).mockImplementationOnce(async () => ({
      applicable: false,
      reasonCode: "aborted",
      reason: "the dry run was aborted before the baseline ever ran",
      logPaths: [],
    }));
    const result = await probe(baseOptions(repo));
    expect(result.reason).toBe("aborted");
    expect(result.mutant).toBeUndefined();
    expect(result.mutation_probe).toBeUndefined();
  }, 30000);
});

/**
 * Task 5bf16459 (batch 46, D-006): `-i worktree` mutates a throwaway
 * copy while a `-t` command that names an absolute path back into the
 * real repository root runs against the REAL, unmutated tree -- the
 * exact shape that gave a false `survived` in batch 45 (D-033: `cd
 * /abs/worktree/backend && npx vitest run ...`). Round 3 (D-033, this
 * batch) replaced the tokenizer both round 1 and round 2 built on with
 * a substring rule (`containment.ts`'s `escapingRootMentions`): each of
 * those rounds closed one reviewer-found quoting/escaping shape and
 * left another (a quoted path with whitespace, a `--key=/abs` value,
 * `--pre` never scanned, then a `sh -c "..."` wrapper read as one
 * opaque token and a backslash-escaped space splitting a path in two).
 * These tests pin the fix's actual boundary, beyond the generic
 * contract loop above (which only checks that the reason/shape match,
 * not the surrounding cases): every shape the three rounds enumerated,
 * a `--env` value (the round-2 survivor closed this round), the
 * `--log-dir`-inside-the-repo exemption, root reached via its own
 * symlink spelling, an absolute path OUTSIDE the repo left alone, and
 * `-i inplace` exempt entirely. Direct unit coverage of the substring
 * rule itself lives in `containment.test.ts`.
 */
describe("probe(): test-command isolation-escape detection (task 5bf16459)", () => {
  it("fixture pair: the absolute-cd shape is refused, the same test relative from the package dir is killed", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absolute = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        testCommand: `cd ${repo} && node fixture.test.js`,
      }),
    );
    expect(absolute.status).toBe("usage_error");
    expect(absolute.reason).toBe("test_command_escapes_isolation");
    expect(absolute.warnings.join(" ")).toContain(repo);
    expect(absolute.warnings.join(" ")).toContain("--isolation inplace");

    useLockDir();
    const { repo: repo2 } = initRepo();
    const relative = await probe(
      baseOptions(repo2, {
        isolation: "worktree",
        testCommand: "node fixture.test.js",
      }),
    );
    expect(relative.status).toBe("killed");
    expect(relative.reason).toBeUndefined();
  });

  it("a repository root given via a symlink still refuses when the command spells it by its realpath instead", async () => {
    useLockDir();
    const { repo } = initRepo();
    const linkParent = makeTmpDir();
    const link = path.join(linkParent, "linked-repo");
    fs.symlinkSync(repo, link, "dir");
    // cwd (and so the computed root) is the SYMLINK; the test command
    // spells the repository root via its REALPATH instead (which, on a
    // macOS runner, differs from `repo`'s own as-given spelling too --
    // /var is itself a symlink to /private/var -- so this resolves
    // through BOTH symlinks). The substring rule recognizes a root's
    // as-given spelling and its realpath (`containment.test.ts` pins
    // this directly); a third, unrelated symlink alias pointing at the
    // same target is a documented residual (README), not covered here.
    const real = resolveDeepestExisting(repo);
    const result = await probe(
      baseOptions(link, {
        isolation: "worktree",
        testCommand: `cd ${real} && node fixture.test.js`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
  });

  it("an absolute path OUTSIDE the repository root is not refused", async () => {
    useLockDir();
    const { repo } = initRepo();
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        testCommand: "/usr/bin/env node fixture.test.js",
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  it("--isolation inplace is exempt: an absolute path back into the (real) tree is the intended target there", async () => {
    useLockDir();
    const { repo } = initRepo();
    const result = await probe(
      baseOptions(repo, {
        isolation: "inplace",
        testCommand: `cd ${repo} && node fixture.test.js`,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  // --- Round 2: two of three fail-open shapes review found in round 1's
  // whitespace-split, prefix-only tokenizer (the third, --pre, is its
  // own test below). Still closed by the round-3 substring rule. ---

  it("a quoted absolute path containing a space is refused, not read as a plain string prefix", async () => {
    useLockDir();
    const { repo } = initRepo();
    const spacedParent = makeTmpDir();
    const spacedRepoDir = path.join(spacedParent, "my repo");
    fs.renameSync(repo, spacedRepoDir);
    const result = await probe(
      baseOptions(spacedRepoDir, {
        isolation: "worktree",
        testCommand: `cd '${spacedRepoDir}' && node fixture.test.js`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    expect(result.warnings.join(" ")).toContain(spacedRepoDir);
  });

  it("the --key=/abs token form is refused, not only a bare absolute token", async () => {
    useLockDir();
    const { repo } = initRepo();
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        testCommand: `npm test --prefix=${repo}`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    expect(result.warnings.join(" ")).toContain(repo);
  });

  it("an escaping --pre is refused even when the test command itself is relative, naming --pre in the message; the same --pre relative from the package dir is killed", async () => {
    useLockDir();
    const { repo } = initRepo();
    const escaping = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        preCommand: `cd ${repo} && true`,
        testCommand: "node fixture.test.js",
      }),
    );
    expect(escaping.status).toBe("usage_error");
    expect(escaping.reason).toBe("test_command_escapes_isolation");
    expect(escaping.warnings.join(" ")).toContain(repo);
    expect(escaping.warnings.join(" ")).toContain("--pre");

    useLockDir();
    const { repo: repo2 } = initRepo();
    const relative = await probe(
      baseOptions(repo2, {
        isolation: "worktree",
        preCommand: "true",
        testCommand: "node fixture.test.js",
      }),
    );
    expect(relative.status).toBe("killed");
    expect(relative.reason).toBeUndefined();
  });

  // --- Round 3 (D-033 redesign): the two shapes round 2's tokenizer
  // still missed (a `sh -c` wrapper, a backslash-escaped space), the
  // third unscanned channel (`--env`), and the scratch-root wiring
  // pinned at the probe level (round 2's review found it unpinned). ---

  it("a sh -c wrapper naming the repository root is refused, even though the whole command is one shell-quoted string", async () => {
    useLockDir();
    const { repo } = initRepo();
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        testCommand: `sh -c "cd ${repo} && node fixture.test.js"`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    expect(result.warnings.join(" ")).toContain(repo);
  });

  it("a backslash-escaped space in an absolute repository path is refused", async () => {
    useLockDir();
    const { repo } = initRepo();
    const spacedParent = makeTmpDir();
    const spacedRepoDir = path.join(spacedParent, "my repo");
    fs.renameSync(repo, spacedRepoDir);
    const escaped = spacedRepoDir.replace(/ /g, "\\ ");
    const result = await probe(
      baseOptions(spacedRepoDir, {
        isolation: "worktree",
        testCommand: `cd ${escaped} && node fixture.test.js`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
  });

  it("an --env value carrying the repository root is refused, naming --env <NAME> in the message, even though neither command string mentions the root directly", async () => {
    useLockDir();
    const { repo } = initRepo();
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        env: { REPO: repo },
        testCommand: `sh -c 'cd "$REPO" && node fixture.test.js'`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    expect(result.warnings.join(" ")).toContain("--env REPO");
    expect(result.warnings.join(" ")).toContain(repo);
  });

  it("an --env value naming a path OUTSIDE the repository root is not refused", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outside = makeTmpDir();
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        env: { OUTSIDE: outside },
        testCommand: "node fixture.test.js",
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  it("an absolute path under a --log-dir pointed inside the repository does not trigger the refusal (the scratch-root exemption; the round-2 survivor)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = path.join(repo, "aplogs");
    fs.mkdirSync(logDir, { recursive: true });
    const underLogDir = path.join(logDir, "wt-1", "wt");
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        logDir,
        // The absolute mention resolves under this run's own --log-dir
        // (the scratch root), so it must not read as an escape; the
        // command still runs for real (a relative `node
        // fixture.test.js`), so this reaches an actual kill/survive
        // verdict rather than merely avoiding a refusal.
        testCommand: `echo ${underLogDir} > /dev/null && node fixture.test.js`,
      }),
    );
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("killed");
  });

  it("pins the load-bearing fragments of the isolation-escape refusal message against the shared message constants", () => {
    expect(ISOLATION_ESCAPE_FIX_HINT).toContain("--isolation inplace");
    expect(ISOLATION_ESCAPE_FIX_HINT).toContain("--link");
    expect(ISOLATION_ESCAPE_CHANNEL_LABEL.pre).toBe("--pre");
    expect(ISOLATION_ESCAPE_CHANNEL_LABEL.env("REPO")).toBe("--env REPO");
  });

  it("a refusal on this path leaves no worktree, lock, or marker behind", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const result = await probe(
      baseOptions(repo, {
        isolation: "worktree",
        testCommand: `cd ${repo} && node fixture.test.js`,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("test_command_escapes_isolation");
    // Only the main worktree (the repo itself) is registered: no linked
    // worktree was ever added, since the refusal happens before
    // `beginWorktree` runs at all.
    expectNoIsolationLeftovers(repo, lockDir);
  });
});
