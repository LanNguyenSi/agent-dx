import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { Harness } from "./detect.js";
import { HARNESSES } from "./detect.js";
import type { Profile, Role } from "./models.js";
import {
  DEFAULT_PROFILE,
  ROLES,
  assertValidModelId,
  isProfile,
} from "./models.js";

export const OPERATOR_HOME_DIRNAME = ".orchestrator-workflow";
export const OPERATOR_HOME_ENV = "ORCHESTRATOR_WORKFLOW_HOME";
export const OPERATOR_MANIFEST_FILENAME = "manifest.json";

/**
 * Operator-level defaults applied when a target is (re-)applied without its
 * own explicit flags. `models` is a `Partial<Record<Role, string>>` rather
 * than a full `Record`, mirroring `readInstalledManifest`'s per-role
 * degradation: a hand-written or legacy operator manifest may carry only
 * some roles, and the rest should fall back to `DEFAULT_MODELS` at the call
 * site rather than forcing every role to be present here.
 */
export interface OperatorManifestDefaults {
  harnesses: Harness[];
  profile: Profile;
  tiers: boolean;
  models: Partial<Record<Role, string>>;
}

/** One target directory this operator has applied the kit to. */
export interface OperatorTarget {
  path: string;
  lastAppliedVersion: string;
  lastAppliedAt: string;
}

export interface OperatorManifest {
  kit: "orchestrator-workflow";
  schemaVersion: 1;
  defaults: OperatorManifestDefaults;
  targets: OperatorTarget[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolves the operator-level home directory. Precedence: an explicit
 * argument, then `ORCHESTRATOR_WORKFLOW_HOME`, then `~/.orchestrator-workflow/`.
 * Both the explicit argument and the env var are made absolute via
 * `node:path`'s `resolve` (relative to `process.cwd()`), matching the
 * Precedence: an explicit argument, then the environment override, then the
 * default directory under the user's home.
 * access, no directory creation, no env-var reads beyond the lookup itself.
 */
export function resolveOperatorHome(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) {
    return resolve(explicit);
  }
  const envValue = process.env[OPERATOR_HOME_ENV];
  if (typeof envValue === "string" && envValue.length > 0) {
    return resolve(envValue);
  }
  return join(homedir(), OPERATOR_HOME_DIRNAME);
}

/** Creates a fresh operator manifest with no targets yet applied. */
export function createOperatorManifest(
  defaults: OperatorManifestDefaults,
  now?: string,
): OperatorManifest {
  const timestamp = now ?? new Date().toISOString();
  return {
    kit: "orchestrator-workflow",
    schemaVersion: 1,
    defaults,
    targets: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Reads the operator-level manifest at `<home>/manifest.json`, if any. The
 * file can be hand-written or damaged, so every field is sanitized the same
 * way `readInstalledManifest` sanitizes a per-repo manifest: anything
 * invalid degrades to a safe default instead of throwing. Only the
 * envelope fields (`kit`, `schemaVersion`) are hard requirements; a
 * mismatch there means "not a manifest we recognize" and the whole read
 * returns `undefined` rather than guessing.
 */
export function readOperatorManifest(
  home: string,
): OperatorManifest | undefined {
  const path = join(home, OPERATOR_MANIFEST_FILENAME);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kit !== "orchestrator-workflow") return undefined;
  if (candidate.schemaVersion !== 1) return undefined;

  const rawDefaults =
    typeof candidate.defaults === "object" && candidate.defaults !== null
      ? (candidate.defaults as Record<string, unknown>)
      : {};

  const harnesses = (
    Array.isArray(rawDefaults.harnesses) ? rawDefaults.harnesses : []
  ).filter((value): value is Harness =>
    (HARNESSES as string[]).includes(value as string),
  );

  const models: Partial<Record<Role, string>> = {};
  if (typeof rawDefaults.models === "object" && rawDefaults.models !== null) {
    for (const role of ROLES) {
      const value = (rawDefaults.models as Record<string, unknown>)[role];
      if (typeof value !== "string") continue;
      try {
        assertValidModelId(value);
        models[role] = value;
      } catch {
        // Invalid model ids are dropped; the role falls back to defaults.
      }
    }
  }

  const profile: Profile =
    typeof rawDefaults.profile === "string" && isProfile(rawDefaults.profile)
      ? rawDefaults.profile
      : DEFAULT_PROFILE;

  const tiers =
    typeof rawDefaults.tiers === "boolean" ? rawDefaults.tiers : false;

  const targets: OperatorTarget[] = (
    Array.isArray(candidate.targets) ? candidate.targets : []
  ).filter((value): value is OperatorTarget => {
    if (typeof value !== "object" || value === null) return false;
    const t = value as Record<string, unknown>;
    return (
      typeof t.path === "string" &&
      isAbsolute(t.path) &&
      typeof t.lastAppliedVersion === "string" &&
      typeof t.lastAppliedAt === "string"
    );
  });

  return {
    kit: "orchestrator-workflow",
    schemaVersion: 1,
    defaults: { harnesses, profile, tiers, models },
    targets,
    createdAt:
      typeof candidate.createdAt === "string" ? candidate.createdAt : "",
    updatedAt:
      typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
  };
}

/**
 * Writes the operator-level manifest, creating `home` if it does not yet
 * exist. Same two-space-indented-plus-trailing-newline JSON shape
 * `readInstalledManifest`'s writer (init.ts) uses for the per-repo manifest.
 */
export function writeOperatorManifest(
  home: string,
  manifest: OperatorManifest,
): void {
  mkdirSync(home, { recursive: true });
  const path = join(home, OPERATOR_MANIFEST_FILENAME);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Realpath that never throws: a recorded target whose directory has since
 * been removed or moved (the `missing` case a later doctor reports) must not
 * make an unrelated upsert fail, so the stored path is compared as written
 * when it can no longer be resolved.
 */
function safeRealpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Returns a new manifest with `targetPath` recorded as applied. Pure: does
 * not mutate `manifest` or its nested `targets` array/entries. Targets are
 * deduplicated by realpath (`fs.realpathSync`) rather than raw string
 * equality, so the same directory reached via a symlink or a differently
 * cased/relative path still updates the existing entry in place instead of
 * appending a duplicate.
 */
export function upsertOperatorTarget(
  manifest: OperatorManifest,
  targetPath: string,
  appliedVersion: string,
  appliedAt: string,
): OperatorManifest {
  const resolvedPath = realpathSync(targetPath);
  const existingIndex = manifest.targets.findIndex(
    (target) => safeRealpath(target.path) === resolvedPath,
  );

  const targets = manifest.targets.map((target) => ({ ...target }));
  if (existingIndex === -1) {
    targets.push({
      path: resolvedPath,
      lastAppliedVersion: appliedVersion,
      lastAppliedAt: appliedAt,
    });
  } else {
    targets[existingIndex] = {
      ...targets[existingIndex],
      lastAppliedVersion: appliedVersion,
      lastAppliedAt: appliedAt,
    };
  }

  return {
    ...manifest,
    defaults: {
      ...manifest.defaults,
      models: { ...manifest.defaults.models },
    },
    targets,
  };
}
