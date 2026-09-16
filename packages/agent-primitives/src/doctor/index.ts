import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../envelope.js";
import { sha256File } from "../hash.js";
import { isPidAlive, lockKey, listMarkers, type MarkerEntry } from "../lock.js";
import {
  containmentRoot,
  isPathContained,
  resolveDeepestExisting,
} from "../probe/containment.js";
import {
  GIT_MIN_VERSION_WORKTREE_LIST_Z,
  GIT_MIN_VERSION_WORKTREE_SYNC,
  isScratchWorktreePath,
  isTimestampPastBound,
  liveForeignOwner,
  parseWorktreeListLines,
  parseWorktreeListZ,
  rejectsOption,
  SCRATCH_OWNER_MAX_AGE_HOURS,
  scratchOwnerPath,
} from "../probe/isolation.js";

export interface ToolCheck {
  name: string;
  required: boolean;
  found: boolean;
  path?: string;
  version?: string;
  /** Set when the `--version` capture itself timed out, distinct from a
   *  binary that ran but printed nothing. Or set to `skipped_deadline`
   *  when the aggregate version-capture deadline (see `DoctorOptions`)
   *  was already spent by earlier tools, so this one's capture never ran
   *  at all. */
  versionCheck?: "timed_out" | "skipped_deadline";
}

export interface DoctorCheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorResult {
  status: "ok" | "missing";
  tools: ToolCheck[];
  checks: DoctorCheckItem[];
  hints: string[];
  warnings: string[];
}

export interface DoctorOptions {
  required?: string[];
  optional?: string[];
  cwd?: string;
  /** Test seam: overrides process.env.PATH. */
  pathEnv?: string;
  /** Timeout (ms) for each `<bin> --version` capture, and for each
   * `python-bytecode-cache` cache-path resolution (the only other
   * per-item spawn doctor makes). */
  versionTimeoutMs?: number;
  /** Aggregate deadline (ms) across every spawn doctor makes combined
   * (the `--version` captures and the `python-bytecode-cache` check's
   * own per-target `python3` resolutions), measured from the start of
   * doctor's tool loop. Once spent, remaining tools skip their own
   * capture (`versionCheck: "skipped_deadline"`) and remaining targets
   * skip their own resolution (falling back to the co-located guess,
   * with the deadline named in that check's detail) instead of each
   * paying its own per-item timeout; findOnPath and the cache-path
   * `existsSync` (filesystem stats, not spawns) are never skipped by
   * this deadline. Defaults to 3000. */
  versionDeadlineMs?: number;
  /** Test seam: overrides the probe lock/marker directory (defaults to
   * `lock.ts`'s own `$AGENT_PRIMITIVES_LOCK_DIR` / tmpdir resolution). */
  lockDir?: string;
  /** Probe target file(s) to check for an existing CPython bytecode
   * cache (relative to `cwd` or absolute), the same `--file`/`-p`
   * targets an operator would hand `probe`. Only `.py` paths among
   * these produce the `python-bytecode-cache` check below; every other
   * extension is silently ignored (CPython's own cache never applies to
   * it). Each such target's cache path is the one `python3` itself
   * resolves (`importlib.util.cache_from_source`) when a `python3` is on
   * `PATH`, and a co-located `__pycache__` only as the fallback when
   * none is (or when that resolution did not come back), which the
   * check's own detail names. Omitted or empty: the check is skipped
   * entirely rather than reported as passing, since "no target named" is
   * not the same claim as "no cache found for the target". */
  targets?: string[];
}

export const DEFAULT_REQUIRED = ["git", "node", "npm", "rg"];
export const DEFAULT_OPTIONAL = [
  "ast-grep",
  "jq",
  "yq",
  "fd",
  "codebase-oracle",
];

/** Alternate binary names that satisfy a requested tool name. */
const ALIASES: Record<string, string[]> = {
  "ast-grep": ["ast-grep", "sg"],
};

const GENERIC_HINTS: Record<string, string> = {
  git: "install git: https://git-scm.com/downloads",
  node: "install Node.js >= 20: https://nodejs.org/",
  npm: "npm ships with Node.js: https://nodejs.org/",
  rg: "install ripgrep: https://github.com/BurntSushi/ripgrep#installation",
  "ast-grep":
    "install ast-grep (or its `sg` binary): https://ast-grep.github.io/guide/quick-start.html",
  jq: "install jq: https://jqlang.github.io/jq/download/",
  yq: "install yq: https://github.com/mikefarah/yq#install",
  fd: "install fd: https://github.com/sharkdp/fd#installation",
  "codebase-oracle": "install codebase-oracle per your org's setup docs",
};

