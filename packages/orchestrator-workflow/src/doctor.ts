import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

import { PACKAGE_VERSION } from "./assets.js";
import type { Manifest } from "./init.js";
import { MANIFEST_PATH, readInstalledManifest } from "./init.js";
import type { Profile, Role } from "./models.js";
import { DEFAULT_MODELS, rolesForProfile } from "./models.js";
import { compareRoutingState } from "./routing-state.js";
import type {
  OperatorManifest,
  OperatorManifestLockOptions,
  OperatorManifestState,
  OperatorTarget,
} from "./operator-manifest.js";
import {
  OPERATOR_MANIFEST_FILENAME,
  operatorManifestState,
  updateOperatorManifest,
} from "./operator-manifest.js";

/**
 * A target's status against the operator's registry. `drift` takes
 * precedence over `divergent`/`version-lag` (a target can carry both a
 * profile/tiers/models divergence and a hash drift at the same time; the
 * drift is the more actionable fact, so it wins the status field while the
 * divergence is still reported on the target). `divergent` in turn takes
 * precedence over `version-lag`: a target can be both divergent and
 * version-lagging (see `versionLag` below), and both facts are reported,
 * but the status is `divergent`. `unverifiable` is separate from both
 * `missing` and `no-manifest`: the target directory or its repo manifest
 * could not be checked at all (a stat failure other than ENOENT, most
 * commonly EACCES on an ancestor directory, or a manifest file present but
 * unreadable/unparseable), so nothing is actually known about this
 * target's real state. Unlike `missing`/`no-manifest`, `--prune` never
 * removes an `unverifiable` target (review round 2, M1): an unreadable
 * target might still be perfectly fine, and dropping its registry row on
 * that basis would be an unrecoverable guess.
 */
export type TargetStatus =
  | "clean"
  | "divergent"
  | "version-lag"
  | "drift"
  | "missing"
  | "no-manifest"
  | "unverifiable";

export interface TargetDivergence {
  profile: boolean;
  tiers: boolean;
  models: boolean;
  /** Present only when explicit effective routing differs. */
  routing?: boolean;
}

/**
 * Per-target report. Only `path`, `status`, `installedVersion`, `pin`,
 * `divergence`, `driftFiles`, `versionLag`, and `reason` are part of the
 * `--json` contract (`targetReportToJson` below picks exactly those); the
 * remaining fields exist to let the human-output printer in `cli.ts`
 * render detail lines without recomputing values `inspectTarget` already
 * worked out.
 */
export interface TargetReport {
  path: string;
  status: TargetStatus;
  installedVersion: string | null;
  pin: string | null;
  divergence: TargetDivergence | null;
  driftFiles: string[] | null;
  /** Selected legacy opencode leaves that cannot be compared offline. */
  routingComparisonGaps?: string[];
  /** Human-output-only: the repo's own profile, or null when unknown. */
  repoProfile: Profile | null;
  /** Human-output-only: the operator default profile, for the comparison line. */
  operatorProfile: Profile;
  /** Human-output-only: the repo's own tiers flag, or null when unknown. */
  repoTiers: boolean | null;
  /** Human-output-only: the operator default tiers flag, for the comparison line. */
  operatorTiers: boolean;
  /** Human-output-only: roles whose resolved model differs from the operator default. */
  divergentModelRoles: Role[];
  /**
   * Whether this target is lagging the running kit version (no pin
   * recorded, and the installed version differs from the kit version),
   * independent of the final `status` field. Lets the printer show the
   * "installed X, operator Y" line for a target whose status was
   * overridden to `divergent` or `drift` because it is also lagging.
   * Part of the `--json` contract since fix-round-2 (review finding L6):
   * a `--json` consumer previously had no way to see version-lag on a
   * target whose status field reads `divergent` or `drift`.
   */
  versionLag: boolean;
  /**
   * `null` for every status except `unverifiable`, where it explains what
   * could not be checked: `"directory not accessible"` (the target
   * directory, or a directory on the path to its repo manifest, failed to
   * stat for a reason other than ENOENT) or `"manifest unreadable"` (the
   * directory itself stats fine and the manifest file exists, but it could
   * not be parsed or read). Part of the `--json` contract (review finding
   * M1) so a `--json` consumer can distinguish the two causes without
   * re-deriving them.
   */
  reason: string | null;
}

