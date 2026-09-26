import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { probe, probePlan, type ProbeOptions } from "../src/probe/index.js";

/**
 * Regression coverage for CPython's own bytecode-cache validation:
 * `__pycache__/*.pyc` is trusted whenever its stored `(mtime, size)`
 * matches the source file's `(mtime, size)`, with NOTHING about actual
 * content compared. A same-length mutant `probe` applies (and later
 * restores) can leave that pair unchanged, in two directions: a mutant
 * run can execute STALE (pre-mutation) bytecode still cached from
 * before the mutant was applied (false `survived`), and once restored,
 * a bystander run can execute MUTANT bytecode a probe's own mutant run
 * left cached (false red). See `src/probe/pycache.ts` for the fix
 * (every `--pre`/test-command invocation of a run with a Python target
 * gets its own fresh, previously-unused `PYTHONPYCACHEPREFIX`
 * directory) and docs/non-js-test-runners.md's "Python bytecode cache"
 * section for the trade-off against the two mechanisms not chosen.
 */

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-pycache-test-"),
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

/** Every test gets its own lock dir, so a leftover lock/marker from one
 * test can never be observed by another (same idiom as probe.test.ts's
 * own `useLockDir`). */
function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

/** Whether python3 is on PATH: every test in this file needs a real
 * CPython to reproduce and verify its own bytecode-cache validation
 * (the pyc header's magic/flags/mtime/size), so where it is absent
 * every test here is skipped rather than silently weakened -- named
 * explicitly (mirrors `cli.test.ts`'s own `HAS_MKFIFO` seam) so a
 * skipped run is visible in the suite's own output rather than quietly
 * passing zero assertions. */
const HAS_PYTHON3 = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Both lines are exactly the same length (19 characters): a same-length
// mutant, the shape CPython's `(mtime, size)` validation cannot tell
// apart from the unmutated file by size alone.
const FIXTURE_PY = ["def check(x):", "    return x == '?'", ""].join("\n");
const MUTATED_LINE = "    return x == 'x'";

// A plain assert script, never `pytest`/`unittest`: parity with this
// file's neighbors (`probe.test.ts`'s own `FIXTURE_TEST_JS` is the same
// shape, `require` plus `assert.strictEqual`), and it needs nothing
// beyond the standard library, so no test-runner package has to be
// installed on the host running this suite (including CI). Importing
// `fixture` here is what triggers CPython's normal bytecode caching for
// `fixture.py`; `test_fixture.py` itself, run as the main script, is
// never itself cached.
const FIXTURE_TEST_PY = [
  "from fixture import check",
  "assert check('?') is True",
  "",
].join("\n");

// Same assertion `FIXTURE_TEST_PY` makes, plus one line appending
// whatever `PYTHONPYCACHEPREFIX` THIS invocation actually saw (or an
// empty line when unset) to a log file first: lets a test tell separate
// invocations of the same run apart by the directory each one actually
// got, not merely by pass/fail.
const LOGGING_TEST_PY = [
  "import os",
  "with open('pycache_env_log.txt', 'a') as f:",
  "    f.write((os.environ.get('PYTHONPYCACHEPREFIX') or '') + chr(10))",
  "from fixture import check",
  "assert check('?') is True",
  "",
].join("\n");

/** Writes and commits `LOGGING_TEST_PY` as `test_logging.py` in `repo`
 * (already an `initPyRepo()` repo), and returns the log file it
 * appends to. */
function addLoggingTest(repo: string): string {
  fs.writeFileSync(path.join(repo, "test_logging.py"), LOGGING_TEST_PY);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add logger"]);
  return path.join(repo, "pycache_env_log.txt");
}

function initPyRepo(): { repo: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "fixture.py"), FIXTURE_PY);
  fs.writeFileSync(path.join(repo, "test_fixture.py"), FIXTURE_TEST_PY);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo };
}