function pathDirs(pathEnv: string): string[] {
  return pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
  names: string[],
  dirs: string[],
): { path: string; matchedName: string } | undefined {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) {
        return { path: candidate, matchedName: name };
      }
    }
  }
  return undefined;
}

/** Resolves `target`'s own CPython bytecode-cache path by asking
 * `python3` itself (`importlib.util.cache_from_source`), rather than
 * assuming a co-located `__pycache__`: a host whose `python3` redirects
 * `sys.pycache_prefix` elsewhere by default (macOS's own system
 * `python3`, or any host with `PYTHONPYCACHEPREFIX` already set) still
 * resolves to the SAME path that host's own unoverridden invocations
 * actually use. Returns `undefined` on any failure (a non-zero exit, no
 * stdout, or the spawn itself throwing/timing out) so the caller can
 * fall back to the co-located guess for that one target instead of
 * reporting "no cache" on a resolver failure.
 *
 * The answer is always absolute, and always about the directory the
 * caller named: the target is resolved against the REAL `cwd` before
 * `python3` is asked, and the reply is resolved against that same real
 * directory. `cache_from_source` is a pure string transform on the path
 * handed to it, and it has two shapes, each of which needs one half of
 * that:
 *
 * - With no cache prefix set (the ordinary case everywhere but a host
 *   like macOS's system `python3`, which redirects `sys.pycache_prefix`
 *   by default), a relative `pkg/mod.py` comes back as the equally
 *   relative `pkg/__pycache__/mod.cpython-3X.pyc`. Checked with
 *   `fs.existsSync`, that would be read against THIS process's own cwd
 *   rather than the `cwd` the caller named (`-C`, or a library caller's
 *   `cwd` option): a cache reported that is not the target's, or none
 *   reported where the target has one.
 * - With a prefix set, the answer is absolute either way, but the
 *   prefix is joined with the source's own directory, which for a
 *   relative source is `os.getcwd()` and therefore always the REAL
 *   path. Asking about an unresolved absolute spelling of a directory
 *   reached through a symlink (`/var -> /private/var` on macOS, the
 *   shape every `mkdtemp` path has there) answers a directory under the
 *   prefix that the interpreter's own imports never write to.
 *
 * `realpathSync` failing (a `cwd` that does not exist, which the CLI
 * rejects up front but a library caller could still pass) falls back to
 * the path as given: the resolution may then be wrong in the second
 * shape above, which is no worse than not resolving at all. */
function resolvePyCacheTarget(
  python3Path: string,
  cwd: string,
  target: string,
  timeoutMs: number,
): string | undefined {
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  let result;
  try {
    result = spawnSync(
      python3Path,
      [
        "-c",
        "import importlib.util, sys; print(importlib.util.cache_from_source(sys.argv[1]))",
        path.resolve(realCwd, target),
      ],
      { cwd: realCwd, timeout: timeoutMs, encoding: "utf8" },
    );
  } catch {
    return undefined;
  }
  if (result.status !== 0) return undefined;
  const resolved = result.stdout?.trim();
  return resolved ? path.resolve(realCwd, resolved) : undefined;
}

/** The co-located guess `python-bytecode-cache` falls back to when
 * `python3` is not on PATH, or failed to resolve one specific target: a
 * plain `__pycache__` directory next to the target, the same check this
 * package shipped before real resolution existed. */
function coLocatedPycacheDir(cwd: string, target: string): string {
  return path.join(path.dirname(path.resolve(cwd, target)), "__pycache__");
}

interface VersionCapture {
  version?: string;
  timedOut: boolean;
}

function captureVersion(binPath: string, timeoutMs: number): VersionCapture {
  let result;
  try {
    result = spawnSync(binPath, ["--version"], {
      timeout: timeoutMs,
      encoding: "utf8",
    });
  } catch {
    return { timedOut: false };
  }
  const timedOutError =
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  if (timedOutError || result.signal) {
    return { timedOut: true };
  }
  const out = (result.stdout || result.stderr || "").trim();
  if (!out) return { timedOut: false };
  return { version: out.split("\n")[0]?.trim(), timedOut: false };
}

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

/** The numeric version in a `git --version` line (`git version 2.36.1`,
 * `git version 2.50.1 (Apple Git-155)`), or undefined when the line
 * does not carry one. Exported for the tests. */
export function parseGitVersion(line: string): GitVersion | undefined {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(line.trim());
  if (m === null) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
}

/** True when `version` is older than the `major.minor` in `minimum`
 * (a patch level never decides). */
function isGitOlderThan(version: GitVersion, minimum: string): boolean {
  const [major, minor] = minimum.split(".").map(Number);
  return (
    version.major < major || (version.major === major && version.minor < minor)
  );
}