/** The subset of `TargetReport` that is part of the `--json` contract. */
export interface TargetReportJson {
  path: string;
  status: TargetStatus;
  installedVersion: string | null;
  pin: string | null;
  divergence: TargetDivergence | null;
  driftFiles: string[] | null;
  /** Selected legacy opencode leaves that cannot be compared offline. */
  routingComparisonGaps?: string[];
  versionLag: boolean;
  reason: string | null;
}

export function targetReportToJson(report: TargetReport): TargetReportJson {
  return {
    path: report.path,
    status: report.status,
    installedVersion: report.installedVersion,
    pin: report.pin,
    divergence: report.divergence,
    driftFiles: report.driftFiles,
    ...(report.routingComparisonGaps?.length
      ? { routingComparisonGaps: report.routingComparisonGaps }
      : {}),
    versionLag: report.versionLag,
    reason: report.reason,
  };
}

/**
 * Maps a single target's status to `adopt`'s single-target exit-code
 * contract: 0 for `clean`/`divergent`/`version-lag`, 1 for `drift`, 2 for
 * `missing`/`no-manifest`/`unverifiable`. A pure function, exported and
 * unit-testable directly against all seven {@link TargetStatus} values,
 * rather than left as the inline ternary chain `cli.ts`'s `adopt` action
 * used to carry (fix-round, review findings M3/L5): a live `adopt` run can
 * only ever exercise `clean`/`divergent`/`version-lag`/`drift` in practice
 * (the directory and manifest were just read successfully immediately
 * before this status is computed), so the `missing`/`no-manifest`/
 * `unverifiable` branches were previously pinned by nothing at all.
 */
export function adoptExitCodeForStatus(status: TargetStatus): 0 | 1 | 2 {
  switch (status) {
    case "missing":
    case "no-manifest":
    case "unverifiable":
      return 2;
    case "drift":
      return 1;
    case "clean":
    case "divergent":
    case "version-lag":
      return 0;
  }
}

/**
 * Whether `adopt`'s human-mode success line ("Adopted ...") must be
 * suppressed for a target report whose status is `status`: true for exactly
 * the three statuses {@link adoptExitCodeForStatus} maps to exit code 2
 * (`missing`, `no-manifest`, `unverifiable`), statuses that should not
 * occur for a target whose directory and manifest were just verified
 * immediately before this status was computed, so printing the success line
 * ahead of the stderr bug note would be misleading. A pure function,
 * exported and unit-tested directly against all seven {@link TargetStatus}
 * values, rather than left as `cli.ts`'s inline `exitCode === 2` check
 * (fix-round-2), the same reasoning that already pulled
 * `adoptExitCodeForStatus` itself out of an inline ternary chain.
 */
export function suppressSuccessLine(status: TargetStatus): boolean {
  return adoptExitCodeForStatus(status) === 2;
}

