import fs from "node:fs";
import path from "node:path";
import { execCommand, type ExecResult } from "../exec.js";
import { sha256File } from "../hash.js";
import {
  acquireLock,
  markerFilePathFor,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../lock.js";
import {
  findGitRoot,
  isPathContained,
  resolveDeepestExisting,
} from "./containment.js";
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
  /**
   * Whether the SIGINT/SIGTERM handler ends the host process once it has
   * restored the target and released the lock. `true` is right for the
   * CLI, where this call owns the process and the signal means "stop
   * now"; the default `false` is right for a library caller, whose
   * process must not be terminated by a function it called. With `false`
   * the handler still does the emergency restore and lock release, and
   * the pipeline then unwinds normally through its own restore points
   * (restoring an already-restored target from the same backup is a
   * no-op that still verifies).
   */
  exitOnSignal?: boolean;
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
  /** True when this phase's own run hit `--timeout`, so a killed
   * baseline (never a red/failing one) is distinguishable from a
   * genuinely failing baseline; both still classify as `baseline_failed`
   * (a non-zero exit either way), but this field tells the two apart. */
  timedOut: boolean;
}

export interface TestPhaseField extends ExecPhaseField {
  command: string;
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
 * either signal, first kills whatever `--pre`/`-t` child is currently
 * running (via `abortInFlight`, so the emergency restore below never
 * races a test process still writing to the target or its own log),
 * then, if a mutation is currently in flight (per `getRestoreState`),
 * restores the target via the session's own `restore()` and removes the
 * marker (only when that restore itself succeeded, so a failed
 * emergency restore still leaves the marker for the next invocation to
 * recover), releases the lock, then exits when `exitOnSignal` says to.
 * Returns a function that removes exactly these two handlers, so
 * concurrent `probe()` calls in the same process never interfere with
 * each other's signal handling.
 */
function installCrashHandlers(
  getRestoreState: () => RestoreState | null,
  releaseLock: () => void,
  abortInFlight: () => void,
  exitOnSignal: boolean,
): () => void {
  const handler = (signal: NodeJS.Signals) => {
    try {
      abortInFlight();
    } catch {
      // Best-effort: a failure to abort the in-flight child must never
      // block the restore/lock-release that follows.
    }
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
    if (exitOnSignal) process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

/** Records, as a warning, that a phase's captured output may be missing
 * whatever was still in flight when the run settled: the command had
 * exited but something it spawned still held its stdout/stderr open, so
 * `exec.ts` settled on its flush grace rather than waiting on the pipes.
 * The exit code (and therefore the verdict) is unaffected; only the
 * tails and the log file are. */
function noteIncompleteOutput(
  warnings: string[],
  phase: string,
  result: ExecResult,
): void {
  if (!result.outputMayBeIncomplete) return;
  warnings.push(
    `${phase}: the command exited while something it spawned still held its output pipes open; the captured output may be incomplete (see ${result.logPath})`,
  );
}

type RunPhaseResult =
  { ok: true; test: ExecResult } | { ok: false; pre: ExecResult };

/** Runs `--pre` (if given) then the test command, both against `env`.
 * A non-zero `--pre` exit short-circuits before the test ever runs, so
 * the caller can classify it as `pre_failed` instead of quietly letting
 * a stale build (or any other `--pre` failure) produce a false verdict. */
async function runPreThenTest(
  opts: Pick<ProbeOptions, "preCommand" | "testCommand">,
  env: {
    cwd: string;
    logDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
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
  // The git work-tree root when there is one, else `cwd`: the same value
  // `containmentRoot` computes, kept in two variables because the lock
  // below has to tell "in a repository" from "not in one".
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ?? path.resolve(cwd);
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
  const realRoot = resolveDeepestExisting(root);
  const absFile = resolveDeepestExisting(displayFile);
  const absLinks = displayLinks.map(resolveDeepestExisting);

  // The lock is keyed on the repository, not on the target file: an
  // `inplace` probe mutates the one working tree that every probe in the
  // same repository builds and tests in, so a second probe on a
  // different file would run its baseline against a tree carrying the
  // first probe's mutation. It is refused rather than queued, the same
  // contract a second probe on the same file has always had. Outside a
  // repository there is no shared tree, and the target file itself is
  // the identity. The marker stays keyed on the target file: it records
  // that one file's backup and hashes.
  const lockIdentity = gitRoot !== undefined ? realRoot : absFile;
  const lockResult = acquireLock(lockIdentity);
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
  // Scopes exactly one in-flight `--pre`/`-t` child: the SIGINT/SIGTERM
  // handler aborts it before restoring, so an emergency restore never
  // races a test process still running against (and possibly still
  // writing) the target file.
  const execController = new AbortController();
  const removeCrashHandlers = installCrashHandlers(
    () => restoreState,
    lockResult.release,
    () => execController.abort(),
    opts.exitOnSignal ?? false,
  );
  // Set by the `catch` below and read by `finally`'s emergency-restore
  // path, so its warning can name what actually triggered the restore
  // instead of just "an unexpected error".
  let caughtError: unknown;

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
      // The one thing every recovery path below except "already back at
      // preHash" needs is the backup itself; when it is gone (its
      // per-run log dir can easily not have survived, e.g. cleaned up
      // or never created on this machine at all), automatic recovery is
      // not possible and must say so by name, not surface as a generic
      // restore failure.
      if (!fs.existsSync(marker.backupPath) && currentHash !== marker.preHash) {
        return {
          status: "inconclusive",
          reason: "stale_probe_marker",
          warnings: [
            ...warnings,
            `stale probe marker found for ${displayFile}, but its backup is missing (${marker.backupPath}); automatic recovery is not possible; delete the marker file to clear it: ${markerFilePathFor(absFile)}`,
          ],
          isolation: isolationField,
        };
      }
      if (currentHash !== undefined && currentHash === marker.mutatedHash) {
        // The backup is hashed and required to match the marker's own
        // recorded pre-mutation hash BEFORE it is copied anywhere. The
        // copy is destructive and irreversible: a backup that is corrupt,
        // truncated, or simply not this target's content would otherwise
        // be written over the target, destroying the only remaining copy
        // of the mutated file and reporting `stale_probe_marker` as if
        // the target had been left alone.
        const backupHash = await sha256File(marker.backupPath).catch(
          () => undefined,
        );
        if (backupHash !== marker.preHash) {
          return {
            status: "inconclusive",
            reason: "stale_probe_marker",
            warnings: [
              ...warnings,
              `stale probe marker found for ${displayFile}, but its backup does not match the pre-mutation hash the marker records (${marker.backupPath}); the target was left untouched; inspect the backup, then delete the marker file to clear it: ${markerFilePathFor(absFile)}`,
            ],
            isolation: isolationField,
          };
        }
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

    if (!fs.existsSync(displayFile)) {
      return {
        status: "usage_error",
        reason: "file_not_found",
        warnings: [...warnings, `--file not found: ${displayFile}`],
        isolation: isolationField,
      };
    }

    const preHash = await sha256File(displayFile);
    const originalContent = fs.readFileSync(displayFile, "utf8");

    // Backed up immediately, before the baseline (or anything else) ever
    // runs against the target: a baseline command that itself rewrites
    // the target (a formatter, a codegen step, ...) must never end up
    // being the thing this backup captures, and the check just below
    // (re-hashing after the baseline) needs a backup that already exists
    // and is verified in order to have anything trustworthy to restore
    // from once a mutation is actually applied. `restoreState` is set
    // right away too, so a signal landing anywhere from here on has a
    // (possibly no-op) restore to run instead of nothing.
    const session = beginInplace(displayFile, opts.logDir);
    restoreState = {
      restore: session.restore,
      targetPath: session.targetPath,
      markerKey: absFile,
      backupPath: session.backupPath,
      preHash,
    };
    const discardBackup = () => {
      restoreState = null;
      try {
        fs.rmSync(session.backupPath, { force: true });
      } catch {
        // Best-effort: an orphaned backup file is clutter, never a
        // correctness problem (nothing references it once no marker
        // points at it).
      }
    };
    const backupHash = await sha256File(session.backupPath).catch(
      () => undefined,
    );
    if (backupHash !== preHash) {
      discardBackup();
      return {
        status: "inconclusive",
        reason: "backup_verification_failed",
        warnings: [
          ...warnings,
          `the backup taken at ${session.backupPath} did not match the target's pre-mutation hash; the target itself was left untouched`,
        ],
        isolation: isolationField,
      };
    }

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
      discardBackup();
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
      signal: execController.signal,
    };

    // (2) baseline: unmutated, must exit 0.
    const baselineStart = Date.now();
    const baselineRun = await runPreThenTest(opts, execEnv);
    if (!baselineRun.ok) {
      noteIncompleteOutput(warnings, "baseline --pre", baselineRun.pre);
      discardBackup();
      // An aborted `--pre` (this probe was signalled, or its caller
      // aborted it) never ran to a conclusion, so it is not a `--pre`
      // that failed: it is a run that was stopped.
      const preAborted = baselineRun.pre.aborted;
      return {
        status: "inconclusive",
        reason: preAborted ? "aborted" : "pre_failed",
        warnings: [
          ...warnings,
          preAborted
            ? `--pre was aborted during the baseline run; see ${baselineRun.pre.logPath}`
            : `--pre exited ${baselineRun.pre.exitCode} during the baseline run; see ${baselineRun.pre.logPath}`,
        ],
        mutant: mutantField,
        isolation: isolationField,
        dryRunLogPaths: [...computed.logPaths, baselineRun.pre.logPath],
      };
    }
    const baselineTest = baselineRun.test;
    noteIncompleteOutput(warnings, "baseline", baselineTest);
    baseline = {
      exitCode: baselineTest.exitCode,
      durationMs: Date.now() - baselineStart,
      logPath: baselineTest.logPath,
      timedOut: baselineTest.timedOut,
    };
    if (baselineTest.exitCode !== 0 || baselineTest.aborted) {
      // A failing baseline is still a baseline that ran commands against
      // the working tree, and one of them may have rewritten the target
      // (a formatter, a codegen step). Re-hash before deciding what to do
      // with the backup: discarding it silently would throw away the only
      // copy of the target's pre-baseline content.
      const postHash = await sha256File(displayFile).catch(() => undefined);
      if (postHash === preHash) {
        discardBackup();
      } else {
        // Keep the backup file itself, and stop treating a mutation as in
        // flight: nothing was mutated, so there is nothing to restore, and
        // the target is deliberately left as the baseline wrote it.
        restoreState = null;
        warnings.push(
          `the failing baseline run also rewrote the target; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at ${session.backupPath}`,
        );
      }
      // An aborted baseline is not a red baseline: nothing about the
      // test was learned, the run was stopped. Reported apart from a
      // baseline that genuinely failed, so a caller cannot read a
      // cancelled probe as a broken test suite.
      if (baselineTest.aborted) {
        warnings.push(
          `the baseline run was aborted; see ${baselineTest.logPath}`,
        );
      }
      return {
        status: "inconclusive",
        reason: baselineTest.aborted ? "aborted" : "baseline_failed",
        warnings,
        baseline,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // The baseline run (the `--pre`/`-t` commands themselves, not this
    // probe) is the only thing that has touched the filesystem since the
    // backup was taken and verified above: re-hash the target and, if it
    // no longer matches `preHash`, a formatter/codegen/build step run as
    // part of the baseline rewrote it. Aborting here (before any
    // mutation or marker exists) leaves that rewrite exactly as the
    // baseline left it -- restoring from the backup would instead throw
    // away a legitimate write this probe never made.
    const postBaselineHash = await sha256File(displayFile).catch(
      () => undefined,
    );
    if (postBaselineHash !== preHash) {
      discardBackup();
      return {
        status: "inconclusive",
        reason: "target_changed_during_baseline",
        warnings: [
          ...warnings,
          `the target changed during the baseline run (before any mutation was applied); the target is left as the baseline run wrote it, not restored`,
        ],
        mutant: mutantField,
        baseline,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (3) marker, apply, verify the hash changed.
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
      // The restore above succeeded and verified, so this is a structured
      // "cannot conclude" for the caller, not an exception: throwing here
      // would surface through the CLI as `status: "error"` under an
      // unknown command, losing both the reason and the `mutation_probe`
      // evidence that the target really is back at its pre-mutation
      // content.
      return {
        status: "inconclusive",
        reason: "apply_hash_mismatch",
        warnings: [
          ...warnings,
          `the applied mutant's hash does not match what the dry run predicted for ${displayFile} (expected ${computed.mutatedHash}, got ${afterApplyHash}); the target was restored and the restore verified`,
        ],
        mutant: mutantField,
        mutation_probe: {
          mutant: mutantSummary,
          verified_applied_via: verifiedAppliedVia,
          result: "inconclusive",
          restored_verified: verified,
        },
        baseline,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (4) --pre then -t, mutated.
    const mutantRun = await runPreThenTest(opts, execEnv);
    if (!mutantRun.ok) {
      noteIncompleteOutput(warnings, "mutant --pre", mutantRun.pre);
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
      const preAborted = mutantRun.pre.aborted;
      return {
        status: "inconclusive",
        reason: preAborted ? "aborted" : "pre_failed",
        warnings: [
          ...warnings,
          preAborted
            ? `--pre was aborted during the mutant run; see ${mutantRun.pre.logPath}`
            : `--pre exited ${mutantRun.pre.exitCode} during the mutant run; see ${mutantRun.pre.logPath}`,
        ],
        mutant: mutantField,
        mutation_probe: {
          mutant: mutantSummary,
          verified_applied_via: verifiedAppliedVia,
          result: "inconclusive",
          restored_verified: verified,
        },
        baseline,
        isolation: isolationField,
        dryRunLogPaths: [...computed.logPaths, mutantRun.pre.logPath],
      };
    }
    const testResult = mutantRun.test;
    noteIncompleteOutput(warnings, "mutant", testResult);

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
    if (testResult.aborted) {
      // The run was stopped (a SIGINT/SIGTERM this probe handled, or a
      // caller's abort) before the test could say anything about the
      // mutant. Never `killed`: an aborted test child exits non-zero,
      // which under `--expect fail` is indistinguishable from a mutant
      // the suite really caught, and reporting that would be a verdict
      // nothing measured.
      status = "inconclusive";
      reason = "aborted";
      warnings.push(`the mutant run was aborted; see ${testResult.logPath}`);
    } else if (testResult.timedOut) {
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
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    let emergencyResult: ProbeResult | undefined;
    if (restoreState) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above. The rule this backstop
      // enforces: no path out of this function may leave the target
      // mutated, whether it returns or throws. A restore failure here
      // still has to surface as `inconclusive`/`restore_failed`, never
      // silently as whatever exception triggered this path.
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
        const causeMessage =
          caughtError instanceof Error
            ? caughtError.message
            : caughtError !== undefined
              ? String(caughtError)
              : undefined;
        emergencyResult = {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed after an unexpected error${
              causeMessage ? ` (${causeMessage})` : ""
            }; the original content is preserved at backup path ${state.backupPath}`,
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
