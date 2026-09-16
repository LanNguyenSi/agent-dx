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
 * directory) and the README's "Python bytecode cache" section for the
 * trade-off against the two mechanisms not chosen.
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
 */
function ambientPycPath(repo: string): string {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, sys; print(importlib.util.cache_from_source(sys.argv[1]))",
      "fixture.py",
    ],
    { cwd: repo, encoding: "utf8" },
  );
  const resolved = result.stdout?.trim();
  if (result.status !== 0 || !resolved) {
    throw new Error(
      `could not resolve fixture.py's own cache path via python3: ${result.stderr}`,
    );
  }
  return resolved;
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
      // Logs the `PYTHONPYCACHEPREFIX` this invocation actually saw (or
      // an empty line when unset) before importing `fixture`, so this
      // test can tell the baseline's own invocation and each mutant's
      // own invocation apart by directory, not merely by pass/fail.
      const loggingTest = [
        "import os",
        "with open('pycache_env_log.txt', 'a') as f:",
        "    f.write((os.environ.get('PYTHONPYCACHEPREFIX') or '') + chr(10))",
        "from fixture import check",
        "assert check('?') is True",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(repo, "test_logging.py"), loggingTest);
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add logger"],
        { cwd: repo },
      );

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

      const logPath = path.join(repo, "pycache_env_log.txt");
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
});
