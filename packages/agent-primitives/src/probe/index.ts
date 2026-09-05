import fs from "node:fs";
import path from "node:path";
import { sha256File } from "../hash.js";
import { removeMarkerFor } from "../lock.js";
import { findGitRoot, resolveDeepestExisting } from "./containment.js";
import {
  DEFAULT_GIT_APPLY_TIMEOUT_MS,
  listPatchTouchedPaths,
  PATCH_MAX_BYTES,
  type MutantForm,
} from "./mutant.js";
import type { PlanMutantSpec } from "./plan.js";
import {
  type ExecPhaseField,
  type ExpectVerdict,
  type IsolationField,
  type IsolationMode,
  type MutantField,
  type MutationProbeField,
  type ProbeStatus,
  type TargetSession,
  type TestPhaseField,
} from "./session.js";
import {
  prepareMutant,
  runMutantAttempt,
  type MutantStepSpec,
  type PreparedMutant,
} from "./step.js";
import { openRunSetup, type RunSetupContext } from "./setup.js";

/**
 * The public surface of the probe pipeline: the CLI-facing option/result
 * types (`ProbeOptions`, `ProbeResult`, `ProbePlanOptions`,
 * `ProbePlanResult` and the plan-result types below), the shared
 * field-shape types re-exported from `session.ts` (see that module's
 * own docblock for why they live there instead of here), and the two
 * entry points, `probe()` and `probePlan()`.
 *
 * The pipeline itself is split into three modules this file sits above:
 *
 * - `session.ts`: the run-controller layer (signal/abort handling, the
 *   in-flight-run tracking the handler waits on, the `-i worktree`
 *   session, and `openTarget`'s per-file backup/restore), plus the
 *   field-shape types every layer needs to name.
 * - `step.ts`: the per-mutant step (`prepareMutant`, `runMutantAttempt`),
 *   built on `session.ts`.
 * - `setup.ts`: the shared run setup (`openRunSetup`: isolation
 *   fallback, refusals, containment, the lock, stale-marker recovery,
 *   the worktree sync, every target's backup, the one baseline), also
 *   built on `session.ts`.
 *
 * Import direction is one way, `session.ts <- step.ts <- setup.ts <-
 * index.ts`: this file imports all three; `setup.ts` may import
 * `step.ts` and `session.ts`; `step.ts` may import only `session.ts`;
 * `session.ts` imports none of the other three -- so the graph cannot
 * cycle. In this codebase `setup.ts` ends up needing only `session.ts`:
 * the mutant step `openRunSetup` runs before its own baseline is
 * supplied by its caller (this file's own `beforeBaseline` hook for the
 * single probe; a plan's mutants are applied by this file's own loop
 * after `openRunSetup` returns), so `setup.ts` never actually calls
 * `step.ts`'s `prepareMutant`/`runMutantAttempt` itself -- the smallest
 * cut that still keeps a DAG, per this split's own constraint.
 */

export type {
  ExecPhaseField,
  ExpectVerdict,
  IsolationField,
  IsolationMode,
  MutantField,
  MutationProbeField,
  ProbeStatus,
  TestPhaseField,
};

