import fs from "node:fs";
import path from "node:path";
import { execCommand, type ExecResult } from "../exec.js";
import { sha256File } from "../hash.js";
import {
  acquireLock,
  isPidAlive,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../lock.js";
import { containmentRoot, isPathContained } from "./containment.js";
import { beginInplace } from "./isolation.js";
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

interface RestoreState {
  /** The same `InplaceSession.restore` used by the normal (non-signal)
   * control flow: the signal path must reuse it rather than duplicate
   * the copy logic, so a bug in the restore implementation breaks both
   * paths identically (and is caught by mutating just the one place). */
  restore: () => boolean;
  targetPath: string;
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
      if (restored) removeMarkerFor(state.targetPath);
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

  const cwd = path.resolve(opts.cwd);
  const absFile = path.resolve(cwd, opts.file);
  const root = containmentRoot(cwd);
  const links = opts.links ?? [];
  const absLinks = links.map((l) => path.resolve(cwd, l));

  const lockResult = acquireLock(absFile);
  if (!lockResult.ok) {
    return {
      status: "inconclusive",
      reason: "probe_in_progress",
      warnings,
      isolation: isolationField,
    };
  }

  let restoreState: RestoreState | null = null;
  const removeCrashHandlers = installCrashHandlers(
    () => restoreState,
    lockResult.release,
  );

  try {
    if (!opts.allowOutside) {
      const outside = [absFile, ...absLinks].filter(
        (p) => !isPathContained(root, p),
      );
      if (outside.length > 0) {
        return {
          status: "inconclusive",
          reason: "file_outside_root",
          warnings: [
            ...warnings,
            `outside the containment root (${root}): ${outside.join(", ")}`,
          ],
          isolation: isolationField,
        };
      }
    }

    const marker = readMarkerFor(absFile);
    if (marker && !isPidAlive(marker.pid)) {
      const currentHash = fs.existsSync(absFile)
        ? await sha256File(absFile).catch(() => undefined)
        : undefined;
      if (currentHash !== undefined && currentHash === marker.mutatedHash) {
        let restored = false;
        try {
          fs.copyFileSync(marker.backupPath, absFile);
          restored = true;
        } catch {
          restored = false;
        }
        const restoredHash = restored
          ? await sha256File(absFile).catch(() => undefined)
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
      } else {
        return {
          status: "inconclusive",
          reason: "stale_probe_marker",
          warnings: [
            ...warnings,
            `stale in-flight probe marker found for ${absFile}; backup at ${marker.backupPath}`,
          ],
          isolation: isolationField,
        };
      }
    }

    const preHash = await sha256File(absFile);
    const originalContent = fs.readFileSync(absFile, "utf8");

    const mutantSpec: MutantSpec = {
      form: opts.form,
      file: absFile,
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
        warnings,
        isolation: isolationField,
      };
    }

    const execEnv = {
      cwd: root,
      logDir: opts.logDir,
      timeoutMs: opts.timeoutMs,
    };

    async function runPreThenTest(): Promise<ExecResult> {
      if (opts.preCommand) {
        const preResult = await execCommand(opts.preCommand, execEnv);
        if (preResult.exitCode !== 0) {
          warnings.push(
            `--pre exited ${preResult.exitCode}; see ${preResult.logPath}`,
          );
        }
      }
      return execCommand(opts.testCommand, execEnv);
    }

    // (2) baseline: unmutated, must exit 0.
    const baselineStart = Date.now();
    const baselineTest = await runPreThenTest();
    const baseline: ExecPhaseField = {
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
      };
    }

    // (3) marker, apply, verify the hash changed.
    const session = beginInplace(absFile, opts.logDir);
    writeMarker(absFile, {
      targetPath: absFile,
      backupPath: session.backupPath,
      preHash,
      mutatedHash: computed.mutatedHash,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
    restoreState = { restore: session.restore, targetPath: absFile };

    if (opts.form === "patch") {
      const applyResult = await applyPatchForReal(
        opts.patchPath ?? "",
        root,
        opts.logDir,
      );
      if (applyResult.exitCode !== 0) {
        session.restore();
        restoreState = null;
        removeMarkerFor(absFile);
        return {
          status: "inconclusive",
          reason: "mutant_not_applicable",
          warnings: [
            ...warnings,
            `git apply failed against the real target after the dry run succeeded; see ${applyResult.logPath}`,
          ],
          baseline,
          isolation: isolationField,
        };
      }
    } else {
      fs.writeFileSync(absFile, computed.newContent);
    }

    const afterApplyHash = await sha256File(absFile);
    const mutantField: MutantField = {
      file: absFile,
      line: opts.line,
      before: computed.before,
      after: computed.after,
      form: opts.form,
    };
    const mutantSummary = formatMutantSummary(
      absFile,
      opts.line,
      computed.before,
      computed.after,
    );
    const verifiedAppliedVia = formatVerifiedAppliedVia(
      absFile,
      opts.line,
      computed.before,
      computed.after,
    );

    if (afterApplyHash === preHash || afterApplyHash !== computed.mutatedHash) {
      session.restore();
      restoreState = null;
      removeMarkerFor(absFile);
      throw new Error(
        `probe: mutation hash mismatch after apply for ${absFile} (expected ${computed.mutatedHash}, got ${afterApplyHash})`,
      );
    }

    // (4) --pre then -t, mutated.
    const testResult = await runPreThenTest();

    // (5) restore, (6) verify restore by hash.
    const restoreOk = session.restore();
    restoreState = null;
    let restoredVerified = false;
    if (restoreOk) {
      const restoredHash = await sha256File(absFile).catch(() => undefined);
      restoredVerified = restoredHash === preHash;
    }

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
          result: "restore_failed",
          restored_verified: false,
        },
        baseline,
        test: testField,
        isolation: isolationField,
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
    };
  } finally {
    removeCrashHandlers();
    lockResult.release();
  }
}
