import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";

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

// Both lines are exactly the same length (18 characters): a same-length
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
 * Runs `test_fixture.py` directly (never through `probe()`), forcing
 * CPython's DEFAULT co-located `__pycache__` cache location regardless
 * of a host's own compiled-in default: `-X pycache_prefix=` (empty)
 * takes precedence over both a compiled-in default (macOS's system
 * python redirects to a Caches directory unless overridden) and
 * `PYTHONPYCACHEPREFIX`, confirmed by reading `sys.pycache_prefix`
 * under each during this task's own reproduction. Used only for this
 * file's bystander invocations -- the pre-warm below, and the
 * post-restore verification run -- never for the string handed to
 * `probe()` as `-t`, which stays an ordinary test command with no
 * knowledge of this package's own isolation, the same as a real
 * caller's would.
 */
function runFixtureTest(repo: string): { status: number | null } {
  const result = spawnSync(
    "python3",
    ["-X", "pycache_prefix=", "test_fixture.py"],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PYTHONPYCACHEPREFIX: "" },
    },
  );
  return { status: result.status };
}

/** The one `.pyc` CPython cached for `fixture.py` under the co-located
 * `__pycache__` `runFixtureTest` forces. Throws (fails the test loudly)
 * if the pre-warm did not actually cache anything, rather than letting
 * a later assertion fail confusingly far from the real cause. */
function fixturePycPath(repo: string): string {
  const dir = path.join(repo, "__pycache__");
  const hit = fs
    .readdirSync(dir)
    .find((f) => f.startsWith("fixture.") && f.endsWith(".pyc"));
  if (hit === undefined) {
    throw new Error(`no cached bytecode for fixture.py found in ${dir}`);
  }
  return path.join(dir, hit);
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

      // Pre-warm: run the ORIGINAL source's test once, forcing
      // CPython's default co-located cache location, so the hazard's
      // precondition (a __pycache__ entry sitting there BEFORE probe
      // ever runs) is real, not merely asserted.
      const warm = runFixtureTest(repo);
      expect(warm.status).toBe(0);
      const pycPath = fixturePycPath(repo);
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

      // The co-located cache from the pre-warm was never touched by
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
      const pycPath = fixturePycPath(repo);
      const beforeProbeHeader = readPycHeader(pycPath);

      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("killed");

      // Restored: source content is back to exactly the original.
      expect(fs.readFileSync(path.join(repo, "fixture.py"), "utf8")).toBe(
        FIXTURE_PY,
      );

      // The co-located cache was never shadowed by mutant bytecode in
      // the first place -- this is what closes the false-red
      // direction: there is nothing stale left behind to invalidate or
      // not, because probe's own runs never wrote there at all.
      expect(readPycHeader(pycPath)).toEqual(beforeProbeHeader);

      // A bystander running the bare test command directly (never
      // through probe -- a follow-up CI step, a developer re-running
      // the suite by hand) against the restored file, with the
      // pre-warmed cache still sitting there, must pass.
      const after = runFixtureTest(repo);
      expect(after.status).toBe(0);
    },
  );
});