export interface ProbeOptions {
  /** As given on the CLI; resolved against `cwd`. Optional only for
   * `form: "patch"`: when omitted, derived from the single path the
   * patch touches (`git apply --numstat`), resolved against the
   * containment root. Every other form still requires it. */
  file?: string;
  /** 1-indexed line number of the line to mutate. Required for every
   * form except `patch`, whose line is decided by the patch itself: the
   * reported `mutant.line` is always the first line the applied diff
   * changes, and a `line` passed alongside `form: "patch"` is neither
   * used nor echoed -- when it names a different line, that disagreement
   * is reported as a warning. */
  line?: number;
  form: MutantForm;
  replaceText?: string;
  matchText?: string;
  withText?: string;
  patchPath?: string;
  testCommand: string;
  preCommand?: string;
  isolation: IsolationMode;
  expect: ExpectVerdict;
  /** Timeout in milliseconds, applied to every `--pre`/`-t` invocation
   * and to every `git apply` the `patch` form runs. Omitted, the
   * commands run unbounded and `git apply` keeps
   * `DEFAULT_GIT_APPLY_TIMEOUT_MS`. */
  timeoutMs?: number;
  links?: string[];
  allowOutside?: boolean;
  cwd: string;
  logDir: string;
  /**
   * Whether the SIGINT/SIGTERM handler ends the host process once it has
   * killed the in-flight child, waited for that run to settle, restored
   * the target and released the lock. `true` is right for the
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
    syncedTrackedFiles: 0,
    syncedUntrackedFiles: 0,
  };
}

/**
 * The metadata-only usability check every `-p/--patch` path shares,
 * returning the message for a patch that cannot be used at all and
 * `undefined` for one that can.
 *
 * Nothing here opens the file or reads its bytes (`git apply` streams it
 * in a child of its own). That is deliberate. `fs.statSync` cannot block
 * -- querying a FIFO's metadata does not open it -- while an unbounded
 * read of a writer-less FIFO blocks forever (measured: it outlives
 * `SIGTERM` and needs `SIGKILL`), so a FIFO or socket is refused by
 * `isFile()` before anything can wait on it, and an oversized file is
 * refused by its recorded size without being loaded. `statSync` and
 * `accessSync` both follow symlinks (unlike `lstatSync`), so a symlink
 * to a regular readable file is accepted and a symlink to a FIFO or a
 * directory is still rejected by what it resolves to.
 * `accessSync(R_OK)` is what catches a patch whose permissions deny
 * reading, which a `stat` alone cannot see.
 *
 * This checks by PATH (`statSync`/`accessSync`), never by an open
 * descriptor, unlike `parsePlanFile`'s own metadata check (an `fstatSync`
 * on the descriptor it then reads from): the two techniques differ
 * because what runs after them differs. `parsePlanFile` reads the plan
 * itself in this process, so its bound has to hold across the same
 * descriptor the read uses, closing the stat-then-read race a path-based
 * check would leave open. A patch's own bytes are never read here or
 * anywhere else in this process -- `git apply` (a child process) is what
 * streams the file from its path, both for the dry run and the real
 * apply -- so there is no read in this process for an open descriptor to
 * protect; git's own handling of the path it is given governs from
 * there.
 *
 * `label` names the option in the message: `-p/--patch` for the single
 * probe, the plan's own path (`plan.mutants[2].patch`) for a plan.
 */
export function patchUnusableReason(
  patchPath: string,
  label = "-p/--patch",
): string | undefined {
  const absPatchPath = path.resolve(patchPath);
  let patchStat: fs.Stats;
  try {
    patchStat = fs.statSync(absPatchPath);
  } catch {
    return `${label} could not be read: ${absPatchPath}`;
  }
  if (!patchStat.isFile()) {
    return `${label} is not a regular file: ${absPatchPath}`;
  }
  if (patchStat.size > PATCH_MAX_BYTES) {
    return (
      `${label} is ${String(patchStat.size)} bytes, over the ` +
      `${String(PATCH_MAX_BYTES)}-byte cap: ${absPatchPath}`
    );
  }
  try {
    fs.accessSync(absPatchPath, fs.constants.R_OK);
  } catch {
    return `${label} could not be read: ${absPatchPath}`;
  }
  return undefined;
}

/**
 * Runs the full probe pipeline: lock -> containment -> stale-marker
 * recovery -> baseline -> mutate -> pre+test -> restore -> verify ->
 * classify. Setup through baseline is `setup.ts`'s `openRunSetup`, which
 * `probePlan` runs too; the mutate -> test -> restore -> classify step
 * is `step.ts`'s `prepareMutant`/`runMutantAttempt`, which `probePlan`
 * runs once per mutant. See `probePlan`'s docblock for the invariants
 * that split holds to.
 */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const warnings: string[] = [];
  const isolationField = emptyIsolationField(opts.isolation);

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
  // The git work-tree root when there is one, else `cwd`: the same value
  // `containmentRoot` computes, kept in two variables because the lock
  // `setup.ts`'s `openRunSetup` takes has to tell "in a repository" from
  // "not in one".
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ?? path.resolve(cwd);
  // `--timeout` is the caller saying how long any step of this probe may
  // run, so every `git apply` gets that same bound; without one they
  // keep the fixed default, since an apply that hangs would otherwise
  // sit under an in-flight marker forever. Computed here, ahead of where
  // it used to sit (right before the containment/lock block `setup.ts`'s
  // `openRunSetup` runs), because the `-p` derivation immediately below
  // runs its own `git apply --numstat` and needs the same bound. That
  // derivation (both the `--file` numstat listing and the `-n`
  // hunk-header read) runs before `setup.ts`'s `openRunSetup` (via
  // `session.ts`'s `createRunController`) creates its `execController`,
  // so unlike every later `git apply`/test invocation in this function
  // it is not wired to the signal handler's abort; `--timeout`
  // (`gitApplyTimeoutMs`) is the only bound on how long it may run.
  const gitApplyTimeoutMs = opts.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS;

