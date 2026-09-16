import fs from "node:fs";
import path from "node:path";

/**
 * CPython's own bytecode cache: a `__pycache__/*.pyc` file is loaded
 * WITHOUT recompiling its source whenever the cache header's stored
 * `(mtime, size)` matches the source file's own `(mtime, size)` --
 * nothing about the source's actual CONTENT is compared. `probe`'s own
 * apply and restore both write a target with a fresh timestamp (never
 * one it deliberately preserves; see `isolation.ts`'s `beginInplace`),
 * but CPython's stored mtime is whole SECONDS (`struct pack('<I',
 * int(mtime))`), so an apply, its test run, and a restore that all land
 * inside the same wall-clock second -- the ordinary case for a fast
 * suite -- can leave a same-length mutant's replacement content behind
 * an unchanged `(mtime, size)` pair. Two directions follow: a mutant
 * run can execute the STALE (pre-mutation) bytecode still cached from
 * the baseline, reporting `survived` for a mutant the source really
 * would fail; and once the file is restored, a bystander run (the
 * regression suite, a follow-up CI step) can execute MUTANT bytecode
 * left behind by the mutant's own run, reporting a genuinely-passing
 * restored file as red.
 *
 * Both directions are closed the same way: every `--pre`/test-command
 * invocation this package makes against a run with at least one Python
 * target gets its OWN brand-new, previously-unused cache directory via
 * `PYTHONPYCACHEPREFIX` (see `beginPyCacheIsolation`). A fresh directory
 * has nothing cached in it yet, so CPython recompiles unconditionally
 * regardless of what mtime/size coincidence would otherwise apply --
 * this holds independent of the whole-second explanation above; it
 * would also hold against a hypothetical sub-second cache format. Never
 * reused across invocations (baseline vs. a mutant's own run, or two
 * mutants of the same plan): reusing one directory across invocations
 * would just relocate the hazard rather than close it, since the second
 * invocation could then collide with the first invocation's own entry
 * exactly the way the co-located default does today.
 *
 * This is the "isolated cache location" mechanism (not cache
 * invalidation, and not a refusal): see the README's "Python bytecode
 * cache" section for the trade-off against the two mechanisms not
 * chosen, and this package's CHANGELOG for why.
 */

/** True when `targetPaths` includes at least one Python source file
 * (`.py`, case-insensitively): the only extension CPython's bytecode
 * cache applies to. `runPreThenTest`'s two callers (`setup.ts`'s
 * baseline run, `step.ts`'s per-mutant run) use this once, computed
 * from the run's own distinct target files, to decide whether THIS
 * run's `--pre`/test-command invocations pay for cache isolation at
 * all: a run whose targets are all some other language never does. */
export function hasPythonTarget(targetPaths: string[]): boolean {
  return targetPaths.some((p) => p.toLowerCase().endsWith(".py"));
}

/** One invocation's isolation: the `PYTHONPYCACHEPREFIX` env fragment to
 * merge on top of the invocation's own environment, and a best-effort
 * cleanup of the directory it points at. */
export interface PyCacheIsolation {
  env: NodeJS.ProcessEnv;
  /** Removes the directory `env.PYTHONPYCACHEPREFIX` names. Never
   * throws: a directory left behind by a failed removal is clutter
   * under the run's own log dir, never a correctness problem, since the
   * NEXT invocation always gets its own fresh directory regardless of
   * whether this one's was ever cleaned up. */
  cleanup: () => void;
}

export type PyCacheIsolationResult =
  { ok: true; isolation: PyCacheIsolation } | { ok: false; message: string };

/**
 * Creates a fresh, empty, uniquely-named directory under `logDir` and
 * returns the `PYTHONPYCACHEPREFIX` fragment pointed at it. `logDir` is
 * this run's own log directory (already created, already the place an
 * operator inspecting this run's artifacts looks), not a bare
 * `os.tmpdir()` mkdtemp: an isolation directory is exactly the kind of
 * per-run artifact the log dir already exists to hold, and colocating it
 * there means a failed cleanup leaves the leftover somewhere the rest of
 * this run's evidence already is, rather than scattered in the system
 * temp directory with nothing tying it back to this probe run.
 *
 * The only failure mode is `fs.mkdtempSync` itself throwing (an
 * unwritable or full `logDir`): reported as `ok: false` rather than
 * silently continuing un-isolated, since a caller that fell back to the
 * ambient (co-located) cache would reintroduce the exact hazard this
 * exists to close. A caller that gets `ok: false` refuses the run
 * instead (this package's exit-2 "cannot guarantee a verdict" path),
 * restoring any mutation already applied first.
 */
export function beginPyCacheIsolation(logDir: string): PyCacheIsolationResult {
  let dir: string;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    dir = fs.mkdtempSync(path.join(logDir, "pycache-"));
  } catch (err) {
    return {
      ok: false,
      message:
        `could not create an isolated Python bytecode cache directory ` +
        `under ${logDir} (${(err as Error).message}); refusing rather ` +
        `than running the Python target's test command against the ` +
        `ambient, potentially stale __pycache__`,
    };
  }
  return {
    ok: true,
    isolation: {
      env: { PYTHONPYCACHEPREFIX: dir },
      cleanup: () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort; see the docblock above.
        }
      },
    },
  };
}
