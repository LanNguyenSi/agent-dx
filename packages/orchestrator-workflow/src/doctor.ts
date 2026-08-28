import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PACKAGE_VERSION } from "./assets.js";
import type { Manifest } from "./init.js";
import { readInstalledManifest } from "./init.js";
import type { Profile, Role } from "./models.js";
import { DEFAULT_MODELS, ROLES } from "./models.js";
import type { OperatorManifest, OperatorTarget } from "./operator-manifest.js";
import {
  readOperatorManifest,
  writeOperatorManifest,
} from "./operator-manifest.js";

/**
 * A target's status against the operator's registry. `drift` takes
 * precedence over `divergent`/`version-lag` (a target can carry both a
 * profile/tiers/models divergence and a hash drift at the same time; the
 * drift is the more actionable fact, so it wins the status field while the
 * divergence is still reported on the target). `divergent` in turn takes
 * precedence over `version-lag`: a target can be both divergent and
 * version-lagging (see `versionLag` below), and both facts are reported,
 * but the status is `divergent`.
 */
export type TargetStatus =
  | "clean"
  | "divergent"
  | "version-lag"
  | "drift"
  | "missing"
  | "no-manifest";

export interface TargetDivergence {
  profile: boolean;
  tiers: boolean;
  models: boolean;
}

/**
 * Per-target report. Only `path`, `status`, `installedVersion`, `pin`,
 * `divergence`, and `driftFiles` are part of the `--json` contract
 * (`targetReportToJson` below picks exactly those); the remaining fields
 * exist to let the human-output printer in `cli.ts` render detail lines
 * without recomputing values `inspectTarget` already worked out.
 */
export interface TargetReport {
  path: string;
  status: TargetStatus;
  installedVersion: string | null;
  pin: string | null;
  divergence: TargetDivergence | null;
  driftFiles: string[] | null;
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
   * Human-output-only: whether this target is lagging the running kit
   * version (no pin recorded, and the installed version differs from the
   * kit version), independent of the final `status` field. Lets the
   * printer show the "installed X, operator Y" line for a target whose
   * status was overridden to `divergent` because it is both divergent and
   * lagging.
   */
  versionLag: boolean;
}

/** The subset of `TargetReport` that is part of the `--json` contract. */
export interface TargetReportJson {
  path: string;
  status: TargetStatus;
  installedVersion: string | null;
  pin: string | null;
  divergence: TargetDivergence | null;
  driftFiles: string[] | null;
}

export function targetReportToJson(report: TargetReport): TargetReportJson {
  return {
    path: report.path,
    status: report.status,
    installedVersion: report.installedVersion,
    pin: report.pin,
    divergence: report.divergence,
    driftFiles: report.driftFiles,
  };
}

export interface DoctorReport {
  operatorHome: string;
  operatorVersion: string;
  targets: TargetReport[];
  pruned: string[];
  exitCode: 0 | 1 | 2;
  /** Set only when no operator manifest exists; `targets` is then `[]`. */
  error?: "no-operator-manifest";
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
    const content = readFileSync(filePath, "utf8");
    if (sha256(content) !== recordedHash) {
      drifted.push(relativePath);
    }
  }
  return drifted;
}

function baseReport(
  target: OperatorTarget,
  operator: OperatorManifest,
  status: "missing" | "no-manifest",
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
  };
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
  if (!existsSync(target.path) || !statSync(target.path).isDirectory()) {
    return baseReport(target, operator, "missing");
  }

  const manifest = readInstalledManifest(target.path);
  if (!manifest) {
    return baseReport(target, operator, "no-manifest");
  }

  const driftFiles = computeDriftFiles(target.path, manifest);

  const divergentModelRoles = ROLES.filter(
    (role) =>
      resolvedModel(manifest.models, role) !==
      resolvedModel(operator.defaults.models, role),
  );
  const divergence: TargetDivergence = {
    profile: manifest.profile !== operator.defaults.profile,
    tiers: manifest.tiers !== operator.defaults.tiers,
    models: divergentModelRoles.length > 0,
  };

  // A recorded pin means the repo deliberately stayed on a kit version;
  // that is never version-lag, regardless of what the pin's value is
  // (including a pin equal to the repo's own installed version).
  const hasPin = typeof manifest.pin === "string" && manifest.pin.length > 0;
  const versionLag = !hasPin && manifest.version !== kitVersion;

  let status: TargetStatus;
  if (driftFiles.length > 0) {
    status = "drift";
  } else if (divergence.profile || divergence.tiers || divergence.models) {
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
    repoProfile: manifest.profile,
    operatorProfile: operator.defaults.profile,
    repoTiers: manifest.tiers,
    operatorTiers: operator.defaults.tiers,
    divergentModelRoles,
    versionLag,
  };
}

const REMOVE_ON_PRUNE: ReadonlySet<TargetStatus> = new Set<TargetStatus>([
  "missing",
  "no-manifest",
]);

/**
 * Walks the operator manifest's target registry at `home` and reports each
 * target's status. No printing, no `process.exit`: `cli.ts` turns this
 * into human or `--json` output and applies `exitCode` itself.
 *
 * Exit-code contract: 2 when no operator manifest exists (nothing else is
 * evaluated); else 1 if any *remaining* target (after an optional prune) is
 * `drift`, `missing`, or `no-manifest`; else 0.
 *
 * `--prune`: targets whose status is `missing` or `no-manifest` are removed
 * from the operator manifest's `targets` array and persisted (only when at
 * least one target was actually removed, mirroring `setup`'s no-op-write
 * avoidance) before the exit code and `targets` in the returned report are
 * computed, so both reflect the post-prune registry. `pruned` always lists
 * the removed paths, even when empty.
 */
export function runDoctor(
  home: string,
  options: { prune?: boolean } = {},
): DoctorReport {
  const operator = readOperatorManifest(home);
  if (!operator) {
    return {
      operatorHome: home,
      operatorVersion: PACKAGE_VERSION,
      targets: [],
      pruned: [],
      exitCode: 2,
      error: "no-operator-manifest",
    };
  }

  const allReports = operator.targets.map((target) =>
    inspectTarget(target, operator, PACKAGE_VERSION),
  );

  let targets = allReports;
  const pruned: string[] = [];

  if (options.prune) {
    const keepPaths = new Set<string>();
    for (const report of allReports) {
      if (REMOVE_ON_PRUNE.has(report.status)) {
        pruned.push(report.path);
      } else {
        keepPaths.add(report.path);
      }
    }
    targets = allReports.filter((report) => keepPaths.has(report.path));

    if (pruned.length > 0) {
      writeOperatorManifest(home, {
        ...operator,
        targets: operator.targets.filter((target) =>
          keepPaths.has(target.path),
        ),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const exitCode: 0 | 1 = targets.some(
    (report) =>
      report.status === "drift" ||
      report.status === "missing" ||
      report.status === "no-manifest",
  )
    ? 1
    : 0;

  return {
    operatorHome: home,
    operatorVersion: PACKAGE_VERSION,
    targets,
    pruned,
    exitCode,
  };
}