/** The `git-version` check: git's version against what `probe -i
 * worktree` relies on (see the two minimums in `isolation.ts`). `ok`
 * only for a version at or above `GIT_MIN_VERSION_WORKTREE_LIST_Z`;
 * every other state names what the probe does on this git. Exported for
 * the tests. */
export function gitVersionCheck(
  gitPath: string | undefined,
  versionLine: string | undefined,
): DoctorCheckItem {
  const needs = `probe -i worktree needs git ${GIT_MIN_VERSION_WORKTREE_SYNC} or newer`;
  if (gitPath === undefined) {
    return {
      name: "git-version",
      ok: false,
      detail: `git not found on PATH; ${needs}`,
    };
  }
  const version =
    versionLine === undefined ? undefined : parseGitVersion(versionLine);
  if (version === undefined) {
    return {
      name: "git-version",
      ok: false,
      detail:
        `could not determine the version of git at ${gitPath}` +
        (versionLine === undefined ? "" : ` from "${versionLine}"`) +
        `; ${needs}`,
    };
  }
  const v = `${version.major}.${version.minor}.${version.patch}`;
  if (isGitOlderThan(version, GIT_MIN_VERSION_WORKTREE_SYNC)) {
    return {
      name: "git-version",
      ok: false,
      detail:
        `git ${v} at ${gitPath} is older than ${GIT_MIN_VERSION_WORKTREE_SYNC}: ` +
        `probe -i worktree cannot sync the working tree on it (git apply ` +
        `--allow-empty is unavailable) and reports worktree_sync_failed; ` +
        `use -i inplace; below ${GIT_MIN_VERSION_WORKTREE_LIST_Z} the worktree ` +
        `listing also falls back to the newline-separated form`,
    };
  }
  if (isGitOlderThan(version, GIT_MIN_VERSION_WORKTREE_LIST_Z)) {
    return {
      name: "git-version",
      ok: false,
      detail:
        `git ${v} at ${gitPath} is older than ${GIT_MIN_VERSION_WORKTREE_LIST_Z}: ` +
        `git worktree list --porcelain -z is unavailable, so the worktree ` +
        `listing falls back to the newline-separated form, and a worktree ` +
        `path containing a newline is then reported as unparseable`,
    };
  }
  return {
    name: "git-version",
    ok: true,
    detail: `git ${v} at ${gitPath} meets the ${GIT_MIN_VERSION_WORKTREE_LIST_Z} minimum for probe -i worktree`,
  };
}

/** Names that must be a plain binary basename, never a path segment,
 * so a `-r`/`-o` entry can never escape PATH via `../` traversal. */
function assertPlainBinaryName(name: string, flag: string): void {
  if (name === "." || name === ".." || path.basename(name) !== name) {
    throw new UsageError(
      `${flag}: not a plain binary name (must not contain a path separator or be "." / ".."): "${name}"`,
    );
  }
}

function checkTool(
  name: string,
  required: boolean,
  dirs: string[],
  versionTimeoutMs: number,
  aggregateDeadline: number,
): { tool: ToolCheck; warning?: string; skippedDeadline: boolean } {
  const names = ALIASES[name] ?? [name];
  const hit = findOnPath(names, dirs);
  if (!hit) {
    return { tool: { name, required, found: false }, skippedDeadline: false };
  }
  if (Date.now() >= aggregateDeadline) {
    return {
      tool: {
        name,
        required,
        found: true,
        path: hit.path,
        versionCheck: "skipped_deadline",
      },
      skippedDeadline: true,
    };
  }
  const capture = captureVersion(hit.path, versionTimeoutMs);
  if (capture.timedOut) {
    return {
      tool: {
        name,
        required,
        found: true,
        path: hit.path,
        versionCheck: "timed_out",
      },
      warning: `version check timed out for ${name} (${hit.path})`,
      skippedDeadline: false,
    };
  }
  return {
    tool: {
      name,
      required,
      found: true,
      path: hit.path,
      // Set only when there is a version to report. A binary that runs but
      // prints nothing would otherwise ship `version: undefined` as an own
      // property, which JSON.stringify drops from the object but which any
      // per-property measurement over the result has to special-case.
      // Shipped results carry no undefined-valued own properties.
      ...(capture.version !== undefined ? { version: capture.version } : {}),
    },
    skippedDeadline: false,
  };
}

/**
 * Checks that a fixed list of required and optional binaries are on PATH
 * (walked directly from `process.env.PATH`, no shell involved), captures
 * each found binary's `--version`, and reports a handful of environment
 * checks useful when a probe or verify run behaves unexpectedly.
 */