  // `-p/--patch` derives `--file` from the single path `git apply
  // --numstat` reports the patch touches, resolved against the
  // containment root -- `root`, never `cwd`, since they differ when
  // `--cwd` is a subdirectory of the repository, and never the patch
  // file's own directory, since a patch is portable and carries no base
  // directory of its own. It has to run before the containment check
  // `setup.ts`'s `openRunSetup` makes, which needs `displayFile`. Two or
  // more touched paths without
  // an explicit `--file` is ambiguous and refused outright, rather than
  // guessed at: the caller has to say which one is the mutation target.
  //
  // `-n/--line` is NOT derived here, and for the `patch` form it is not
  // required at all: the line a patch changes is whatever the applied
  // diff changed, which the dry run below reports back as
  // `computed.line`. Nothing between here and there needs it.
  let displayFile: string;
  const line = opts.line;
  let derivationLogPaths: string[] = [];
  // Check the `-p/--patch` path once here, before anything else looks
  // at it: an unusable `-p` (missing, a directory or another
  // non-regular file, unreadable permissions, or larger than this
  // package accepts) is a caller usage error, not something for `git
  // apply --numstat` to diagnose. Without this check, a bad `-p` given
  // without `--file` fell into the `--file` derivation's own `git apply
  // --numstat` failure below and came back as
  // `inconclusive`/`mutant_not_applicable` ("failed to parse the
  // patch") -- a diagnosis that points at the patch's *content*, not at
  // the path itself being wrong. Doing it once, ahead of the numstat
  // listing (and ahead of the lock, the in-flight marker and any
  // worktree, so a refusal here leaves nothing behind), means every
  // path that hands this patch to `git apply` -- `--file` derivation,
  // the dry run, the real apply -- shares the same `patch_not_readable`
  // diagnosis instead of several different ones.
  //
  // Every check there is metadata-only; see `patchUnusableReason` for
  // why nothing here opens the patch or reads its bytes.
  if (opts.form === "patch") {
    const unusable = patchUnusableReason(opts.patchPath ?? "");
    if (unusable !== undefined) {
      return {
        status: "usage_error",
        reason: "patch_not_readable",
        warnings: [...warnings, unusable],
        isolation: isolationField,
      };
    }
  }
  if (opts.file !== undefined) {
    displayFile = path.resolve(cwd, opts.file);
  } else if (opts.form === "patch") {
    const listing = await listPatchTouchedPaths(
      opts.patchPath ?? "",
      opts.logDir,
      { timeoutMs: gitApplyTimeoutMs },
    );
    derivationLogPaths = [listing.logPath];
    if (!listing.ok) {
      return {
        status: "inconclusive",
        reason: listing.reasonCode ?? "mutant_not_applicable",
        warnings: [...warnings, listing.reason],
        isolation: isolationField,
        dryRunLogPaths: derivationLogPaths,
      };
    }
    if (listing.paths.length !== 1) {
      return {
        status: "usage_error",
        reason: "patch_file_ambiguous",
        warnings: [
          ...warnings,
          `-p/--patch touches ${listing.paths.length} paths and no --file ` +
            `names which one to mutate: ${listing.paths.join(", ")}`,
        ],
        isolation: isolationField,
        dryRunLogPaths: derivationLogPaths,
      };
    }
    displayFile = path.resolve(root, listing.paths[0]);
  } else {
    return {
      status: "usage_error",
      reason: "file_required",
      warnings: [
        ...warnings,
        "--file is required unless -p/--patch derives it from a single-path patch",
      ],
      isolation: isolationField,
    };
  }
  // `patch` is exempt: its line comes from the applied diff, so there is
  // nothing for the caller to be required to supply.
  if (line === undefined && opts.form !== "patch") {
    return {
      status: "usage_error",
      reason: "line_required",
      warnings: [...warnings, "-n/--line is required"],
      isolation: isolationField,
      dryRunLogPaths: derivationLogPaths,
    };
  }
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
  // The `--log-dir` this run's worktree (if any) is created under,
  // recorded in the repository-keyed marker and handed to every
  // `cleanupWorktree` call for this session, the leftover recovery
  // included: a path that git does not (yet, or any more) report as a
  // registered worktree is only ever deleted when it sits under here.
  // Never the log dir a marker recorded: a marker that supplied both
  // the path and the root to check it against would certify itself.
  const wtScratchRoot = path.resolve(opts.logDir);

  // Populated by the shared setup's `beforeBaseline` hook below as soon
  // as each becomes known, so the `finally` block's emergency-restore
  // path can build a full result even when it is reached via a thrown
  // error partway through.
  let mutantField: MutantField | undefined;
  let mutantSummary: string | undefined;
  let verifiedAppliedVia: string | undefined;
  let prepared: Extract<PreparedMutant, { ok: true }> | undefined;
  let baseline: ExecPhaseField | undefined;
  // The locks and the run controller, handed over by `openRunSetup` the
  // moment they exist: from then on this function's own `finally` owns
  // the teardown, however the setup ends.
  let context: RunSetupContext | undefined;
  // Set by the `catch` below and read by `finally`'s emergency-restore
  // path, so its warning can name what actually triggered the restore
  // instead of just "an unexpected error".
  let caughtError: unknown;
  const spec: MutantStepSpec = {
    form: opts.form,
    line,
    replaceText: opts.replaceText,
    matchText: opts.matchText,
    withText: opts.withText,
    patchPath: opts.patchPath,
    expect: opts.expect,
  };