export interface DoctorReport {
  operatorHome: string;
  operatorVersion: string;
  targets: TargetReport[];
  pruned: string[];
  exitCode: 0 | 1 | 2;
  /**
   * The count of raw `targets` array entries in the on-disk operator
   * manifest that `readOperatorManifest`'s own per-entry validation
   * silently dropped (wrong shape, a missing field, ...), distinct from
   * the targets named in `pruned` above (which were validly-shaped but
   * `missing`/`no-manifest`). Always `0` unless `--prune` both ran and
   * actually wrote (`pruned.length > 0`); `cli.ts`'s human-output prune
   * note prints only when this is greater than zero, naming the count
   * (fix-round-2 review finding M3: the note used to print unconditionally
   * whenever anything at all was pruned, even when the file held no
   * unvalidatable raw entry to report).
   */
  unvalidatedDropped: number;
  /**
   * Set only when no operator manifest was evaluated; `targets` is then
   * `[]`. `no-operator-manifest`: no file exists at
   * `<operatorHome>/manifest.json`. `operator-manifest-unreadable`: the
   * file exists but `readOperatorManifest` could not parse or validate it
   * (corrupt JSON, or an envelope that does not match this kit).
   */
  error?: "no-operator-manifest" | "operator-manifest-unreadable";
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Resolves a role's model against a possibly-partial models map, falling
 * back to the shipped default the same way `cli.ts`'s `defaultsAsManifest`
 * and `readInstalledManifest`'s per-role degradation both already do. */
function resolvedModel(
  models: Partial<Record<Role, string>>,
  role: Role,
): string {
  return models[role] ?? DEFAULT_MODELS[role];
}

/**
 * Relative paths (from the repo manifest's `files` ledger) whose on-disk
 * sha256 no longer matches the recorded hash, or that are missing/not a
 * regular file on disk. Empty when the target is clean of drift.
 */
function computeDriftFiles(targetPath: string, manifest: Manifest): string[] {
  const drifted: string[] = [];
  for (const [relativePath, recordedHash] of Object.entries(manifest.files)) {
    const filePath = join(targetPath, relativePath);
    let isFile = false;
    try {
      isFile = existsSync(filePath) && statSync(filePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      drifted.push(relativePath);
      continue;
    }
    // A file that exists and stat's as a regular file can still fail to
    // read (permissions, a race with something else removing it, ...). A
    // read failure means this path's drift status against the recorded
    // hash cannot be verified, so it is counted as drift rather than
    // aborting the whole target (and the rest of the registry).
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      drifted.push(relativePath);
      continue;
    }
    if (sha256(content) !== recordedHash) {
      drifted.push(relativePath);
    }
  }
  return drifted;
}

function baseReport(
  target: OperatorTarget,
  operator: OperatorManifest,
  status: "missing" | "no-manifest" | "unverifiable",
  reason: string | null,
): TargetReport {
  return {
    path: target.path,
    status,
    installedVersion: null,
    pin: null,
    divergence: null,
    driftFiles: null,
    repoProfile: null,
    operatorProfile: operator.defaults.profile,
    repoTiers: null,
    operatorTiers: operator.defaults.tiers,
    divergentModelRoles: [],
    versionLag: false,
    reason,
  };
}

/**
 * Stats `path`, distinguishing "does not exist" (`ENOENT`) from every other
 * stat failure (most commonly `EACCES` on an ancestor directory). Plain
 * `existsSync` cannot make this distinction: it swallows every error alike
 * and returns `false` either way (review round 2, M2), which is exactly
 * what let an inaccessible-but-present target get misreported as
 * `missing`/`no-manifest` and then pruned out of the registry on a guess.
 */
export function statOrClassify(
  path: string,
): { kind: "ok"; stat: Stats } | { kind: "enoent" } | { kind: "error" } {
  try {
    return { kind: "ok", stat: statSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "enoent" }
      : { kind: "error" };
  }
}

/**
 * Computes one target's status against the operator's registry. Pure
 * read-only I/O (existence checks, file hashing, reading the target's own
 * repo manifest); no printing, no `process.exit`. Exported standalone so a
 * later `adopt` command can reuse the same per-target computation `doctor`
 * uses.
 */
export function inspectTarget(
  target: OperatorTarget,
  operator: OperatorManifest,
  kitVersion: string,
): TargetReport {
  const dirStat = statOrClassify(target.path);
  if (dirStat.kind === "enoent") {
    return baseReport(target, operator, "missing", null);
  }
  if (dirStat.kind === "error") {
    return baseReport(
      target,
      operator,
      "unverifiable",
      "directory not accessible",
    );
  }
  if (!dirStat.stat.isDirectory()) {
    return baseReport(target, operator, "missing", null);
  }

  const manifestStat = statOrClassify(join(target.path, MANIFEST_PATH));
  if (manifestStat.kind === "enoent") {
    return baseReport(target, operator, "no-manifest", null);
  }
  if (manifestStat.kind === "error") {
    return baseReport(
      target,
      operator,
      "unverifiable",
      "directory not accessible",
    );
  }

  let manifest: Manifest | undefined;
  try {
    manifest = readInstalledManifest(target.path);
  } catch {
    // Strict reinstall validation must not abort inspection of other targets.
    return baseReport(target, operator, "unverifiable", "manifest unreadable");
  }
  if (!manifest) {
    return baseReport(target, operator, "unverifiable", "manifest unreadable");
  }

  const driftFiles = computeDriftFiles(target.path, manifest);

  const divergentModelRoles = rolesForProfile(manifest.profile).filter(
    (role) =>
      manifest.harnesses.some(
        (harness) => harness === "claude" || harness === "opencode",
      ) &&
      resolvedModel(manifest.models, role) !==
        resolvedModel(operator.defaults.models, role),
  );
  const routingComparison = compareRoutingState(manifest, operator.defaults, {
    harnesses: manifest.harnesses,
    profile: manifest.profile,
    tiers: manifest.tiers,
  });
  const divergence: TargetDivergence = {
    profile: manifest.profile !== operator.defaults.profile,
    tiers: manifest.tiers !== operator.defaults.tiers,
    models: divergentModelRoles.length > 0,
    ...(routingComparison.differs ? { routing: true } : {}),
  };

  // A recorded pin suppresses version-lag only when the pin equals the
  // repo's own installed version: that is the expected, deliberate-stay
  // state. When the pin and the installed version differ, the installed
  // manifest no longer reflects what was pinned (someone changed the pin
  // without reapplying, or the installed version drifted some other way),
  // so the target is still version-lag, even though it carries a pin
  // (drift, if also present, still takes precedence over the final status
  // field below). With no pin at all, version-lag compares the installed
  // version against the running kit version, as before.
  const hasPin = typeof manifest.pin === "string" && manifest.pin.length > 0;
  const versionLag = hasPin
    ? manifest.pin !== manifest.version
    : manifest.version !== kitVersion;

  let status: TargetStatus;
  if (driftFiles.length > 0) {
    status = "drift";
  } else if (
    divergence.profile ||
    divergence.tiers ||
    divergence.models ||
    divergence.routing
  ) {
    status = "divergent";
  } else if (versionLag) {
    status = "version-lag";
  } else {
    status = "clean";
  }

  return {
    path: target.path,
    status,
    installedVersion: manifest.version.length > 0 ? manifest.version : null,
    pin: hasPin ? (manifest.pin as string) : null,
    divergence,
    driftFiles: driftFiles.length > 0 ? driftFiles : null,
    ...(routingComparison.gaps.length > 0
      ? { routingComparisonGaps: routingComparison.gaps }
      : {}),
    repoProfile: manifest.profile,
    operatorProfile: operator.defaults.profile,
    repoTiers: manifest.tiers,
    operatorTiers: operator.defaults.tiers,
    divergentModelRoles,
    versionLag,
    reason: null,
  };
}

const REMOVE_ON_PRUNE: ReadonlySet<TargetStatus> = new Set<TargetStatus>([
  "missing",
  "no-manifest",
]);

/**
 * Re-reads `<home>/manifest.json`'s raw JSON (independent of
 * `readOperatorManifest`'s own parsed, validated result) and counts the
 * entries in its `targets` array, or `null` when the file cannot be read
 * or parsed at all. `readOperatorManifest` silently drops any raw target
 * entry that fails its own per-entry shape check, so its parsed
 * `manifest.targets.length` alone cannot tell whether the file held extra,
 * unvalidatable entries; this reads the same bytes a second time to answer
 * exactly that (review round 2, M3).
 */
function countRawTargets(home: string): number | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(home, OPERATOR_MANIFEST_FILENAME), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const candidate = raw as Record<string, unknown>;
    return Array.isArray(candidate.targets) ? candidate.targets.length : 0;
  } catch {
    return null;
  }
}