/**
 * The exact `.pyc` path CPython's own import machinery uses for
 * `fixture.py`, resolved by asking python3 itself
 * (`importlib.util.cache_from_source`) rather than assumed to be
 * co-located `__pycache__`: a host whose python3 redirects its cache
 * elsewhere by default (macOS's own system python3 redirects to a
 * per-user Caches directory unless `PYTHONPYCACHEPREFIX`/
 * `-X pycache_prefix` overrides it) still
 * resolves to the SAME path this file's own ambient (unoverridden)
 * invocations actually use, so the pre-warm and the post-restore
 * bystander run below are provably looking at the one location that
 * matters, on any host -- not merely wherever the common case happens
 * to put it.
 *
 * The source path handed to `cache_from_source` is absolute and REAL
 * (`fs.realpathSync`), and the answer is resolved against that same
 * real directory. Both halves are load-bearing, for the two shapes
 * `cache_from_source` has, and it is a pure string transform in each:
 *
 * - With no cache prefix set (every ordinary host, the Linux CI
 *   included), a relative `fixture.py` answers the equally relative
 *   `__pycache__/fixture.cpython-3X.pyc`, which every `fs` call here
 *   would resolve against the VITEST process's own cwd (this package)
 *   rather than the fixture repository.
 * - With a prefix set (macOS's own system python3 redirects to a
 *   per-user Caches directory), the answer is absolute either way, but
 *   the prefix is joined with the source's own directory, and for a
 *   relative source that directory comes from `os.getcwd()`, which is
 *   always the REAL path. A `mkdtemp` path on macOS is reached through
 *   the `/var -> /private/var` symlink, so the unresolved spelling
 *   answers a directory under the prefix that the interpreter's own
 *   imports never write to.
 *
 * Asking about the real absolute path satisfies both: it is what the
 * interpreter's own unoverridden imports of that file resolve to.
 */
function ambientPycPath(repo: string): string {
  const realRepo = fs.realpathSync(repo);
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, sys; print(importlib.util.cache_from_source(sys.argv[1]))",
      path.join(realRepo, "fixture.py"),
    ],
    { cwd: realRepo, encoding: "utf8" },
  );
  const resolved = result.stdout?.trim();
  if (result.status !== 0 || !resolved) {
    throw new Error(
      `could not resolve fixture.py's own cache path via python3: ${result.stderr}`,
    );
  }
  return path.resolve(realRepo, resolved);
}

/** Runs `test_fixture.py` directly (never through `probe()`), with NO
 * cache-location override at all: exactly the ambient default this
 * host's python3 applies on its own (co-located `__pycache__` on most
 * hosts, a per-user Caches redirect on macOS's system python3). Used
 * only for this file's own bystander invocations -- the pre-warm below,
 * and the post-restore verification run -- never for the string handed
 * to `probe()` as `-t` (`baseOptions` below), which is likewise
 * ordinary, so both this file's bystander runs and an UNISOLATED
 * baseline/mutant run (the shape a mutation probe that disables this
 * package's own cache isolation reproduces) consult the very same
 * location this resolves.
 */
function runFixtureTest(repo: string): { status: number | null } {
  const result = spawnSync("python3", ["test_fixture.py"], {
    cwd: repo,
    encoding: "utf8",
  });
  return { status: result.status };
}

interface PycHeader {
  magic: string;
  flags: number;
  mtime: number;
  size: number;
}

/** Reads a Python 3.7+ `.pyc` header's first 16 bytes (magic: 4 bytes,
 * flags: 4 bytes, mtime: 4 bytes, size: 4 bytes, all little-endian):
 * proves the MECHANISM (the stored validation pair CPython checks
 * against the source's own `(mtime, size)`), not merely the symptom (a
 * test's pass/fail exit code). */