  try {
    const setup = await openRunSetup({
      cwd,
      root,
      gitRoot,
      realRoot,
      logDir: opts.logDir,
      wtScratchRoot,
      isolation: opts.isolation,
      allowOutside: opts.allowOutside ?? false,
      displayLinks,
      absLinks,
      timeoutMs: opts.timeoutMs,
      gitApplyTimeoutMs,
      testCommand: opts.testCommand,
      preCommand: opts.preCommand,
      exitOnSignal: opts.exitOnSignal ?? false,
      warnings,
      isolationField,
      targets: [
        { displayFile, absFile, label: "--file", subject: "the target" },
      ],
      priorLogPaths: derivationLogPaths,
      // What a single probe has always reported for a target outside the
      // containment root; a plan calls the same finding a usage error.
      outsideRootStatus: "inconclusive",
      onContext: (runContext) => {
        context = runContext;
      },
      // The dry run, before the baseline: the single probe computes its
      // one mutant against the target's original content here, so a
      // mutant that cannot be applied is reported without a baseline
      // ever running, and a `--pre` failure or a target the baseline
      // rewrote still reports the mutant this probe would have applied.
      // A plan computes each of its mutants inside its own loop instead.
      beforeBaseline: async ({ targets, rt }) => {
        const computed = await prepareMutant(rt, targets[0], spec, warnings);
        if (!computed.ok) {
          return {
            ok: false,
            reason: computed.reason,
            logPaths: computed.logPaths,
          };
        }
        prepared = computed;
        mutantField = computed.mutant;
        mutantSummary = computed.mutantSummary;
        verifiedAppliedVia = computed.verifiedAppliedVia;
        return { ok: true, logPaths: computed.logPaths };
      },
    });
    if (!setup.ok) {
      const { refusal } = setup;
      return {
        status: refusal.status,
        reason: refusal.reason,
        warnings: refusal.warnings,
        ...(refusal.reportsMutant && mutantField !== undefined
          ? { mutant: mutantField }
          : {}),
        ...(refusal.baseline !== undefined
          ? { baseline: refusal.baseline }
          : {}),
        isolation: isolationField,
        ...(refusal.logPaths !== undefined
          ? { dryRunLogPaths: refusal.logPaths }
          : {}),
      };
    }
    const { rt, targets, logPaths: stepLogPaths } = setup.run;
    baseline = setup.run.baseline;
    if (prepared === undefined) {
      // Unreachable: `openRunSetup` returns `ok` only past the
      // `beforeBaseline` hook above, which is where this is set. A
      // typed narrowing, and never a silent one.
      throw new Error(
        "internal error: the mutant was not prepared before the baseline",
      );
    }
    const preparedMutant = prepared;

    // (3) marker, (4) apply, pre+test, (5) restore, (6) verify the
    // restore by hash, (7) classify: one mutant, through the same step a
    // plan runs once per mutant.
    const outcome = await runMutantAttempt(
      rt,
      targets[0],
      spec,
      {
        computed: preparedMutant.computed,
        mutant: preparedMutant.mutant,
        mutantSummary: preparedMutant.mutantSummary,
        verifiedAppliedVia: preparedMutant.verifiedAppliedVia,
        logPaths: stepLogPaths,
      },
      warnings,
    );
    return {
      status: outcome.status,
      reason: outcome.reason,
      warnings,
      ...(outcome.mutant !== undefined ? { mutant: outcome.mutant } : {}),
      ...(outcome.mutation_probe !== undefined
        ? { mutation_probe: outcome.mutation_probe }
        : {}),
      baseline,
      ...(outcome.test !== undefined ? { test: outcome.test } : {}),
      isolation: isolationField,
      dryRunLogPaths: outcome.logPaths,
    };
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    let emergencyResult: ProbeResult | undefined;
    // No context means the setup refused (or threw) before it took a
    // lock: nothing was opened, nothing is in flight, and there is
    // nothing to tear down.
    const inFlightRestore = context?.controller.getRestoreState();
    if (context !== undefined && inFlightRestore) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above. The rule this backstop
      // enforces: no path out of this function may leave the target
      // mutated, whether it returns or throws. A restore failure here
      // still has to surface as `inconclusive`/`restore_failed`, never
      // silently as whatever exception triggered this path.
      const state = inFlightRestore;
      context.controller.setRestoreState(null);
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
    // Runs on every exit path (a normal return, a thrown error, or the
    // emergency-restore path above) and is idempotent: a signal handler
    // that already ran it leaves this a no-op. Cleanup happens before
    // the lock is released, so a concurrent probe on the same repository
    // never observes the lock as free while this run's worktree removal
    // is still in flight.
    if (context !== undefined) {
      await context.controller.cleanupWtSession();
      context.controller.crashHandlers.remove();
      context.releaseLocks();
    }
    if (emergencyResult) return emergencyResult;
  }
}

/** Options for one `--plan` run: the mutants, the command they share,
 * and the run-shaping values already resolved (a plan file's own values
 * and any command-line override are reconciled by the caller, see
 * `cli.ts`). */