export async function doctor(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const required = options.required ?? DEFAULT_REQUIRED;
  const optional = options.optional ?? DEFAULT_OPTIONAL;
  const cwd = options.cwd ?? process.cwd();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const versionTimeoutMs = options.versionTimeoutMs ?? 1000;
  const versionDeadlineMs = options.versionDeadlineMs ?? 3000;
  const aggregateDeadline = Date.now() + versionDeadlineMs;
  const dirs = pathDirs(pathEnv);

  // Reject any traversal-shaped name before anything is looked up or
  // executed: a name like "../../x" must never reach findOnPath/spawnSync.
  for (const name of required) assertPlainBinaryName(name, "-r/--required");
  for (const name of optional) assertPlainBinaryName(name, "-o/--optional");

  const warnings: string[] = [];
  const tools: ToolCheck[] = [];
  let skippedCount = 0;
  for (const name of required) {
    const { tool, warning, skippedDeadline } = checkTool(
      name,
      true,
      dirs,
      versionTimeoutMs,
      aggregateDeadline,
    );
    tools.push(tool);
    if (warning) warnings.push(warning);
    if (skippedDeadline) skippedCount++;
  }
  for (const name of optional) {
    const { tool, warning, skippedDeadline } = checkTool(
      name,
      false,
      dirs,
      versionTimeoutMs,
      aggregateDeadline,
    );
    tools.push(tool);
    if (warning) warnings.push(warning);
    if (skippedDeadline) skippedCount++;
  }
  if (skippedCount > 0) {
    warnings.push(
      `aggregate --version deadline (${versionDeadlineMs}ms) reached; ${skippedCount} tool(s) skipped their version capture`,
    );
  }

  const missingRequired = tools.filter((t) => t.required && !t.found);

  const checks: DoctorCheckItem[] = [];

  // git's own version, from the tool loop when git was among the tools
  // (the usual case) and from one capture of its own otherwise, so the
  // check below and the registry listing further down never depend on
  // which `-r`/`-o` lists the caller passed.
  const gitTool = tools.find((t) => t.name === "git");
  let gitPath = gitTool?.path;
  let gitVersionLine = gitTool?.version;
  if (gitTool === undefined) {
    const hit = findOnPath(["git"], dirs);
    if (hit !== undefined) {
      gitPath = hit.path;
      gitVersionLine = captureVersion(hit.path, versionTimeoutMs).version;
    }
  }
  const gitVersion = gitVersionCheck(gitPath, gitVersionLine);
  checks.push(gitVersion);
  if (!gitVersion.ok && gitPath !== undefined) {
    warnings.push(gitVersion.detail ?? "git is older than the minimum");
  }

  const nodeModulesPresent = fs.existsSync(path.join(cwd, "node_modules"));
  checks.push({
    name: "node_modules",
    ok: nodeModulesPresent,
    detail: nodeModulesPresent
      ? `node_modules present in ${cwd}`
      : `no node_modules in ${cwd}; commands that need installed dependencies will fail`,
  });

  const insideGitWorkTree = isInsideGitWorkTree(cwd);
  checks.push({
    name: "git-work-tree",
    ok: insideGitWorkTree,
    detail: insideGitWorkTree
      ? `${cwd} is inside a git work tree`
      : `${cwd} is not inside a git work tree`,
  });

  const bashMaxOutput = process.env.BASH_MAX_OUTPUT_LENGTH;
  checks.push({
    name: "BASH_MAX_OUTPUT_LENGTH",
    ok: true,
    detail: bashMaxOutput
      ? `BASH_MAX_OUTPUT_LENGTH=${bashMaxOutput}`
      : "BASH_MAX_OUTPUT_LENGTH is not set",
  });

  const srcDir = path.join(cwd, "src");
  const distDir = path.join(cwd, "dist");
  const hasSrc = fs.existsSync(srcDir);
  const hasDist = fs.existsSync(distDir);
  checks.push({
    name: "dist-next-to-src",
    ok: !hasSrc || hasDist,
    detail:
      hasSrc && !hasDist
        ? `${srcDir} exists but ${distDir} does not; a probe on this repo may need --pre to rebuild before testing`
        : hasSrc
          ? `${distDir} exists next to ${srcDir}`
          : "no src/ directory in cwd",
  });

  // Both sides go through `resolveDeepestExisting` before the comparison,
  // the same way `probe` resolves its own containment check: a marker
  // records the target under one spelling of the path and `doctor` may be
  // invoked under another (a symlinked ancestor, e.g. macOS's `/tmp` ->
  // `/private/tmp`), and comparing the two unresolved reports "no stale
  // markers" while one is sitting right there.
  const markerRoot = resolveDeepestExisting(containmentRoot(cwd));
  const staleMarkers = listMarkers(options.lockDir).filter(
    (m) =>
      !isPidAlive(m.pid) &&
      isPathContained(
        markerRoot,
        resolveDeepestExisting(path.resolve(m.targetPath)),
      ),
  );
  // Which of these the next `probe` would really recover is decided by
  // `isAutoRecoverable`, which applies probe's own two proofs rather
  // than the cheaper "the backup file is still there": a backup that
  // exists but no longer matches, or a target that has moved on from the
  // state the marker describes, is refused by probe, and a hint
  // promising a recovery that will just fail is worse than no hint.
  const recoverable: MarkerEntry[] = [];
  const unrecoverable: MarkerEntry[] = [];
  for (const marker of staleMarkers) {
    if (await isAutoRecoverable(marker)) recoverable.push(marker);
    else unrecoverable.push(marker);
  }
  const detailParts: string[] = [];
  if (recoverable.length > 0) {
    detailParts.push(
      `${recoverable.length} stale probe marker(s) for this repository whose ` +
        `backup still exists; run \`agent-primitives probe\` again on the ` +
        `affected file to auto-recover, or inspect the backup(s): ` +
        recoverable.map((m) => m.backupPath).join(", "),
    );
  }
  if (unrecoverable.length > 0) {
    detailParts.push(
      `${unrecoverable.length} stale probe marker(s) for this repository ` +
        `that the next probe would refuse to recover (the backup is ` +
        `missing, or it no longer hashes to the pre-mutation content the ` +
        `marker records, or the target is no longer in the mutated state ` +
        `the marker describes); auto-recovery is not possible; inspect ` +
        `the marker file(s), then delete them to clear the report: ` +
        unrecoverable.map((m) => m.markerPath).join(", "),
    );
  }
  checks.push({
    name: "stale-probe-marker",
    ok: staleMarkers.length === 0,
    detail:
      staleMarkers.length === 0
        ? "no stale probe markers for this repository"
        : detailParts.join(" "),
  });

  // `worktree` probes key their in-flight marker on the repository root
  // (not on `--file`) and record the worktree's own path in it, so a
  // leftover from a SIGKILL/crash is found by looking for exactly the
  // marker file that key would produce, rather than by scanning every
  // marker's `targetPath` (a worktree directory, not a repo-contained
  // file, so `isPathContained` above would never match it). The marker
  // is not the only trail: git itself registers the worktree (locked,
  // for the duration of the checkout) before `git worktree add`
  // returns, so every registered worktree of the probe's own scratch
  // shape is a leftover too unless a live probe owns it, marker or not
  // (a marker deleted by hand, or a run that died before writing one).
  // The registry is read BEFORE the markers: a probe starting in
  // between writes its marker before its add registers anything, so a
  // live run is never reported as a leftover. A live run under another
  // lock directory has no marker here at all; its scratch directory's
  // owner record (see `liveForeignOwner`) is what keeps it out of the
  // leftovers, for as long as the record is within its bound: past
  // it the worktree is a leftover whatever the pid says, reported with
  // the command like any other. A registry that cannot be read is said
  // so in a warning, never treated as empty.
  const registry = insideGitWorkTree
    ? listScratchWorktreesSync(markerRoot, gitPath)
    : { ok: true, paths: [] as string[] };
  if (!registry.ok) {
    warnings.push(
      `git worktree list could not run for ${markerRoot} ` +
        `(${registry.detail ?? "unknown"}); a worktree a previous probe ` +
        `left registered cannot be reported (this synchronous listing has ` +
        `no gitdir-files fallback the way \`probe\`'s own async listing ` +
        `does; the next \`probe -i worktree\` run on this repository can ` +
        `still recover a leftover this way)`,
    );
  }
  const registeredScratch = registry.paths;
  const worktreeMarkerFileName = `${lockKey(markerRoot)}.marker.json`;
  const worktreeMarker = listMarkers(options.lockDir).find(
    (m) => path.basename(m.markerPath) === worktreeMarkerFileName,
  );
  // A marker's pid alone is not enough: pids recycle, and a worktree
  // marker's own `timestamp` field (written when the marker is created,
  // never the marker file's mtime) is what the SAME `isTimestampPastBound`
  // the scratch owner record uses below bounds it against, so a marker
  // whose pid happens to still resolve to *something* long after its
  // own probe ended cannot hide a leftover behind it forever.
  const markerAlive =
    worktreeMarker !== undefined &&
    isPidAlive(worktreeMarker.pid) &&
    !isTimestampPastBound(worktreeMarker.timestamp, Date.now());
  const markerTarget =
    worktreeMarker !== undefined &&
    typeof worktreeMarker.targetPath === "string"
      ? resolveDeepestExisting(path.resolve(worktreeMarker.targetPath))
      : undefined;
  const manualRemove = (worktreePath: string): string =>
    `git -C ${markerRoot} worktree remove --force --force -- ${worktreePath}`;
  const worktreeProblems: string[] = [];
  // A worktree a live probe owns is never a problem for this check; each
  // becomes a hint below, since a worktree parked behind an alive pid is
  // still worth a line naming what holds it and for how long.
  const liveOwned: { path: string; pid: number; fromMarker: boolean }[] = [];
  if (worktreeMarker !== undefined && !markerAlive) {
    const markerOwner =
      markerTarget !== undefined ? liveForeignOwner(markerTarget) : undefined;
    if (markerOwner !== undefined) {
      liveOwned.push({
        path: markerTarget ?? String(worktreeMarker.targetPath),
        pid: markerOwner,
        fromMarker: true,
      });
    } else if (
      markerTarget !== undefined &&
      isScratchWorktreePath(markerTarget)
    ) {
      worktreeProblems.push(
        `a worktree probe on ${markerRoot} was interrupted; leftover worktree at ` +
          `${worktreeMarker.targetPath}; the next \`probe -i worktree\` on this ` +
          `repository recovers it automatically, or run \`${manualRemove(
            worktreeMarker.targetPath,
          )}\` manually`,
      );
    } else {
      // Never a removal command for this one: the path is not of the
      // shape the probe creates, so it is not the probe's to remove,
      // by hand or otherwise.
      worktreeProblems.push(
        `the stale worktree marker for ${markerRoot} names ` +
          `${String(worktreeMarker.targetPath)}, which is not a worktree of the ` +
          `probe's own scratch shape and is never removed automatically; ` +
          `inspect it, then delete the marker file to clear it: ` +
          `${worktreeMarker.markerPath}`,
      );
    }
  }
  for (const registeredPath of registeredScratch) {
    if (registeredPath === markerTarget && !markerAlive) {
      // Named by a marker whose probe is gone: reported above, or a hint.
      // A marker whose pid is alive proves nothing about this path (the
      // pid may have been recycled), so the path is judged below like
      // any other registered scratch worktree, by its own owner record.
      continue;
    }
    const owner = liveForeignOwner(registeredPath);
    if (owner !== undefined) {
      liveOwned.push({ path: registeredPath, pid: owner, fromMarker: false });
      continue;
    }
    worktreeProblems.push(
      `a registered worktree of the probe's own scratch shape at ` +
        `${registeredPath} has no live probe behind it; the next \`probe -i ` +
        `worktree\` on this repository removes it, or run ` +
        `\`${manualRemove(registeredPath)}\` manually`,
    );
  }
  checks.push({
    name: "stale-worktree",
    ok: worktreeProblems.length === 0,
    detail:
      worktreeProblems.length === 0
        ? "no stale worktree marker or leftover registered worktree for this repository"
        : worktreeProblems.join(" "),
  });

  // CPython validates a `__pycache__/*.pyc` by `(mtime, size)` alone, so
  // a same-length mutant probe applies can leave that pair unchanged and
  // reuse stale bytecode (see `pycache.ts`); `probe` itself now isolates
  // every `--pre`/test-command run of a Python target under a fresh
  // `PYTHONPYCACHEPREFIX` automatically (the README's "Python bytecode
  // cache" section), so this check is purely informational (the
  // RESOLUTION, not a hazard the operator must act on) and always
  // reports `ok: true`: it names whatever cache already exists for a
  // given target so its presence is visible before a probe run rather
  // than only inferable after one, and so an operator running the
  // target's OWN test command directly (outside `probe`) knows that
  // cache still applies to THAT run.
  const pyTargets = (options.targets ?? []).filter((t) =>
    t.toLowerCase().endsWith(".py"),
  );
  if (pyTargets.length > 0) {
    // Looked up here directly (not through the `-o/-r` tool loop above,
    // which only checks names an operator explicitly asked for): this
    // check needs to know whether a real CPython is on PATH regardless
    // of whatever tools the caller named. When it is, every target's
    // cache path is resolved the way CPython's own import machinery
    // would (`importlib.util.cache_from_source`), since a host whose
    // `python3` redirects `sys.pycache_prefix` elsewhere (macOS's own
    // system `python3`, by default) makes a co-located `__pycache__`
    // guess wrong in both directions: a false negative (the real,
    // redirected cache the guess never looks at) and a false positive
    // (an unrelated leftover `__pycache__` nothing currently reads).
    // Absent, or when resolution itself fails for one target, this
    // falls back to that co-located guess.
    //
    // Each resolution is a `python3` spawn, so it is bound the same two
    // ways every `--version` capture above is: its own
    // `versionTimeoutMs`, and the run's ONE aggregate deadline. A
    // caller's `--target` list is unbounded in length, so without the
    // aggregate bound a long list would multiply the per-target timeout
    // into a doctor run far past the budget the deadline exists to keep
    // (the `--version` captures' own reason for having it). A target
    // reached after the deadline is spent falls back to the co-located
    // guess -- a filesystem stat, never a spawn -- and the detail names
    // the bound that put it there, so the fallback is never silent.
    const python3 = findOnPath(["python3"], dirs);
    const hits: string[] = [];
    /** Targets checked by the co-located guess because `python3` was
     * asked and did not come back with a path. */
    const unresolved: string[] = [];
    /** Targets checked by the co-located guess because the aggregate
     * deadline was already spent when their turn came, so `python3` was
     * never asked at all. */
    const deadlineSkipped: string[] = [];
    for (const target of pyTargets) {
      let resolved: string | undefined;
      if (python3 !== undefined) {
        if (Date.now() >= aggregateDeadline) {
          deadlineSkipped.push(target);
        } else {
          resolved = resolvePyCacheTarget(
            python3.path,
            cwd,
            target,
            versionTimeoutMs,
          );
          if (resolved === undefined) unresolved.push(target);
        }
      }
      if (resolved !== undefined) {
        if (fs.existsSync(resolved)) hits.push(`${target} (${resolved})`);
        continue;
      }
      const coLocated = coLocatedPycacheDir(cwd, target);
      if (fs.existsSync(coLocated)) hits.push(`${target} (${coLocated})`);
    }
    // Named regardless of whether a cache was found: an operator reading
    // "no cache" (or a found path) should also know whether that came
    // from python3's own real resolution or from the co-located guess,
    // since the guess can be wrong in either direction on a host whose
    // python3 redirects its cache elsewhere (see the comment above).
    // Every target that fell back is named in exactly one clause, with
    // the reason it fell back.
    const fallbackNotes: string[] = [];
    if (python3 === undefined) {
      fallbackNotes.push(
        "python3 not found on PATH; checked only for a co-located __pycache__",
      );
    } else if (unresolved.length > 0) {
      fallbackNotes.push(
        `python3 did not resolve a cache path for ${unresolved.join(", ")}; ` +
          `checked only for a co-located __pycache__ there`,
      );
    }
    if (deadlineSkipped.length > 0) {
      fallbackNotes.push(
        `doctor's aggregate spawn deadline (${versionDeadlineMs}ms) was ` +
          `already spent, so the python3 cache-path resolution was skipped ` +
          `for ${deadlineSkipped.join(", ")}; checked only for a co-located ` +
          `__pycache__ there`,
      );
    }
    const fallbackNote =
      fallbackNotes.length > 0 ? ` (${fallbackNotes.join("; ")})` : "";
    checks.push({
      name: "python-bytecode-cache",
      ok: true,
      detail:
        (hits.length === 0
          ? `no Python bytecode cache found for the given target(s): ${pyTargets.join(", ")}`
          : `Python bytecode cache present for ${hits.join(", ")}; ` +
            `\`agent-primitives probe\` isolates every --pre/test-command ` +
            `run of a Python target under a fresh PYTHONPYCACHEPREFIX ` +
            `automatically, so this existing cache is never read or ` +
            `written by probe itself; it still applies to any OTHER ` +
            `command run against these files outside of probe`) + fallbackNote,
    });
  }

  const hints: string[] = [];
  for (const tool of missingRequired) {
    const hint = GENERIC_HINTS[tool.name];
    if (hint) hints.push(hint);
  }
  for (const live of liveOwned) {
    hints.push(
      `a live probe (pid ${String(live.pid)}) owns the scratch worktree at ` +
        `${live.path}${live.fromMarker ? ", named by this repository's worktree marker" : ""}; ` +
        `it is left alone while that process is alive and its owner record ` +
        `${scratchOwnerPath(live.path)} is within ${String(SCRATCH_OWNER_MAX_AGE_HOURS)} ` +
        `hours of the clock; past that bound the next \`probe -i worktree\` on ` +
        `this repository removes it and this check reports it as a leftover`,
    );
  }

  return {
    status: missingRequired.length === 0 ? "ok" : "missing",
    tools,
    checks,
    hints,
    warnings,
  };
}

