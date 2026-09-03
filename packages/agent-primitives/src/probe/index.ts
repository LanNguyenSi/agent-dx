import fs from "node:fs";
import path from "node:path";
import { execCommand, type ExecResult } from "../exec.js";
import { sha256File } from "../hash.js";
import {
  acquireLock,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../lock.js";
import { containmentRoot, isPathContained } from "./containment.js";
import { beginInplace, type InplaceSession } from "./isolation.js";
import {
  applyPatchForReal,
  computeMutant,
  formatMutantSummary,
  formatVerifiedAppliedVia,
  type MutantForm,
  type MutantSpec,
} from "./mutant.js";

export type IsolationMode = "worktree" | "inplace";
export type ExpectVerdict = "fail" | "pass";

export interface ProbeOptions {
  /** As given on the CLI; resolved against `cwd`. */
  file: string;
  line: number;
  form: MutantForm;
  replaceText?: string;
  matchText?: string;
  withText?: string;
  patchPath?: string;
  testCommand: string;
  preCommand?: string;
  isolation: IsolationMode;
  expect: ExpectVerdict;
  /** Timeout in milliseconds, applied to every `--pre`/`-t` invocation. */
  timeoutMs?: number;
  links?: string[];
  allowOutside?: boolean;
  cwd: string;
  logDir: string;
}

export interface MutantField {
  file: string;
  line: number;
  before: string;
  after: string;
  form: MutantForm;
}

export interface MutationProbeField {
  mutant: string;
  verified_applied_via: string;
  result: string;
  restored_verified: boolean;
}

export interface ExecPhaseField {
  exitCode: number | null;
  durationMs: number;
  logPath: string;
}

export interface TestPhaseField extends ExecPhaseField {
  command: string;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
}

export interface IsolationField {
  mode: IsolationMode;
  path: string | null;
  linked: string[];
  syncedTrackedFiles: string[];
  syncedUntrackedFiles: string[];
}

export type ProbeStatus =
  "killed" | "survived" | "inconclusive" | "usage_error";

export interface ProbeResult {
  status: ProbeStatus;
  reason?: string;
  warnings: string[];
  mutant?: MutantField;
  mutation_probe?: MutationProbeField;
  baseline?: ExecPhaseField;
  test?: TestPhaseField;
  isolation: IsolationField;
  /** Exec log paths produced while computing the mutant (the dry-run
   * `git apply` and `--numstat` check for `patch`; empty otherwise).
   * The caller (`cli.ts`) folds this together with `baseline`/`test`'s
   * own `logPath` into the envelope's `logs`. */
  dryRunLogPaths?: string[];
}

function emptyIsolationField(mode: IsolationMode): IsolationField {
  return {
    mode,
    path: null,
    linked: [],
    syncedTrackedFiles: [],
    syncedUntrackedFiles: [],
  };
}

/** Restores `session` and verifies the restore by hash. A restore whose
 * copy itself throws is treated the same as a restore that copies but
 * lands on the wrong content: both fail `verified`. */
async function restoreAndVerify(
  session: InplaceSession,
  preHash: string,
): Promise<{ ok: boolean; verified: boolean }> {
  let ok = false;
  try {
    ok = session.restore();
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, verified: false };
  const restoredHash = await sha256File(session.targetPath).catch(
    () => undefined,
  );
  return { ok: true, verified: restoredHash === preHash };
}

interface RestoreState {
  /** The same `InplaceSession.restore` used by the normal (non-signal)
   * control flow: the signal path must reuse it rather than duplicate
   * the copy logic, so a bug in the restore implementation breaks both
   * paths identically (and is caught by mutating just the one place). */
  restore: () => boolean;
  /** The file's path as seen by `session.restore()`/hashing (the
   * display path, not necessarily the resolved realpath used for the
   * lock/marker key). */
  targetPath: string;
  /** The identity used to key the marker (the resolved realpath), so an
   * emergency restore removes the same marker the normal flow would. */
  markerKey: string;
  backupPath: string;
  preHash: string;
}

/**
 * Installs SIGINT/SIGTERM handlers scoped to one `probe()` call: on
 * either signal, if a mutation is currently in flight (per
 * `getRestoreState`), restores the target via the session's own
 * `restore()` and removes the marker (only when that restore itself
 * succeeded, so a failed emergency restore still leaves the marker for
 * the next invocation to recover), releases the lock, then exits.
 * Returns a function that removes exactly these two handlers, so
 * concurrent `probe()` calls in the same process never interfere with
 * each other's signal handling.
 */
function installCrashHandlers(
  getRestoreState: () => RestoreState | null,
  releaseLock: () => void,
): () => void {
  const handler = (signal: NodeJS.Signals) => {
    const state = getRestoreState();
    if (state) {
      let restored = false;
      try {
        restored = state.restore();
      } catch {
        // Best-effort: a failed emergency restore leaves the marker in
        // place, which is exactly what lets the next invocation recover.
      }
      if (restored) removeMarkerFor(state.markerKey);
    }
    try {
      releaseLock();
    } catch {
      // Best-effort.
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

/** Resolves `p` to its realpath, falling back to `p` itself when that
 * fails (e.g. the path does not exist yet): the caller always has a
 * usable value, and a missing `--file` still fails later, at the same
 * point (`sha256File`) it always has, instead of failing opaquely here. */
function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

type RunPhaseResult =
  { ok: true; test: ExecResult } | { ok: false; pre: ExecResult };

/** Runs `--pre` (if given) then the test command, both against `env`.
 * A non-zero `--pre` exit short-circuits before the test ever runs, so
 * the caller can classify it as `pre_failed` instead of quietly letting
 * a stale build (or any other `--pre` failure) produce a false verdict. */
async function runPreThenTest(
  opts: Pick<ProbeOptions, "preCommand" | "testCommand">,
  env: { cwd: string; logDir: string; timeoutMs?: number },
): Promise<RunPhaseResult> {
  if (opts.preCommand) {
    const pre = await execCommand(opts.preCommand, env);
    if (pre.exitCode !== 0) return { ok: false, pre };
  }
  const test = await execCommand(opts.testCommand, env);
  return { ok: true, test };
}

/**
 * Runs the full probe pipeline: lock -> containment -> stale-marker
 * recovery -> baseline -> mutate -> pre+test -> restore -> verify ->
 * classify. See 01-plan.md's "`probe`: mutation-probe runner" section
 * for the full contract this implements.
 */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const warnings: string[] = [];
  const isolationField = emptyIsolationField(opts.isolation);

  if (opts.isolation === "worktree") {
    return {
      status: "usage_error",
      reason: "not_implemented",
      warnings,
      isolation: isolationField,
    };
  }

  // `--allow-outside` places the scratch copy for a `-p` dry run at
  // `--file`'s path relative to the containment root; when `--file` is
  // allowed to resolve outside that root, that relative path can carry
  // `../` components that escape the scratch directory entirely (a real
  // path-traversal risk, not just a usability gap). Rejected outright
  // rather than reworked into a basename-only placement, which would
  // still have to reject any patch whose own diff headers name a
  // different relative path.
  if (opts.form === "patch" && opts.allowOutside) {
    return {
      status: "usage_error",
      reason: "patch_allow_outside_unsupported",
      warnings: [
        ...warnings,
        "-p/--patch cannot be combined with --allow-outside",
      ],
      isolation: isolationField,
    };
  }

  const cwd = path.resolve(opts.cwd);
  const displayFile = path.resolve(cwd, opts.file);
  const root = containmentRoot(cwd);
  const links = opts.links ?? [];
  const displayLinks = links.map((l) => path.resolve(cwd, l));

  // Containment and the lock/marker key are resolved through realpath
  // (before either check), so an in-repo symlink pointing outside the
  // root cannot be used to mutate a file the containment check would
  // otherwise have refused. Everything else (the mutation itself,
  // hashing, `mutant.file`, warnings) keeps using the display paths:
  // writes through a symlink already reach the same physical file, and
  // showing the user's own path (rather than a resolved realpath, which
  // can differ even with no symlink involved, e.g. macOS's `/var` ->
  // `/private/var`) is what "display the user path" means here.
  const realRoot = tryRealpath(root);
  const absFile = tryRealpath(displayFile);
  const absLinks = displayLinks.map(tryRealpath);

  const lockResult = acquireLock(absFile);
  if (!lockResult.ok) {
    return {
      status: "inconclusive",
      reason: lockResult.reason,
      warnings:
        lockResult.reason === "lock_unavailable"
          ? [...warnings, lockResult.detail]
          : warnings,
      isolation: isolationField,
    };
  }

  let restoreState: RestoreState | null = null;
  // Populated inside the try block as soon as each becomes known, so the
  // `finally` block's emergency-restore path can build a full result
  // even when it is reached via a thrown error partway through.
  let mutantField: MutantField | undefined;
  let mutantSummary: string | undefined;
  let verifiedAppliedVia: string | undefined;
  let baseline: ExecPhaseField | undefined;
  const removeCrashHandlers = installCrashHandlers(
    () => restoreState,
    lockResult.release,
  );

  try {
    if (!opts.allowOutside) {
      const outside = [
        { display: displayFile, real: absFile },
        ...links.map((_l, i) => ({
          display: displayLinks[i],
          real: absLinks[i],
        })),
      ].filter((p) => !isPathContained(realRoot, p.real));
      if (outside.length > 0) {
        return {
          status: "inconclusive",
          reason: "file_outside_root",
          warnings: [
            ...warnings,
            `outside the containment root (${root}): ${outside
              .map((p) => p.display)
              .join(", ")}`,
          ],
          isolation: isolationField,
        };
      }
    }

    const marker = readMarkerFor(absFile);
    if (marker) {
      // Under the lock, ANY marker for this target is an unfinished
      // probe: the lock already excludes a second live probe, and pids
      // recycle, so the marker's own `pid` field is not consulted here
      // (it is written for a human reading the marker file, nothing
      // more). Hash-based recovery is unconditional.
      const currentHash = fs.existsSync(displayFile)
        ? await sha256File(displayFile).catch(() => undefined)
        : undefined;
      if (currentHash !== undefined && currentHash === marker.mutatedHash) {
        let restored = false;
        try {
          fs.copyFileSync(marker.backupPath, displayFile);
          restored = true;
        } catch {
          restored = false;
        }
        const restoredHash = restored
          ? await sha256File(displayFile).catch(() => undefined)
          : undefined;
        if (!restored || restoredHash !== marker.preHash) {
          return {
            status: "inconclusive",
            reason: "stale_probe_marker",
            warnings: [
              ...warnings,
              `automatic recovery of a stale probe marker failed; backup at ${marker.backupPath}`,
            ],
            isolation: isolationField,
          };
        }
        removeMarkerFor(absFile);
        warnings.push("recovered_stale_probe");
      } else if (currentHash !== undefined && currentHash === marker.preHash) {
        // Already back at the pre-mutation content (e.g. a previous
        // invocation restored but crashed before removing the marker):
        // nothing to recover, just clear the stale marker and continue.
        removeMarkerFor(absFile);
        warnings.push(
          `removed a stale probe marker whose target already matched its recorded pre-mutation hash; backup at ${marker.backupPath}`,
        );
      } else {
        return {
          status: "inconclusive",
          reason: "stale_probe_marker",
          warnings: [
            ...warnings,
            `stale in-flight probe marker found for ${displayFile}; backup at ${marker.backupPath}`,
          ],
          isolation: isolationField,
        };
      }
    }

    const preHash = await sha256File(displayFile);
    const originalContent = fs.readFileSync(displayFile, "utf8");

    const mutantSpec: MutantSpec = {
      form: opts.form,
      file: displayFile,
      line: opts.line,
      replaceText: opts.replaceText,
      matchText: opts.matchText,
      withText: opts.withText,
      patchPath: opts.patchPath,
    };
    const computed = await computeMutant(mutantSpec, {
      root,
      logDir: opts.logDir,
      originalContent,
    });
    if (!computed.applicable) {
      return {
        status: "inconclusive",
        reason: "mutant_not_applicable",
        warnings: computed.reason ? [...warnings, computed.reason] : warnings,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    mutantField = {
      file: displayFile,
      line: opts.line,
      before: computed.before,
      after: computed.after,
      form: opts.form,
    };
    mutantSummary = formatMutantSummary(
      displayFile,
      opts.line,
      computed.before,
      computed.after,
    );
    verifiedAppliedVia = formatVerifiedAppliedVia(
      displayFile,
      opts.line,
      computed.before,
      computed.after,
    );

    // `--pre`/`-t` run in the invocation cwd (where the operator ran the
    // probe from), not the containment root: a probe run from a
    // subdirectory of a monorepo must see the same cwd its test command
    // would normally get. Containment and `git apply` (dry run and real
    // apply) still use `root`, since a patch's paths are relative to the
    // repository, not to wherever the probe was invoked from.
    const execEnv = {
      cwd,
      logDir: opts.logDir,
      timeoutMs: opts.timeoutMs,
    };

    // (2) baseline: unmutated, must exit 0.
    const baselineStart = Date.now();
    const baselineRun = await runPreThenTest(opts, execEnv);
    if (!baselineRun.ok) {
      return {
        status: "inconclusive",
        reason: "pre_failed",
        warnings: [
          ...warnings,
          `--pre exited ${baselineRun.pre.exitCode} during the baseline run; see ${baselineRun.pre.logPath}`,
        ],
        mutant: mutantField,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }
    const baselineTest = baselineRun.test;
    baseline = {
      exitCode: baselineTest.exitCode,
      durationMs: Date.now() - baselineStart,
      logPath: baselineTest.logPath,
    };
    if (baselineTest.exitCode !== 0) {
      return {
        status: "inconclusive",
        reason: "baseline_failed",
        warnings,
        baseline,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (3) marker, apply, verify the hash changed. `restoreState` is
    // assigned right after the backup exists (before `writeMarker`), so
    // a signal landing in the narrow window between the backup and the
    // marker write still has something to restore (a no-op restore,
    // since nothing has mutated yet) instead of leaving an orphaned
    // marker for the next invocation to puzzle over.
    const session = beginInplace(displayFile, opts.logDir);
    restoreState = {
      restore: session.restore,
      targetPath: session.targetPath,
      markerKey: absFile,
      backupPath: session.backupPath,
      preHash,
    };
    writeMarker(absFile, {
      targetPath: displayFile,
      backupPath: session.backupPath,
      preHash,
      mutatedHash: computed.mutatedHash,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });

    if (opts.form === "patch") {
      const applyResult = await applyPatchForReal(
        opts.patchPath ?? "",
        root,
        opts.logDir,
      );
      if (applyResult.exitCode !== 0) {
        const { ok, verified } = await restoreAndVerify(session, preHash);
        restoreState = null;
        if (verified) removeMarkerFor(absFile);
        if (!ok || !verified) {
          return {
            status: "inconclusive",
            reason: "restore_failed",
            warnings: [
              ...warnings,
              `restore failed; the original content is preserved at backup path ${session.backupPath}`,
            ],
            mutant: mutantField,
            mutation_probe: {
              mutant: mutantSummary,
              verified_applied_via: verifiedAppliedVia,
              result: "inconclusive",
              restored_verified: false,
            },
            baseline,
            isolation: isolationField,
            dryRunLogPaths: [...computed.logPaths, applyResult.logPath],
          };
        }
        return {
          status: "inconclusive",
          reason: "mutant_not_applicable",
          warnings: [
            ...warnings,
            `git apply failed against the real target after the dry run succeeded; see ${applyResult.logPath}`,
          ],
          baseline,
          isolation: isolationField,
          dryRunLogPaths: [...computed.logPaths, applyResult.logPath],
        };
      }
    } else {
      fs.writeFileSync(displayFile, computed.newContent);
    }

    const afterApplyHash = await sha256File(displayFile);
    if (afterApplyHash === preHash || afterApplyHash !== computed.mutatedHash) {
      const { ok, verified } = await restoreAndVerify(session, preHash);
      restoreState = null;
      if (verified) removeMarkerFor(absFile);
      if (!ok || !verified) {
        return {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed; the original content is preserved at backup path ${session.backupPath}`,
          ],
          mutant: mutantField,
          mutation_probe: {
            mutant: mutantSummary,
            verified_applied_via: verifiedAppliedVia,
            result: "inconclusive",
            restored_verified: false,
          },
          baseline,
          isolation: isolationField,
          dryRunLogPaths: computed.logPaths,
        };
      }
      throw new Error(
        `probe: mutation hash mismatch after apply for ${displayFile} (expected ${computed.mutatedHash}, got ${afterApplyHash})`,
      );
    }

    // (4) --pre then -t, mutated.
    const mutantRun = await runPreThenTest(opts, execEnv);
    if (!mutantRun.ok) {
      const { ok, verified } = await restoreAndVerify(session, preHash);
      restoreState = null;
      if (verified) removeMarkerFor(absFile);
      if (!ok || !verified) {
        return {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed; the original content is preserved at backup path ${session.backupPath}`,
          ],
          mutant: mutantField,
          mutation_probe: {
            mutant: mutantSummary,
            verified_applied_via: verifiedAppliedVia,
            result: "inconclusive",
            restored_verified: false,
          },
          baseline,
          isolation: isolationField,
          dryRunLogPaths: computed.logPaths,
        };
      }
      return {
        status: "inconclusive",
        reason: "pre_failed",
        warnings: [
          ...warnings,
          `--pre exited ${mutantRun.pre.exitCode} during the mutant run; see ${mutantRun.pre.logPath}`,
        ],
        mutant: mutantField,
        baseline,
        isolation: isolationField,
        dryRunLogPaths: [...computed.logPaths, mutantRun.pre.logPath],
      };
    }
    const testResult = mutantRun.test;

    // (5) restore, (6) verify restore by hash.
    const { ok: restoreOk, verified: restoredVerified } =
      await restoreAndVerify(session, preHash);
    restoreState = null;

    const testField: TestPhaseField = {
      command: opts.testCommand,
      exitCode: testResult.exitCode,
      durationMs: testResult.durationMs,
      timedOut: testResult.timedOut,
      stdoutTail: testResult.stdoutTail,
      stderrTail: testResult.stderrTail,
      logPath: testResult.logPath,
    };

    if (!restoreOk || !restoredVerified) {
      return {
        status: "inconclusive",
        reason: "restore_failed",
        warnings: [
          ...warnings,
          `restore failed; the original content is preserved at backup path ${session.backupPath}`,
        ],
        mutant: mutantField,
        mutation_probe: {
          mutant: mutantSummary,
          verified_applied_via: verifiedAppliedVia,
          result: "inconclusive",
          restored_verified: false,
        },
        baseline,
        test: testField,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (7) remove marker, classify. Lock release happens in `finally`.
    removeMarkerFor(absFile);

    let status: "killed" | "survived" | "inconclusive";
    let reason: string | undefined;
    if (testResult.timedOut) {
      status = "inconclusive";
      reason = "timeout";
    } else {
      const testPassed = testResult.exitCode === 0;
      const killed = opts.expect === "fail" ? !testPassed : testPassed;
      status = killed ? "killed" : "survived";
    }

    return {
      status,
      reason,
      warnings,
      mutant: mutantField,
      mutation_probe: {
        mutant: mutantSummary,
        verified_applied_via: verifiedAppliedVia,
        result: status,
        restored_verified: restoredVerified,
      },
      baseline,
      test: testField,
      isolation: isolationField,
      dryRunLogPaths: computed.logPaths,
    };
  } finally {
    let emergencyResult: ProbeResult | undefined;
    if (restoreState) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above: the backstop for "restore
      // in the finally" (fix 1). A restore failure here still has to
      // surface as `inconclusive`/`restore_failed`, never silently as
      // whatever exception triggered this path.
      const state = restoreState;
      restoreState = null;
      let restored = false;
      try {
        restored = state.restore();
      } catch {
        restored = false;
      }
      let verified = false;
      if (restored) {
        const hash = await sha256File(state.targetPath).catch(() => undefined);
        verified = hash === state.preHash;
      }
      if (verified) {
        removeMarkerFor(state.markerKey);
      } else {
        emergencyResult = {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed after an unexpected error; the original content is preserved at backup path ${state.backupPath}`,
          ],
          ...(mutantField ? { mutant: mutantField } : {}),
          ...(mutantSummary && verifiedAppliedVia
            ? {
                mutation_probe: {
                  mutant: mutantSummary,
                  verified_applied_via: verifiedAppliedVia,
                  result: "inconclusive",
                  restored_verified: false,
                },
              }
            : {}),
          ...(baseline ? { baseline } : {}),
          isolation: isolationField,
        };
      }
    }
    removeCrashHandlers();
    lockResult.release();
    if (emergencyResult) return emergencyResult;
  }
}