export interface ProbePlanOptions {
  /** At least one; applied in this order, never in parallel. */
  mutants: PlanMutantSpec[];
  testCommand: string;
  preCommand?: string;
  isolation: IsolationMode;
  /** The plan-level default; a mutant's own `expect` wins over it. */
  expect: ExpectVerdict;
  timeoutMs?: number;
  links?: string[];
  allowOutside?: boolean;
  cwd: string;
  logDir: string;
  /** See `ProbeOptions.exitOnSignal`: `true` for the CLI, whose process
   * exists to run exactly this plan. */
  exitOnSignal?: boolean;
}

/** A mutant's verdict inside a plan. `not_run` is the honest report for
 * a mutant a terminal failure stopped the plan before reaching: never
 * `inconclusive`, which would claim the mutant was attempted. */
export type PlanMutantStatus =
  "killed" | "survived" | "inconclusive" | "not_run";

export interface PlanMutantResult {
  /** Position in the plan's own `mutants` array, so a result is
   * traceable back to the entry that produced it even when several
   * mutants share a file. */
  index: number;
  file: string;
  expect: ExpectVerdict;
  status: PlanMutantStatus;
  reason?: string;
  /** This mutant's own warnings; the plan's setup and teardown warnings
   * stay on the plan. */
  warnings: string[];
  mutant?: MutantField;
  mutation_probe?: MutationProbeField;
  test?: TestPhaseField;
  /** Exec log paths this mutant produced (its dry run, its real apply). */
  logs: string[];
}

export interface PlanSummaryField {
  total: number;
  killed: number;
  survived: number;
  inconclusive: number;
  not_run: number;
}

export interface ProbePlanResult {
  status: ProbeStatus;
  reason?: string;
  warnings: string[];
  /** The one baseline every mutant of this plan was measured against;
   * absent when the plan never reached it. */
  baseline?: ExecPhaseField;
  results: PlanMutantResult[];
  summary: PlanSummaryField;
  isolation: IsolationField;
  /** Exec log paths the plan's own setup produced (the worktree sync);
   * a mutant's own logs stay on its result. */
  dryRunLogPaths?: string[];
}

function summarize(results: PlanMutantResult[]): PlanSummaryField {
  const count = (status: PlanMutantStatus): number =>
    results.filter((r) => r.status === status).length;
  return {
    total: results.length,
    killed: count("killed"),
    survived: count("survived"),
    inconclusive: count("inconclusive"),
    not_run: count("not_run"),
  };
}

/**
 * Runs a list of mutants that share one test command against ONE
 * baseline, in order, each applied and then restored before the next is
 * applied. The pipeline is the single probe's, not a copy of it: the
 * setup through the baseline is `openRunSetup`, the very function
 * `probe()` calls, and the mutate -> pre+test -> restore -> verify ->
 * classify step is `prepareMutant`/`runMutantAttempt`, likewise shared,
 * run once per mutant between that setup and one shared teardown.
 *
 * The invariants this split holds to:
 *
 * - I1 exactly one baseline per plan, run before any mutant is applied.
 * - I2 the target is restored, and that restore verified by hash, before
 *   the next mutant is applied; the loop re-hashes the target itself
 *   before every apply, so a restore that silently did not happen stops
 *   the plan instead of letting mutant N+1 land on mutant N's content.
 * - I3 a restore that could not be verified is terminal: nothing further
 *   is applied and every remaining mutant is reported `not_run`, with
 *   the marker and the backup left exactly as the single probe leaves
 *   them.
 * - I4 the worktree is synced once per plan and cleaned up once, however
 *   the plan ends.
 * - I5 a signal restores the in-flight mutant and ends the plan: the
 *   handler owns the CURRENT mutant's restore state at every moment
 *   (`runMutantAttempt` re-arms it before each apply and clears it after
 *   each verified restore), and the loop stops rather than starting the
 *   next mutant. On the CLI the handler ends the process itself, with
 *   exit 130/143 and no output.
 * - I6 the single-probe path is unchanged: `probe()` runs the same
 *   setup, the same one step, and the same teardown it always did --
 *   which is now literally the same code, so a refusal a plan makes and
 *   the one a single probe makes for the same reason cannot drift apart
 *   again (they had: a target the baseline rewrote left its backup
 *   behind here and not there).
 */