/**
 * Walks the operator manifest's target registry at `home` and reports each
 * target's status. No printing, no `process.exit`: `cli.ts` turns this
 * into human or `--json` output and applies `exitCode` itself.
 *
 * Exit-code contract: 2 when no operator manifest exists (nothing else is
 * evaluated); else 1 if any *remaining* target (after an optional prune) is
 * `drift`, `missing`, `no-manifest`, or `unverifiable`; else 0.
 *
 * `--prune`: targets whose status is `missing` or `no-manifest` are removed
 * from the operator manifest's `targets` array and persisted (only when at
 * least one target was actually removed, mirroring `setup`'s no-op-write
 * avoidance) before the exit code and `targets` in the returned report are
 * computed, so both reflect the post-prune registry. `unverifiable` targets
 * are never removed (see {@link TargetStatus}'s doc comment). `pruned`
 * always lists the removed paths, even when empty. The whole re-read,
 * report computation, and write run inside {@link updateOperatorManifest}'s
 * single locked critical section (review round 1, H1's own fix, reused
 * here rather than doctor keeping a second, unlocked read-modify-write path
 * of its own), so a concurrent `apply`/`setup`/another `doctor --prune`
 * cannot land its own write in between this read and this write.
 *
 * `options.lockOptions` is exposed only so tests can shrink
 * `updateOperatorManifest`'s lock-acquire timeout/staleness/poll windows
 * below their production defaults (see `OperatorManifestLockOptions`);
 * production callers should omit it entirely. `updateOperatorManifest`
 * (via `withOperatorManifestLock`) can itself throw rather than return,
 * most commonly `OperatorManifestLockTimeoutError` (another
 * orchestrator-workflow command holds the lock past the timeout) or any
 * other error raised while acquiring it (e.g. `EACCES` creating the lock
 * directory under a read-only operator home). This function deliberately
 * does not catch either: `cli.ts`'s `doctor` action is the layer that
 * turns such a throw into a `--json`/human-readable exit-2 report,
 * exactly the way it already turns a returned `DoctorReport` into one.
 */