/**
 * Whether the next `probe` on this marker's target would really recover
 * it, decided by the same proofs `probe` requires before it copies
 * anything: the target is still in the exact mutated state the marker
 * records, and the recorded backup still hashes to the pre-mutation
 * content the marker records. A target already back at that pre-mutation
 * hash counts as recoverable too: probe clears such a marker and carries
 * on. Everything else is a marker only a human can clear.
 *
 * Kept in step with `probe`'s stale-marker branch by hand; the doctor
 * test asserting a mismatched backup is reported as unrecoverable is
 * what holds the two together.
 */
async function isAutoRecoverable(marker: MarkerEntry): Promise<boolean> {
  const targetHash = await sha256File(marker.targetPath).catch(() => undefined);
  if (targetHash === undefined) return false;
  if (targetHash === marker.preHash) return true;
  if (targetHash !== marker.mutatedHash) return false;
  const backupHash = await sha256File(marker.backupPath).catch(() => undefined);
  return backupHash === marker.preHash;
}

interface ScratchWorktreeRegistry {
  /** True when a listing ran and parsed; `paths` says nothing
   * otherwise, and `detail` says why. */
  ok: boolean;
  paths: string[];
  detail?: string;
}

/** One `git worktree list --porcelain` run at `root` through `gitPath`,
 * with or without `-z`. */
