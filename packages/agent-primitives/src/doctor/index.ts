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
  liveForeignOwner,
  parseWorktreeListLines,
  parseWorktreeListZ,
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
  /** Timeout (ms) for each `<bin> --version` capture. */
  versionTimeoutMs?: number;
  /** Aggregate deadline (ms), across ALL `--version` captures combined,
   * measured from the start of doctor's tool loop. Once spent, remaining
   * tools skip their own capture (`versionCheck: "skipped_deadline"`)
   * instead of each paying its own per-tool timeout; findOnPath itself
   * (a filesystem stat, not a spawn) is never skipped by this deadline.
   * Defaults to 3000. */
  versionDeadlineMs?: number;
  /** Test seam: overrides the probe lock/marker directory (defaults to
   * `lock.ts`'s own `$AGENT_PRIMITIVES_LOCK_DIR` / tmpdir resolution). */
  lockDir?: string;
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
  // leftovers. A registry that cannot be read is said so in a warning,
  // never treated as empty.
  const registry = insideGitWorkTree
    ? listScratchWorktreesSync(markerRoot, gitPath)
    : { ok: true, paths: [] as string[] };
  if (!registry.ok) {
    warnings.push(
      `git worktree list could not run for ${markerRoot} ` +
        `(${registry.detail ?? "unknown"}); a worktree a previous probe ` +
        `left registered cannot be reported`,
    );
  }
  const registeredScratch = registry.paths;
  const worktreeMarkerFileName = `${lockKey(markerRoot)}.marker.json`;
  const worktreeMarker = listMarkers(options.lockDir).find(
    (m) => path.basename(m.markerPath) === worktreeMarkerFileName,
  );
  const markerAlive =
    worktreeMarker !== undefined && isPidAlive(worktreeMarker.pid);
  const markerTarget =
    worktreeMarker !== undefined &&
    typeof worktreeMarker.targetPath === "string"
      ? resolveDeepestExisting(path.resolve(worktreeMarker.targetPath))
      : undefined;
  const manualRemove = (worktreePath: string): string =>
    `git -C ${markerRoot} worktree remove --force --force -- ${worktreePath}`;
  const worktreeProblems: string[] = [];
  const liveWorktrees: string[] = [];
  if (worktreeMarker !== undefined && !markerAlive) {
    const markerOwner =
      markerTarget !== undefined ? liveForeignOwner(markerTarget) : undefined;
    if (markerOwner !== undefined) {
      liveWorktrees.push(
        `${String(worktreeMarker.targetPath)} (pid ${markerOwner}, named by the marker)`,
      );
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
    if (registeredPath === markerTarget) {
      // Named by the marker: live, or already reported above.
      continue;
    }
    const owner = liveForeignOwner(registeredPath);
    if (owner !== undefined) {
      liveWorktrees.push(`${registeredPath} (pid ${owner})`);
      continue;
    }
    worktreeProblems.push(
      `a registered worktree of the probe's own scratch shape at ` +
        `${registeredPath} has no live probe behind it; the next \`probe -i ` +
        `worktree\` on this repository removes it, or run ` +
        `\`${manualRemove(registeredPath)}\` manually`,
    );
  }
  const liveNote =
    liveWorktrees.length === 0
      ? ""
      : `; a live probe owns ${liveWorktrees.join(", ")}`;
  checks.push({
    name: "stale-worktree",
    ok: worktreeProblems.length === 0,
    detail:
      worktreeProblems.length === 0
        ? `no stale worktree marker or leftover registered worktree for this repository${liveNote}`
        : `${worktreeProblems.join(" ")}${liveNote}`,
  });

  const hints: string[] = [];
  for (const tool of missingRequired) {
    const hint = GENERIC_HINTS[tool.name];
    if (hint) hints.push(hint);
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
 * `--porcelain` when git rejects `-z` (exit status 129, or the
 * unknown-switch text). Not ok when neither form ran to a parse: this is
 * a report, and a listing that could not run is something to warn
 * about, never an empty registry. */
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
    (nul.status === 129 || /unknown (switch|option)/.test(nul.stderr))
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