function readPycHeader(pycPath: string): PycHeader {
  const buf = fs.readFileSync(pycPath);
  return {
    magic: buf.subarray(0, 4).toString("hex"),
    flags: buf.readUInt32LE(4),
    mtime: buf.readUInt32LE(8),
    size: buf.readUInt32LE(12),
  };
}

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.py",
    line: 2,
    form: "replace",
    replaceText: MUTATED_LINE,
    testCommand: "python3 test_fixture.py",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("probe(): CPython bytecode-cache isolation", () => {
  it.skipIf(!HAS_PYTHON3)(
    "criterion 2: a pre-warmed __pycache__ entry does not shadow a same-length mutant the test genuinely kills; probe reports killed",
    async () => {
      useLockDir();
      const { repo } = initPyRepo();

      // Pre-warm: run the ORIGINAL source's test once, under this
      // host's own ambient cache location (no override), so the
      // hazard's precondition (a cache entry sitting there BEFORE
      // probe ever runs) is real, not merely asserted.
      const warm = runFixtureTest(repo);
      expect(warm.status).toBe(0);
      const pycPath = ambientPycPath(repo);
      const beforeHeader = readPycHeader(pycPath);

      // The mechanism, not the symptom: the cached header's own stored
      // (mtime, size) already match the (still-original) source before
      // probe applies anything -- exactly the pair CPython trusts
      // without ever re-reading the source's content.
      const sourceStat = fs.statSync(path.join(repo, "fixture.py"));
      expect(beforeHeader.mtime).toBe(Math.floor(sourceStat.mtimeMs / 1000));
      expect(beforeHeader.size).toBe(sourceStat.size);

      const result = await probe(baseOptions(repo));

      expect(result.status).toBe("killed");
      expect(result.mutation_probe?.result).toBe("killed");
      expect(result.mutation_probe?.expectation).toBe("met");

      // The ambient cache from the pre-warm was never touched by
      // probe's own (isolated) runs: still exactly what the pre-warm
      // produced.
      expect(readPycHeader(pycPath)).toEqual(beforeHeader);
    },
  );

  it.skipIf(!HAS_PYTHON3)(
    "criterion 3: after probe restores the file, the test command still passes with the pre-warmed cache in place (no false red)",
    async () => {
      useLockDir();
      const { repo } = initPyRepo();

      const warm = runFixtureTest(repo);
      expect(warm.status).toBe(0);
      const pycPath = ambientPycPath(repo);
      const beforeProbeHeader = readPycHeader(pycPath);

      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("killed");

      // Restored: source content is back to exactly the original.
      expect(fs.readFileSync(path.join(repo, "fixture.py"), "utf8")).toBe(
        FIXTURE_PY,
      );

      // The ambient cache was never shadowed by mutant bytecode in the
      // first place -- this is what closes the false-red direction:
      // there is nothing stale left behind to invalidate or not,
      // because probe's own runs never wrote there at all.
      expect(readPycHeader(pycPath)).toEqual(beforeProbeHeader);

      // A bystander running the bare test command directly (never
      // through probe -- a follow-up CI step, a developer re-running
      // the suite by hand) against the restored file, with the
      // pre-warmed ambient cache still sitting there, must pass.
      const after = runFixtureTest(repo);
      expect(after.status).toBe(0);
    },
  );

  it.skipIf(!HAS_PYTHON3)(
    "a plan's two mutants over the same Python target each get their own, distinct isolation directory",
    async () => {
      useLockDir();
      const { repo } = initPyRepo();
      const logPath = addLoggingTest(repo);

      const result = await probePlan({
        mutants: [
          {
            file: "fixture.py",
            line: 2,
            form: "replace",
            replaceText: MUTATED_LINE,
          },
          {
            file: "fixture.py",
            line: 2,
            form: "replace",
            replaceText: MUTATED_LINE,
          },
        ],
        testCommand: "python3 test_logging.py",
        isolation: "inplace",
        expect: "fail",
        cwd: repo,
        logDir: makeTmpDir(),
      });

      expect(result.results[0]?.status).toBe("killed");
      expect(result.results[1]?.status).toBe("killed");

      const lines = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      // Baseline (1) + two mutants (2) = 3 invocations of this run's own
      // test command, each isolated.
      expect(lines).toHaveLength(3);
      // Every invocation actually got a `PYTHONPYCACHEPREFIX` (never
      // empty: isolation applied every time, not merely sometimes).
      for (const line of lines) expect(line.length).toBeGreaterThan(0);
      // No two invocations, including the two mutants that share the
      // same file, ever shared a directory.
      expect(new Set(lines).size).toBe(3);
    },
  );

  it.skipIf(!HAS_PYTHON3)(
    "the caller's own --env PYTHONPYCACHEPREFIX is honoured: this run's own isolation is skipped entirely and the caller's value reaches every invocation, with a named warning",
    async () => {
      useLockDir();
      const { repo } = initPyRepo();
      const logPath = addLoggingTest(repo);
      const callerDir = makeTmpDir();

      const result = await probe(
        baseOptions(repo, {
          testCommand: "python3 test_logging.py",
          env: { PYTHONPYCACHEPREFIX: callerDir },
          // A DIFFERENT-length mutant, deliberately, not the
          // same-length `MUTATED_LINE` `baseOptions` defaults to:
          // isolation is genuinely skipped for this whole run (that is
          // what this test proves), so a same-length mutant here would
          // hit the very `(mtime, size)` hazard this package's own
          // isolation exists to close, making THIS test's own verdict
          // unreliable rather than proving the env plumbing this test
          // actually targets.
          replaceText: "    return False",
        }),
      );

      expect(result.status).toBe("killed");
      // Both the baseline's own invocation and the mutant's own
      // invocation saw the SAME caller-named directory: isolation was
      // skipped for the whole run, not merely for one phase.
      const lines = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toEqual([callerDir, callerDir]);
      // The envelope echoes the caller's own `--env` value back,
      // truthfully -- this is what actually reached the child, not a
      // value this package silently overrode.
      expect(result.test?.env?.PYTHONPYCACHEPREFIX).toBe(callerDir);
      // The hazard is named, and the caller's own value is named in it.
      expect(
        result.warnings.some(
          (w) =>
            w.includes("PYTHONPYCACHEPREFIX") &&
            w.includes(callerDir) &&
            w.includes("skipped"),
        ),
      ).toBe(true);
      // The warning points at the doc that actually holds the section
      // (moved out of the README in #381), not a section absent from
      // README.md.
      expect(
        result.warnings.some((w) =>
          w.includes(
            'agent-primitives docs/non-js-test-runners.md "Python bytecode cache"',
          ),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!HAS_PYTHON3)(
    "without a caller override, isolation still applies as usual and the warning names the variable generically (no caller value to name)",
    async () => {
      useLockDir();
      const { repo } = initPyRepo();
      const logPath = addLoggingTest(repo);

      const result = await probe(
        baseOptions(repo, { testCommand: "python3 test_logging.py" }),
      );

      expect(result.status).toBe("killed");
      const lines = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      // Baseline + mutant: two invocations, neither empty, and never
      // sharing a directory -- isolation applied both times.
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.length).toBeGreaterThan(0);
      expect(lines[0]).not.toBe(lines[1]);
      // No `--env` was given, so the envelope carries no `test.env` at
      // all (see `TestPhaseField.env`'s own docblock).
      expect(result.test?.env).toBeUndefined();
      expect(
        result.warnings.some(
          (w) =>
            w.includes("PYTHONPYCACHEPREFIX") && w.includes("baseline_failed"),
        ),
      ).toBe(true);
      expect(result.warnings.some((w) => w.includes("skipped"))).toBe(false);
      // Same pointer check for the no-override branch's own warning.
      expect(
        result.warnings.some((w) =>
          w.includes(
            'agent-primitives docs/non-js-test-runners.md "Python bytecode cache"',
          ),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!HAS_PYTHON3)(
    "the post-restore --pre rebuild under -i inplace is isolated too, leaving the ambient cache untouched",
    async () => {
      useLockDir();
      const { repo } = initPyRepo();
      const pycPath = ambientPycPath(repo);
      // No pre-warm here: the ambient cache does not exist before this
      // run at all, so "untouched" below means "still does not exist"
      // -- a `--pre` that escaped isolation on its post-restore re-run
      // would create it.
      expect(fs.existsSync(pycPath)).toBe(false);

      const result = await probe(
        baseOptions(repo, {
          preCommand: 'python3 -c "import fixture"',
        }),
      );

      expect(result.status).toBe("killed");
      // Confirms the post-restore rebuild actually ran (a no-op outside
      // `-i inplace` with `--pre` given, per `runFinalRebuild`'s own
      // docblock).
      expect(
        result.warnings.some((w) =>
          w.includes("--pre was re-run after the last mutant was restored"),
        ),
      ).toBe(true);
      // The one path an unisolated post-restore `--pre` would have
      // written: still absent.
      expect(fs.existsSync(pycPath)).toBe(false);
    },
  );
});
