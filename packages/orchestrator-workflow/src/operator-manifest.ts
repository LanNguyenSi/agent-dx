import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
import { parseRouting } from "./routing.js";
import { parseOpencodeModelMaps } from "./routing-state.js";
import type { OpencodeModelMaps } from "./routing-state.js";
import type { HarnessRouting } from "./routing.js";

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
export interface OperatorManifestDefaults extends OpencodeModelMaps {
  harnesses: Harness[];
  profile: Profile;
  tiers: boolean;
  models: Partial<Record<Role, string>>;
  /** Explicit or resolved per-harness selections, carried additively. */
  routing?: HarnessRouting;
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

  let opencodeMaps: OpencodeModelMaps;
  try {
    opencodeMaps = parseOpencodeModelMaps(rawDefaults);
  } catch {
    return undefined;
  }
  let routing: HarnessRouting | undefined;
  if ("routing" in rawDefaults) {
    try {
      routing = parseRouting(rawDefaults.routing);
    } catch {
      // Unlike legacy aliases, an invalid routing map could silently change
      // native Codex agents on a future install. Treat the whole operator
      // manifest as unreadable so setup/apply cannot overwrite it by guess.
      return undefined;
    }
  }

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
    defaults: {
      harnesses,
      profile,
      tiers,
      models,
      ...(routing !== undefined ? { routing } : {}),
      ...opencodeMaps,
    },
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
 *
 * Written atomically: the content lands in a `.<pid>.<random>.tmp` sibling
 * file first, then `renameSync` swaps it over the real path. A rename onto
 * an existing file is atomic on the same filesystem (POSIX and NTFS both
 * guarantee this), so a reader never observes a partially written file, and
 * two concurrent writers each still write their own complete file whole,
 * rather than interleaving bytes into a shared corrupt one. This alone
 * narrows, but does not close, the operator-manifest lost-update window: the
 * remaining race is between one writer's fresh read and its rename, not
 * within the write itself.
 *
 * Deliberately **not exported**. Closing that remaining race is {@link
 * updateOperatorManifest}'s job, not this function's: every read-modify-
 * write sequence against the operator manifest (`setup`'s and `apply`'s
 * registration step, both in cli.ts) must go through that single locked
 * entry point instead of calling this raw writer directly, so no command
 * can bypass the lock. This function stays around only as the primitive
 * `updateOperatorManifest` builds on; even this module's own tests exercise
 * writes through `updateOperatorManifest` rather than calling this directly,
 * so no test accidentally models a call path production code no longer has.
 */
function writeOperatorManifestUnlocked(
  home: string,
  manifest: OperatorManifest,
): void {
  mkdirSync(home, { recursive: true });
  const path = join(home, OPERATOR_MANIFEST_FILENAME);
  const tmpPath = join(
    home,
    `${OPERATOR_MANIFEST_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  parseOpencodeModelMaps(manifest.defaults);
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

const OPERATOR_MANIFEST_LOCK_DIRNAME = ".manifest.lock";
const OPERATOR_MANIFEST_LOCK_OWNER_FILENAME = "owner";

/** Default lock-acquire timeout, in milliseconds. Deliberately kept above
 * {@link DEFAULT_LOCK_STALE_MS}: a caller that starts anywhere from 0ms up
 * to `DEFAULT_LOCK_STALE_MS` after a killed holder left its lock behind
 * must still live long enough, polling, to see that lock cross the
 * staleness threshold and reclaim it, rather than timing out first. */
export const DEFAULT_LOCK_TIMEOUT_MS = 40_000;
/** Default age, in milliseconds, past which a held lock directory is
 * treated as abandoned and reclaimed. See {@link DEFAULT_LOCK_TIMEOUT_MS}
 * for why this must stay smaller than the timeout. */
export const DEFAULT_LOCK_STALE_MS = 30_000;
/** Default delay, in milliseconds, between acquire retries. */
export const DEFAULT_LOCK_POLL_MS = 20;

/** Options accepted by {@link withOperatorManifestLock}, exposed only so
 * tests can shrink the timeout/staleness/poll windows below their
 * production defaults; callers outside test code should omit this
 * entirely. */
export interface OperatorManifestLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

/** Thrown by {@link withOperatorManifestLock} when the lock could not be
 * acquired within `timeoutMs`. Callers distinguish this from any error
 * `fn` itself might throw so they can print lock-specific operator
 * guidance instead of a generic failure. */
export class OperatorManifestLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for the operator manifest lock at ${lockPath}`);
    this.name = "OperatorManifestLockTimeoutError";
  }
}