function runWorktreeList(
  gitPath: string,
  root: string,
  nul: boolean,
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const args = ["-C", root, "worktree", "list", "--porcelain"];
  if (nul) args.push("-z");
  try {
    const result = spawnSync(gitPath, args, {
      timeout: 5000,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error !== undefined ? { error: result.error.message } : {}),
    };
  } catch (err) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Every registered worktree of the repository at `root` that is of the
 * probe's own scratch shape, never the main worktree and never `root`
 * itself, each through `resolveDeepestExisting`. The same two listing
 * forms `listRegisteredWorktrees` in `isolation.ts` runs, through a
 * synchronous spawn: `--porcelain -z` first, the newline-separated
 * `--porcelain` when git rejects `-z`, decided by the same
 * `rejectsOption` the probe's listing uses (the one copy of that
 * predicate). Not ok when neither form ran to a parse: this is a
 * report, and a listing that could not run is something to warn about,
 * never an empty registry.
 *
 * Deliberately WITHOUT the `gitdir-files` third source
 * `listRegisteredWorktrees` falls back to when both of those forms
 * fail: that source needs `git rev-parse --git-common-dir` (already
 * synchronous here through `runWorktreeList`-style spawns, so sharing
 * it would be straightforward) plus a synchronous directory read,
 * neither of which this function has been extended to do, so a `doctor`
 * run under a fully broken `git worktree list` still reports the
 * registry as unknown rather than recovering it the way `probe -i
 * worktree`'s own async listing now can (see the warning above, which
 * names this gap and points at `probe` as the path that still finds a
 * leftover this way). */