export function runDoctor(
  home: string,
  options: { prune?: boolean; lockOptions?: OperatorManifestLockOptions } = {},
): DoctorReport {
  const state: OperatorManifestState = operatorManifestState(home);
  if (state.kind !== "ok") {
    // `absent`: no file to read. `unreadable`: the file exists but is
    // corrupt or does not validate. Distinguished here so the CLI can tell
    // an operator who has simply never run `setup` apart from one whose
    // manifest needs repair (the latter must not be papered over by
    // re-running `setup`, which would silently rewrite `targets: []` over
    // a possibly-fine targets array sitting next to the unreadable
    // envelope).
    const error: NonNullable<DoctorReport["error"]> =
      state.kind === "absent"
        ? "no-operator-manifest"
        : "operator-manifest-unreadable";
    return {
      operatorHome: home,
      operatorVersion: PACKAGE_VERSION,
      targets: [],
      pruned: [],
      exitCode: 2,
      unvalidatedDropped: 0,
      error,
    };
  }

  const pruned: string[] = [];
  let unvalidatedDropped = 0;
  let targets: TargetReport[];

  if (options.prune) {
    // `computedReports`/`pruned`/`unvalidatedDropped` are captured from
    // inside `mutate` (mirroring `apply`'s own `resolvedTargetPath`/
    // `alreadyRegistered` capture in cli.ts) since `mutate` can only return
    // an `OperatorManifest | undefined`. `mutate` re-reads and re-computes
    // from scratch rather than reusing `state` above (which may already be
    // stale by the time the lock is granted), the same reasoning `apply`'s
    // own re-read documents.
    let computedReports: TargetReport[] | undefined;
    const result = updateOperatorManifest(
      home,
      (current, innerState) => {
        if (innerState.kind !== "ok" || !current) {
          return undefined;
        }
        const reports = current.targets.map((target) =>
          inspectTarget(target, current, PACKAGE_VERSION),
        );
        computedReports = reports;

        const keepPaths = new Set<string>();
        for (const report of reports) {
          if (REMOVE_ON_PRUNE.has(report.status)) {
            pruned.push(report.path);
          } else {
            keepPaths.add(report.path);
          }
        }
        if (pruned.length === 0) {
          return undefined;
        }

        const rawTargetCount = countRawTargets(home);
        if (rawTargetCount !== null) {
          unvalidatedDropped = Math.max(
            0,
            rawTargetCount - current.targets.length,
          );
        }

        return {
          ...current,
          targets: current.targets.filter((target) =>
            keepPaths.has(target.path),
          ),
          updatedAt: new Date().toISOString(),
        };
      },
      options.lockOptions,
    );

    if (result.state.kind !== "ok") {
      // The manifest that read `"ok"` in the outer, unlocked check above
      // (`state`) was found gone or unreadable once the lock was actually
      // granted: a concurrent writer's own read-modify-write landed in
      // between that outer read and this one. `state` is now stale and
      // must not be used as a fallback source of targets (that fallback
      // is exactly what previously let a `--prune` run report, and
      // silently keep, target rows against a registry that no longer
      // exists on disk). Report the failure directly instead, the same
      // shape the outer absent/unreadable check above already returns.
      const error: NonNullable<DoctorReport["error"]> =
        result.state.kind === "absent"
          ? "no-operator-manifest"
          : "operator-manifest-unreadable";
      return {
        operatorHome: home,
        operatorVersion: PACKAGE_VERSION,
        targets: [],
        pruned: [],
        exitCode: 2,
        unvalidatedDropped: 0,
        error,
      };
    }

    // `result.state.kind === "ok"` means `mutate` above ran with a truthy
    // `current`, so `computedReports` was always assigned.
    targets = (computedReports as TargetReport[]).filter(
      (report) => !pruned.includes(report.path),
    );
  } else {
    targets = state.manifest.targets.map((target) =>
      inspectTarget(target, state.manifest, PACKAGE_VERSION),
    );
  }

  const exitCode: 0 | 1 = targets.some(
    (report) =>
      report.status === "drift" ||
      report.status === "missing" ||
      report.status === "no-manifest" ||
      report.status === "unverifiable",
  )
    ? 1
    : 0;

  return {
    operatorHome: home,
    operatorVersion: PACKAGE_VERSION,
    targets,
    pruned,
    exitCode,
    unvalidatedDropped,
  };
}

/**
 * The extra `--json` key `adopt` adds only for a target status that should
 * be unreachable immediately after a successful directory/manifest read
 * (`missing`/`no-manifest`/`unverifiable`, i.e. wherever
 * {@link adoptExitCodeForStatus} returns `2`): `error:
 * "unexpected-target-status"`, so a `--json` consumer can tell this genuine
 * internal-error case apart from any other result sharing the same exit
 * code (fix-round, review finding M3). Appended at the end of this module,
 * after every other exported member, so adding it does not shift any
 * existing `doctor.ts:` line citation in docs/okf. A pure function,
 * exported and unit-tested directly (the branch itself stays unreachable
 * through a live `adopt` run, the same "unreachable in practice" property
 * `cli.ts`'s own comment on that branch already documents).
 */
export function adoptJsonExtras(
  status: TargetStatus,
): { error: "unexpected-target-status" } | Record<string, never> {
  return adoptExitCodeForStatus(status) === 2
    ? { error: "unexpected-target-status" }
    : {};
}