export async function probePlan(
  opts: ProbePlanOptions,
): Promise<ProbePlanResult> {
  const warnings: string[] = [];
  const isolationField = emptyIsolationField(opts.isolation);
  const cwd = path.resolve(opts.cwd);
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ?? path.resolve(cwd);
  const realRoot = resolveDeepestExisting(root);
  const gitApplyTimeoutMs = opts.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS;
  const links = opts.links ?? [];
  const displayLinks = links.map((l) => path.resolve(cwd, l));
  const absLinks = displayLinks.map(resolveDeepestExisting);
  const wtScratchRoot = path.resolve(opts.logDir);

  /** One entry of the plan, resolved: every path in a plan file (`file`,
   * `patch`) is resolved against the invocation cwd, so one plan means
   * the same thing from wherever it is run with the same `--cwd`. */
  interface PlannedMutant {
    index: number;
    displayFile: string;
    absFile: string;
    spec: MutantStepSpec;
  }
  const planned: PlannedMutant[] = opts.mutants.map((mutant, index) => {
    const displayFile = path.resolve(cwd, mutant.file);
    return {
      index,
      displayFile,
      absFile: resolveDeepestExisting(displayFile),
      spec: {
        form: mutant.form,
        line: mutant.line,
        replaceText: mutant.replaceText,
        matchText: mutant.matchText,
        withText: mutant.withText,
        patchPath:
          mutant.patchPath === undefined
            ? undefined
            : path.resolve(cwd, mutant.patchPath),
        expect: mutant.expect ?? opts.expect,
      },
    };
  });
  // The plan's own setup logs (the worktree sync), folded into every
  // return from here on so a refusal after the sync still names the logs
  // it produced. Declared ahead of `refuse` below, which reads it.
  let setupLogPaths: string[] = [];
  const notRunResult = (item: PlannedMutant): PlanMutantResult => ({
    index: item.index,
    file: item.displayFile,
    expect: item.spec.expect,
    status: "not_run",
    warnings: [],
    logs: [],
  });
  /** Every verdict this plan has collected, in `planned` order: hoisted
   * out of the mutant loop so every exit path -- the loop's own returns,
   * a refusal before it, and the emergency-restore path in `finally` --
   * reports the verdicts that were actually reached instead of claiming
   * the plan never ran. */
  const results: PlanMutantResult[] = [];
  /** The mutant the loop is inside RIGHT NOW, cleared as soon as its
   * result is pushed: what the emergency-restore path in `finally`
   * reports for a mutant an unexpected error unwound the stack on, since
   * `not_run` would claim it was never attempted. */
  let inFlight:
    | {
        item: PlannedMutant;
        warnings: string[];
        logs: string[];
        mutant?: MutantField;
        mutantSummary?: string;
        verifiedAppliedVia?: string;
      }
    | undefined;
  /** The plan's results as they stand: every verdict collected, the
   * mutant in flight (when the caller has one to report), then `not_run`
   * for every mutant the plan never reached. */
  const resultsSoFar = (
    inFlightEntry?: PlanMutantResult,
  ): PlanMutantResult[] => {
    const reached = [
      ...results,
      ...(inFlightEntry === undefined ? [] : [inFlightEntry]),
    ];
    return [...reached, ...planned.slice(reached.length).map(notRunResult)];
  };
  const refuse = (
    status: ProbeStatus,
    reason: string,
    message?: string,
  ): ProbePlanResult => {
    const entries = resultsSoFar();
    return {
      status,
      reason,
      warnings: message === undefined ? warnings : [...warnings, message],
      results: entries,
      summary: summarize(entries),
      isolation: isolationField,
      ...(setupLogPaths.length > 0 ? { dryRunLogPaths: setupLogPaths } : {}),
    };
  };

  // Validation, all of it before the lock, the marker, the baseline or
  // any worktree: a plan that cannot be used leaves nothing behind.
  if (planned.length === 0) {
    return refuse(
      "usage_error",
      "plan_empty",
      "--plan carries no mutants; a plan needs at least one",
    );
  }
  for (const item of planned) {
    if (item.spec.form !== "patch" && item.spec.line === undefined) {
      return refuse(
        "usage_error",
        "plan_invalid",
        `plan.mutants[${String(item.index)}].line is required for the "${item.spec.form}" form`,
      );
    }
    if (item.spec.form === "patch" && opts.allowOutside) {
      // Same refusal the single probe makes for `-p` with
      // `--allow-outside`, and for the same reason: the dry run's
      // scratch placement is relative to the containment root, which a
      // path outside that root can escape with `../` components.
      return refuse(
        "usage_error",
        "patch_allow_outside_unsupported",
        `plan.mutants[${String(item.index)}] uses "patch", which cannot be combined with --allow-outside`,
      );
    }
    if (item.spec.form === "patch") {
      // Metadata only, the same check the single probe makes for `-p`
      // before anything hands the patch to `git apply`: an unusable
      // patch is a caller error naming the entry it belongs to, not a
      // mutant that turns out not to be applicable halfway through the
      // plan.
      const unusable = patchUnusableReason(
        item.spec.patchPath ?? "",
        `plan.mutants[${String(item.index)}].patch`,
      );
      if (unusable !== undefined) {
        return refuse("usage_error", "patch_not_readable", unusable);
      }
    }
  }

  let baseline: ExecPhaseField | undefined;
  // The locks and the run controller, handed over by `openRunSetup` the
  // moment they exist: from then on this function's own `finally` owns
  // the teardown, however the setup ends.
  let context: RunSetupContext | undefined;
  let caughtError: unknown;

  try {
    const setup = await openRunSetup({
      cwd,
      root,
      gitRoot,
      realRoot,
      logDir: opts.logDir,
      wtScratchRoot,
      isolation: opts.isolation,
      allowOutside: opts.allowOutside ?? false,
      displayLinks,
      absLinks,
      timeoutMs: opts.timeoutMs,
      gitApplyTimeoutMs,
      testCommand: opts.testCommand,
      preCommand: opts.preCommand,
      exitOnSignal: opts.exitOnSignal ?? false,
      warnings,
      isolationField,
      targets: planned.map((item) => ({
        displayFile: item.displayFile,
        absFile: item.absFile,
        label: `plan.mutants[${String(item.index)}].file`,
        subject: item.displayFile,
      })),
      priorLogPaths: [],
      // Every refusal a plan makes before anything runs is a usage
      // error, this one included (AC9); the single probe reports the
      // same finding as `inconclusive`.
      outsideRootStatus: "usage_error",
      onContext: (runContext) => {
        context = runContext;
      },
      // No `beforeBaseline`: a plan computes each mutant inside the loop
      // below, right before it is applied.
      // A plan can open more than one target; leaving the restore slot
      // armed to whichever one `openTarget` opened last would restore
      // only that target on a signal mid-baseline and leave every other
      // target as the baseline wrote it. See the field's own docblock.
      armRestoreDuringBaseline: false,
    });
    if (!setup.ok) {
      const { refusal } = setup;
      if (refusal.logPaths !== undefined) setupLogPaths = refusal.logPaths;
      // Nothing was collected yet, so these are all `not_run` -- the
      // same helper the loop's own returns and the emergency path use,
      // rather than a second way of saying it.
      const entries = resultsSoFar();
      return {
        status: refusal.status,
        reason: refusal.reason,
        warnings: refusal.warnings,
        ...(refusal.baseline !== undefined
          ? { baseline: refusal.baseline }
          : {}),
        results: entries,
        summary: summarize(entries),
        isolation: isolationField,
        ...(setupLogPaths.length > 0 ? { dryRunLogPaths: setupLogPaths } : {}),
      };
    }
    const { rt } = setup.run;
    baseline = setup.run.baseline;
    setupLogPaths = setup.run.logPaths;
    // Keyed by the resolved path every planned mutant carries, so the
    // mutants that share a file share one backup and one restore.
    const targets = new Map<string, TargetSession>(
      setup.run.targets.map((target) => [target.absFile, target]),
    );

    // One mutant at a time, never in parallel: each is applied against a
    // target proven to be back at its pre-mutation content, tested, and
    // restored before the next one is even computed.
    let terminal: string | undefined;
    for (const item of planned) {
      if (terminal !== undefined) {
        results.push(notRunResult(item));
        continue;
      }
      const target = targets.get(item.absFile);
      // Unreachable in practice: every planned mutant's file was opened
      // by the `openRunSetup` call above (`setup.ts`'s own target-opening
      // loop), and this map is keyed by the same resolved path. Kept as
      // a typed narrowing that reports `not_run` rather than throwing,
      // so a future caller that plans a target it never opened cannot
      // turn that into an unhandled exception mid-plan.
      if (target === undefined) {
        results.push(notRunResult(item));
        continue;
      }
      const mutantWarnings: string[] = [];
      // From here until this mutant's result is pushed, an unexpected
      // error unwinding the stack lands in `finally` with this mutant
      // applied: the emergency-restore path reports THIS entry rather
      // than calling it `not_run`.
      inFlight = { item, warnings: mutantWarnings, logs: [] };
      // I2, checked from the applying side: the previous mutant's
      // restore was verified when it ran, and the target is verified to
      // be back at its pre-mutation content here, before this mutant is
      // applied on top of it. A restore that silently did not happen
      // stops the plan instead of producing a verdict about a mutant
      // measured against another mutant's content.
      const currentHash = await sha256File(target.mutationFilePath).catch(
        () => undefined,
      );
      if (currentHash !== target.preHash) {
        terminal = "target_not_restored";
        results.push({
          index: item.index,
          file: item.displayFile,
          expect: item.spec.expect,
          status: "inconclusive",
          reason: "target_not_restored",
          warnings: [
            `${target.displayFile} was not at its pre-mutation content when this mutant was about to be applied; nothing further was applied, and the original content is preserved at backup path ${target.session.backupPath}`,
          ],
          logs: [],
        });
        inFlight = undefined;
        continue;
      }
      const prepared = await prepareMutant(
        rt,
        target,
        item.spec,
        mutantWarnings,
      );
      if (!prepared.ok) {
        // Nothing was applied, so this mutant is inconclusive on its own
        // and the plan continues -- unless the run itself was stopped.
        if (prepared.reason === "aborted" || rt.crashHandlers.isHandling()) {
          terminal = "aborted";
        }
        results.push({
          index: item.index,
          file: item.displayFile,
          expect: item.spec.expect,
          status: "inconclusive",
          reason: prepared.reason,
          warnings: mutantWarnings,
          logs: prepared.logPaths,
        });
        inFlight = undefined;
        continue;
      }
      // The evidence the emergency-restore path needs to report this
      // mutant honestly: it is applied from here on.
      inFlight = {
        item,
        warnings: mutantWarnings,
        logs: prepared.logPaths,
        mutant: prepared.mutant,
        mutantSummary: prepared.mutantSummary,
        verifiedAppliedVia: prepared.verifiedAppliedVia,
      };
      const outcome = await runMutantAttempt(
        rt,
        target,
        item.spec,
        {
          computed: prepared.computed,
          mutant: prepared.mutant,
          mutantSummary: prepared.mutantSummary,
          verifiedAppliedVia: prepared.verifiedAppliedVia,
          logPaths: prepared.logPaths,
        },
        mutantWarnings,
      );
      results.push({
        index: item.index,
        file: item.displayFile,
        expect: item.spec.expect,
        status: outcome.status,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        warnings: mutantWarnings,
        ...(outcome.mutant !== undefined ? { mutant: outcome.mutant } : {}),
        ...(outcome.mutation_probe !== undefined
          ? { mutation_probe: outcome.mutation_probe }
          : {}),
        ...(outcome.test !== undefined ? { test: outcome.test } : {}),
        logs: outcome.logPaths,
      });
      inFlight = undefined;
      // I3: a restore that could not be verified is terminal for the
      // plan. I5: so is a signal, whether this mutant's own phase
      // reported the abort or the handler is only just acting on it --
      // the next mutant must never start.
      if (outcome.restoreFailed) terminal = "restore_failed";
      else if (outcome.aborted || rt.crashHandlers.isHandling()) {
        terminal = "aborted";
      }
    }

    // The exit-code contract, one step stricter than "any survived is a
    // finding": exit 1 (`survived`) is reserved for a plan that
    // CONCLUDED and found a survivor, so a plan that stopped early, or
    // one carrying a mutant nothing could be learned from, is exit 2
    // (`inconclusive`) even when a survivor is among its results.
    const summary = summarize(results);
    let status: ProbeStatus;
    let reason: string | undefined = terminal;
    if (terminal !== undefined) {
      status = "inconclusive";
    } else if (summary.inconclusive > 0 || summary.not_run > 0) {
      status = "inconclusive";
      reason = "mutant_inconclusive";
    } else if (summary.survived > 0) {
      status = "survived";
    } else {
      status = "killed";
    }
    return {
      status,
      ...(reason !== undefined ? { reason } : {}),
      warnings,
      baseline,
      results,
      summary,
      isolation: isolationField,
      dryRunLogPaths: setupLogPaths,
    };
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    let emergencyResult: ProbePlanResult | undefined;
    // No context means the setup refused (or threw) before it took a
    // lock: nothing was opened, nothing is in flight, and there is
    // nothing to tear down.
    const inFlightRestore = context?.controller.getRestoreState();
    if (context !== undefined && inFlightRestore) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above: no path out of this
      // function may leave a target mutated, whether it returns or
      // throws.
      const state = inFlightRestore;
      context.controller.setRestoreState(null);
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
        // The verdicts already collected are reported as they stand,
        // and the mutant that was in flight as what it is: applied, its
        // restore unverified. Only the mutants this plan never reached
        // are `not_run`.
        const entries = resultsSoFar(
          inFlight === undefined
            ? undefined
            : {
                index: inFlight.item.index,
                file: inFlight.item.displayFile,
                expect: inFlight.item.spec.expect,
                status: "inconclusive",
                reason: "restore_failed",
                warnings: inFlight.warnings,
                ...(inFlight.mutant !== undefined
                  ? { mutant: inFlight.mutant }
                  : {}),
                ...(inFlight.mutantSummary !== undefined &&
                inFlight.verifiedAppliedVia !== undefined
                  ? {
                      mutation_probe: {
                        mutant: inFlight.mutantSummary,
                        verified_applied_via: inFlight.verifiedAppliedVia,
                        result: "inconclusive" as const,
                        restored_verified: false,
                      },
                    }
                  : {}),
                logs: inFlight.logs,
              },
        );
        emergencyResult = {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed after an unexpected error${
              causeMessage ? ` (${causeMessage})` : ""
            }; the original content is preserved at backup path ${state.backupPath}`,
          ],
          ...(baseline ? { baseline } : {}),
          results: entries,
          summary: summarize(entries),
          isolation: isolationField,
          ...(setupLogPaths.length > 0
            ? { dryRunLogPaths: setupLogPaths }
            : {}),
        };
      }
    }
    // Once per plan (I4), before the locks are released, so a concurrent
    // probe never observes the lock as free while this run's worktree
    // removal is still in flight.
    if (context !== undefined) {
      await context.controller.cleanupWtSession();
      context.controller.crashHandlers.remove();
      context.releaseLocks();
    }
    if (emergencyResult) return emergencyResult;
  }
}