function listScratchWorktreesSync(
  root: string,
  gitPath: string | undefined,
): ScratchWorktreeRegistry {
  if (gitPath === undefined) {
    return { ok: false, paths: [], detail: "git not found on PATH" };
  }
  const nul = runWorktreeList(gitPath, root, true);
  let paths: string[];
  if (nul.error === undefined && nul.status === 0) {
    paths = parseWorktreeListZ(nul.stdout);
  } else if (
    nul.error === undefined &&
    rejectsOption({ exitCode: nul.status, stderr: nul.stderr })
  ) {
    const newline = runWorktreeList(gitPath, root, false);
    if (newline.error !== undefined || newline.status !== 0) {
      return {
        ok: false,
        paths: [],
        detail: `git rejected -z and git worktree list --porcelain ${
          newline.error !== undefined
            ? `did not run (${newline.error})`
            : `exited ${String(newline.status)}`
        }`,
      };
    }
    const parsed = parseWorktreeListLines(newline.stdout);
    if (!parsed.ok) {
      return {
        ok: false,
        paths: [],
        detail: `git rejected -z and the newline-separated listing could not be parsed (${parsed.detail})`,
      };
    }
    paths = parsed.paths;
  } else {
    return {
      ok: false,
      paths: [],
      detail:
        nul.error !== undefined
          ? `git worktree list --porcelain -z did not run (${nul.error})`
          : `git worktree list --porcelain -z exited ${String(nul.status)}`,
    };
  }
  const resolved = paths.map((p) => resolveDeepestExisting(path.resolve(p)));
  const main = resolved[0];
  return {
    ok: true,
    paths: resolved.filter(
      (p) => p !== main && p !== root && isScratchWorktreePath(p),
    ),
  };
}

function isInsideGitWorkTree(startDir: string): boolean {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    if (dir === root) return false;
    dir = path.dirname(dir);
  }
}