function isEexist(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** Synchronous sleep via `Atomics.wait` on a throwaway `SharedArrayBuffer`,
 * used instead of a busy loop so a waiter parks rather than spinning the
 * CPU while it holds no work to do. `withOperatorManifestLock`'s callers
 * are synchronous CLI code paths (a single `fn()` call wrapping a
 * read-modify-write), so a synchronous sleep is what keeps the lock
 * acquisition loop itself synchronous end to end; an async/Promise-based
 * sleep would force every caller of this function to become async too. */
function sleepSync(ms: number): void {
  const sharedBuffer = new SharedArrayBuffer(4);
  const view = new Int32Array(sharedBuffer);
  Atomics.wait(view, 0, 0, ms);
}

/** Age, in milliseconds, of the directory at `path` (via its mtime), or
 * `undefined` if it cannot be stat'd (already gone, races with another
 * process's own reclaim/release). */
function lockAgeMs(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A fresh, unguessable per-acquisition identifier, written into the lock
 * directory's owner file right after it is created and compared back on
 * release, so a call only ever removes a lock directory it still actually
 * owns (see {@link withOperatorManifestLock}'s release step). */
function randomLockToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Decides, from a lock directory's age measured *after* it was renamed
 * aside during a reclaim attempt, whether that renamed copy should be
 * destroyed (a genuinely abandoned lock) or handed back to its real owner
 * (a lock that turned out fresh once re-checked; see
 * {@link withOperatorManifestLock}'s reclaim comment for why this second
 * check exists at all). `postAgeMs` is `undefined` when the renamed copy
 * could no longer be stat'd by the time this runs (already gone, e.g. a
 * third acquisition raced in and took it over): that is treated as
 * hand-back-safe, not stale-and-destroy, since a lock this call cannot
 * age must not be destroyed on its behalf — the same "when in doubt,
 * don't tear down what might still be someone else's critical section"
 * stance {@link withOperatorManifestLock}'s doc comment describes for its
 * own `finally` release guard. A pure function so both branches, and the
 * `undefined` case, are unit-testable without spawning a lock directory.
 */
export function shouldDestroyReclaimedLock(
  postAgeMs: number | undefined,
  staleMs: number,
): boolean {
  return postAgeMs !== undefined && postAgeMs > staleMs;
}

/**
 * Runs `fn` while holding an advisory, same-machine lock on the operator
 * manifest at `<home>/manifest.json`, so a read-modify-write sequence
 * (read the manifest, compute an updated copy, write it back) that this
 * function wraps end to end cannot interleave with another process's own
 * read-modify-write against the same `home`. {@link updateOperatorManifest}
 * is the only call site that should ever use this directly; it is what
 * makes the locked read-modify-write the sole write path to the manifest.
 *
 * Mechanics: `mkdirSync(<home>/.manifest.lock)` is used as the mutex,
 * since directory creation is atomic on every filesystem Node targets
 * (POSIX `mkdir(2)`, Windows `CreateDirectory`): a second, concurrent
 * `mkdirSync` call for the same path fails with `EEXIST` rather than
 * silently succeeding, exactly the primitive a mutual-exclusion lock
 * needs. Right after `mkdirSync` succeeds, a fresh random token is written
 * to `<lockPath>/owner`: this is the lock's owner identity, and it is what
 * makes both the stale-lock reclaim below and the release in `finally`
 * safe under contention (see each for why).
 *
 * A caller that finds the lock held retries with a short synchronous sleep
 * (`sleepSync`, `Atomics.wait` on a throwaway `SharedArrayBuffer`, not a
 * CPU-spinning busy loop) until either it acquires the lock or `timeoutMs`
 * (default {@link DEFAULT_LOCK_TIMEOUT_MS}) elapses, in which case it
 * throws {@link OperatorManifestLockTimeoutError} without ever calling
 * `fn`. On every failed attempt (not just the first), a lock directory
 * older than `staleMs` (default {@link DEFAULT_LOCK_STALE_MS}, checked via
 * its mtime) is treated as abandoned, most likely left behind by a process
 * that crashed or was killed between acquiring and releasing it, and
 * reclaim is attempted: `renameSync(lockPath, <lockPath>.<token>.stale)`
 * moves it out of the way, then the renamed copy is removed. `renameSync`
 * on a POSIX filesystem is atomic, so of any two waiters racing to reclaim
 * the same stale-looking directory, at most one rename can ever succeed;
 * the loser's `renameSync` throws (the source is already gone) and it
 * falls through to the normal retry/timeout handling instead of also
 * entering the critical section. Re-checking staleness on every attempt
 * (rather than once per call) is safe precisely because of that atomicity:
 * repeating the check cannot itself cause two callers to both believe they
 * reclaimed the same lock, it only means a caller that starts partway
 * through another's abandoned-lock window still gets a chance to reclaim
 * it once that window is crossed, instead of being stuck waiting out the
 * full timeout.
 *
 * The staleness check and the rename are still two separate syscalls, not
 * one atomic operation, so a second process could complete an entire fresh
 * acquisition of its own in the gap between them; the winning `renameSync`
 * would then have relocated that fresh, actively-held lock rather than the
 * abandoned one the check inspected. This is closed by re-checking age a
 * second time on the renamed copy, which only the caller that just renamed
 * it can observe (so this second read is itself race-free): a lock that
 * was genuinely fresh still reads as fresh there, and is handed back
 * (renamed to `lockPath` again) rather than destroyed, so its real owner
 * is undisturbed (short of the exceedingly narrow case where a third
 * acquisition lands in that same brief hand-back gap, at which point there
 * is nothing left to hand it back to; that owner's own eventual release
 * still no-ops safely, see `finally` below).
 *
 * This lock is advisory (nothing stops a caller from touching the
 * manifest file without going through it, exactly like a POSIX file
 * lock) and same-machine only (a directory on a network filesystem
 * shared across hosts is not a safe mutex primitive here); it protects
 * cooperating `orchestrator-workflow` processes on one machine against
 * each other, not against an uncooperative writer or a multi-host setup.
 * `home` is created first (`mkdirSync(home, { recursive: true })`) since
 * the lock directory lives inside it and a first-ever `apply`/`setup`
 * against a brand-new operator home would otherwise have nowhere to put
 * it. The lock is released in `finally`, including when `fn` throws, but
 * only if the owner file inside it still holds this call's own token: if
 * another process's stale-lock reclaim has since taken the directory over
 * (the true holder ran long enough past `staleMs` for a waiter to evict
 * it), this call's own token no longer matches what is in the owner file,
 * and removing the directory here would tear down a lock that is no
 * longer this call's to release, leaving the new owner's critical section
 * unprotected mid-flight. Skipping the removal in that case is the
 * correct, if imperfect, response: the directory is left for its actual
 * current owner to release normally.
 */
export function withOperatorManifestLock<T>(
  home: string,
  fn: () => T,
  options: OperatorManifestLockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;

  mkdirSync(home, { recursive: true });
  const lockPath = join(home, OPERATOR_MANIFEST_LOCK_DIRNAME);
  const ownerPath = join(lockPath, OPERATOR_MANIFEST_LOCK_OWNER_FILENAME);
  const deadline = Date.now() + timeoutMs;
  let ownToken: string | undefined;

  for (;;) {
    try {
      mkdirSync(lockPath);
      ownToken = randomLockToken();
      writeFileSync(ownerPath, ownToken, "utf8");
      break;
    } catch (error) {
      if (!isEexist(error)) throw error;

      const age = lockAgeMs(lockPath);
      if (age !== undefined && age > staleMs) {
        const staleRenamePath = `${lockPath}.${randomLockToken()}.stale`;
        let renamedAway = false;
        try {
          renameSync(lockPath, staleRenamePath);
          renamedAway = true;
        } catch {
          // Lost the reclaim race (another process renamed or re-created
          // it first); fall through to the normal retry/timeout handling
          // below rather than ever treating this as an acquisition.
        }
        if (renamedAway) {
          // The age check above and this rename are two separate syscalls,
          // not one atomic operation: another process could complete an
          // entire fresh acquisition (mkdir + owner-file write) of its own
          // in the gap between them, in which case this rename would have
          // just relocated that fresh, actively-held lock rather than the
          // abandoned one the check above inspected. Re-checking age on
          // the renamed copy closes that gap: only this call can now
          // observe `staleRenamePath`, so this second read is race-free,
          // and a live lock's mtime (set moments ago by its real owner)
          // still reads as fresh here even though the rename already
          // moved it.
          const postAge = lockAgeMs(staleRenamePath);
          if (shouldDestroyReclaimedLock(postAge, staleMs)) {
            rmSync(staleRenamePath, { recursive: true, force: true });
            continue;
          }
          // Turned out fresh: hand it back rather than destroying a lock
          // its real owner still believes it holds. If `lockPath` was
          // re-created by yet another process in the brief window since
          // the rename above (rare: it requires a second, unrelated
          // acquisition landing in this same narrow gap), there is
          // nothing sane left to give it back to; the discarded copy's
          // real owner still finishes `fn()` unaffected; its own release
          // no-ops safely once it finds its owner file gone (see the
          // `finally` below).
          try {
            renameSync(staleRenamePath, lockPath);
          } catch {
            rmSync(staleRenamePath, { recursive: true, force: true });
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new OperatorManifestLockTimeoutError(lockPath);
      }
      sleepSync(pollMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      const currentOwner = readFileSync(ownerPath, "utf8");
      if (currentOwner === ownToken) {
        rmSync(lockPath, { recursive: true, force: true });
      }
      // Otherwise another process's stale-lock reclaim has already taken
      // over this lock directory since this call acquired it; it is no
      // longer this call's to remove (see the doc comment above).
    } catch {
      // Already gone, e.g. reclaimed by another process's stale-lock
      // recovery after this call overran `staleMs` before reaching here;
      // nothing left for this call to release.
    }
  }
}

/** The three states an operator-manifest read can land in: no file at
 * `<home>/manifest.json` at all (`absent`, the fresh-operator case); a file
 * that exists but `readOperatorManifest` could not turn into a manifest
 * (`unreadable`, e.g. corrupt JSON, an unrecognized envelope, or a read
 * failure such as a permissions error); or a file that parsed and
 * validated (`ok`, with `manifest` set). Kept distinct from plain
 * `readOperatorManifest`'s `OperatorManifest | undefined` so a caller (this
 * module's own callers today, `apply`'s CLI action; `doctor`, once it
 * exists, tomorrow) can tell "nothing set up yet" apart from "something is
 * there and broken", since the two call for different operator advice: the
 * former says run `setup`, the latter says back up and repair (or remove)
 * the file first, since blindly running `setup` again would silently wipe
 * whatever registry data survives in the damaged file.
 */
export type OperatorManifestState =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "ok"; manifest: OperatorManifest };

export function operatorManifestState(home: string): OperatorManifestState {
  const path = join(home, OPERATOR_MANIFEST_FILENAME);
  if (!existsSync(path)) return { kind: "absent" };
  const manifest = readOperatorManifest(home);
  return manifest ? { kind: "ok", manifest } : { kind: "unreadable" };
}

/**
 * The single locked read-modify-write entry point for the operator
 * manifest: every write to `<home>/manifest.json` (`setup`, `apply`,
 * `doctor --prune`, and `adopt`'s own registration step in cli.ts, all four
 * today) goes through this function rather than ever calling the lock or
 * the raw writer directly, so no command can bypass the lock and race
 * another's read-modify-write.
 *
 * The whole re-read, `mutate`, and write run inside one
 * `withOperatorManifestLock` critical section: `mutate` is handed the
 * manifest re-read *inside the lock* (`current`, `undefined` when
 * `state.kind` is not `"ok"`) rather than whatever the caller may have read
 * before calling this, since that earlier read can already be stale by the
 * time the lock is granted (another locked writer's own read-modify-write
 * could have landed in between). `state` is the full {@link
 * OperatorManifestState} the re-read produced, handed to `mutate` alongside
 * `current` so it can distinguish "no manifest yet" from "manifest present
 * but unreadable" when that distinction changes what it should do.
 *
 * `mutate` returning `undefined` means "do not write anything": the
 * manifest is left exactly as re-read, and the returned `written` is
 * `false`. Returning an `OperatorManifest` writes it (via the internal,
 * unlocked writer, safe here since the write happens inside the lock) and
 * `written` is `true`; the written manifest is also returned as
 * `manifest` for a caller that wants it without a further read. A write
 * that refreshes an already-existing manifest (`current` truthy) is also
 * stamped with a fresh `updatedAt` here, unless `mutate`'s own returned
 * value already carries a distinct one of its own, in which case that
 * value is written verbatim (see the write itself, below, for the exact
 * condition).
 */
export function updateOperatorManifest(
  home: string,
  mutate: (
    current: OperatorManifest | undefined,
    state: OperatorManifestState,
  ) => OperatorManifest | undefined,
  options: OperatorManifestLockOptions = {},
): {
  state: OperatorManifestState;
  written: boolean;
  manifest?: OperatorManifest;
} {
  return withOperatorManifestLock(
    home,
    () => {
      const state = operatorManifestState(home);
      const current = state.kind === "ok" ? state.manifest : undefined;
      const next = mutate(current, state);
      if (next === undefined) {
        return { state, written: false };
      }
      // A write that refreshes an already-existing manifest (`current`
      // truthy) gets a fresh `updatedAt` here whenever the `mutate`
      // callback that produced `next` did not already set one of its own
      // (`next.updatedAt` still reads as `current.updatedAt`): `setup`'s
      // defaults refresh, `apply`'s and `adopt`'s target
      // registration/refresh all write through this one path via a
      // `mutate` built on `upsertOperatorTarget`/a plain object spread,
      // neither of which ever touches `updatedAt` itself, so before this
      // fix only `setup` (which set it manually) and `doctor --prune`
      // (same) actually bumped it; `apply`/`adopt` silently left a stale
      // `updatedAt` on every registration (fix-round, review finding
      // L10). A `mutate` that already computed its own distinct
      // `updatedAt` (`doctor --prune`'s own manual bump, or a test that
      // deliberately writes a fully custom manifest wholesale) is left
      // exactly as returned, so this does not stomp on an intentional
      // value. A brand-new manifest (`current` undefined, `next`
      // typically built by `createOperatorManifest`) is likewise left
      // untouched: it already carries a single, self-consistent
      // `createdAt`/`updatedAt` pair from its own construction, and
      // re-stamping only `updatedAt` here would needlessly split that
      // pair by a few milliseconds.
      const toWrite: OperatorManifest =
        current && next.updatedAt === current.updatedAt
          ? { ...next, updatedAt: new Date().toISOString() }
          : next;
      writeOperatorManifestUnlocked(home, toWrite);
      return { state, written: true, manifest: toWrite };
    },
    options,
  );
}

/**
 * The operator-facing message for `apply`'s locked registration step
 * finding the operator manifest not `"ok"` (unreadable or gone) once the
 * lock was granted. The two cases get distinct wording: an unreadable
 * manifest says the kit install itself already succeeded and only the
 * registry write failed (unlike the *pre-install* unreadable check, which
 * runs before any install work and so must not claim one happened), while
 * a manifest gone missing mid-lock keeps its own separately-worded advice.
 * A pure, exported function (rather than inlined at its one call site in
 * cli.ts) so the wording can be unit-tested without spawning the CLI.
 */
export function applyRegistrationFailureMessage(
  manifestKind: "unreadable" | "absent",
  manifestPath: string,
  targetDir: string,
): string {
  return manifestKind === "unreadable"
    ? `Operator manifest at ${manifestPath} is unreadable; the kit was installed into ${targetDir} but could not be registered. Back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again, then re-apply to register it.`
    : `Operator manifest at ${manifestPath} is gone; ${targetDir} was installed but could not be registered. Run \`orchestrator-workflow setup\` and re-apply to register it.`;
}

/**
 * Realpath that never throws: a recorded target whose directory has since
 * been removed or moved (the `missing` case a later doctor reports) must not
 * make an unrelated upsert fail, so the stored path is compared as written
 * when it can no longer be resolved. Exported so cli.ts resolves a target
 * path the same guarded way this module does internally, rather than
 * keeping its own duplicate copy of the same guard.
 */
export function safeRealpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Returns a new manifest with `targetPath` recorded as applied, plus
 * whether `targetPath` was already registered (an update) rather than
 * newly added, so a caller does not need its own separate, and
 * potentially inconsistent, check against the same targets array. Pure:
 * does not mutate `manifest` or its nested `targets` array/entries.
 * Targets are deduplicated by realpath (`safeRealpath`, guarded against a
 * target directory that no longer exists) rather than raw string
 * equality, so the same directory reached via a symlink or a differently
 * cased/relative path still updates the existing entry in place instead of
 * appending a duplicate; the update branch also rewrites the stored
 * `path` to the resolved realpath, so an entry once written as a raw,
 * non-realpath string (a hand-edited manifest, or one written before this
 * normalization existed) is normalized going forward instead of needing
 * `safeRealpath` on every future comparison against it.
 */
export function upsertOperatorTarget(
  manifest: OperatorManifest,
  targetPath: string,
  appliedVersion: string,
  appliedAt: string,
): { manifest: OperatorManifest; alreadyRegistered: boolean } {
  const resolvedPath = safeRealpath(targetPath);
  const existingIndex = manifest.targets.findIndex(
    (target) => safeRealpath(target.path) === resolvedPath,
  );
  const alreadyRegistered = existingIndex !== -1;

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
      path: resolvedPath,
      lastAppliedVersion: appliedVersion,
      lastAppliedAt: appliedAt,
    };
  }

  return {
    manifest: {
      ...manifest,
      defaults: {
        ...manifest.defaults,
        models: { ...manifest.defaults.models },
        ...(manifest.defaults.routing !== undefined
          ? { routing: manifest.defaults.routing }
          : {}),
      },
      targets,
    },
    alreadyRegistered,
  };
}
