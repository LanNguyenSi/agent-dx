import fs from "node:fs";
import path from "node:path";
import { execCommand, type ExecResult } from "../exec.js";
import { withoutRepoSelectionEnv } from "../git-env.js";
import { linkEntryUsageError } from "../probe/link-list.js";
import {
  captureLinkIdentity,
  writeLinkManifest,
  type LinkIdentity,
  type ManifestLink,
} from "../probe/link-manifest.js";
import type { ExecLike } from "../verify/types.js";
import {
  FETCH_TIMEOUT_MS,
  WorktreeRefusal,
  addToExclude,
  branchExists,
  commitSha,
  excludePatternFor,
  git,
  gitFailure,
  gitText,
  isIgnored,
  isWithin,
  resolveDefaultBase,
  resolveRepo,
  type RepoContext,
} from "./git.js";
import { smokeVerdict } from "./readiness.js";

export interface CreateWorktreeOptions {
  /** The invocation directory. Every relative path option (`path`, `root`,
   * `run`, `linksFrom`, `repo`) is resolved against it, never against the
   * repository. */
  cwd: string;
  /** Repository to branch from; defaults to `cwd`. */
  repo?: string;
  branch: string;
  base?: string;
  path?: string;
  root?: string;
  run?: string;
  /** Repository-relative paths to link from the main checkout. */
  links?: readonly string[];
  /** A file listing more link paths, one per line. */
  linksFrom?: string;
  setup?: string;
  smoke?: string;
  passRegex?: RegExp;
  /** `false` skips the fetch (`--no-fetch`). */
  fetch?: boolean;
  logDir: string;
  /** The tool version recorded in the link manifest. */
  toolVersion?: string;
  signal?: AbortSignal;
  execFn?: ExecLike;
}

export type LinkSkipReason =
  | "source_missing"
  | "destination_exists"
  | "parent_is_symlink"
  | "parent_not_directory"
  | "link_failed";

export interface MadeLink {
  /** Repository-relative path, the same in both checkouts. */
  path: string;
  /** Absolute path the link points at, in the main checkout. */
  target: string;
  /** `added`: a line was appended to the shared exclude file;
   * `already_ignored`: git already ignored the path; `failed`: the
   * exclude file could not be written (see `warnings`). */
  exclude: "added" | "already_ignored" | "failed";
}

/** What became of the record of the links made, which `probe` reads to
 * treat them as the operator's own (see `src/probe/link-manifest.ts`). */
export interface LinkManifestReport {
  /** `written`: the manifest is in the worktree's git administration
   * directory; `not_needed`: no link was made; `failed`: it could not be
   * written (see `reason` and `warnings`), so `probe` will need `--link`. */
  status: "written" | "not_needed" | "failed";
  path?: string;
  reason?: string;
  /** Links made but left out of a written manifest because the reader
   * would reject their entry; `probe` needs `--link` for these. */
  unrecorded?: { path: string; reason: string }[];
}

export interface SkippedLink {
  path: string;
  reason: LinkSkipReason;
  detail: string;
}

export interface StepReport {
  status: string;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  logPath?: string;
  reason?: string;
  passRegex?: string;
  /** The last part of the combined output, only for a step that did not
   * succeed. */
  outputTail?: string;
}

export interface CreateWorktreeResult {
  /** `ok`, or `fail` when `--setup` failed or the worktree is not ready.
   * The worktree exists in both cases. */
  status: "ok" | "fail";
  worktree: {
    path: string;
    branch: string;
    repo: string;
    mainCheckout: string;
    head: string;
  };
  base: {
    ref: string;
    sha: string;
    source: "flag" | "default";
    detail?: string;
  };
  fetch: { status: "fetched" | "skipped"; reason?: string };
  /** `null` when the new branch tracks nothing. */
  upstream: string | null;
  /** Ready for `00-goal.md`: `run-base[<repo>] = <sha>`. */
  runBase: string;
  pointer: {
    status: "written" | "skipped" | "not_requested";
    path?: string;
    target?: string;
    reason?: string;
  };
  links: {
    made: MadeLink[];
    skipped: SkippedLink[];
    manifest: LinkManifestReport;
  };
  setup: StepReport;
  smoke: StepReport;
  warnings: string[];
}

const OUTPUT_TAIL_CHARS = 1500;

function tailOf(run: ExecResult): string {
  const text = [run.stdoutTail, run.stderrTail]
    .filter((t) => t.trim().length > 0)
    .join("\n")
    .trim();
  return text.length > OUTPUT_TAIL_CHARS
    ? `...${text.slice(text.length - OUTPUT_TAIL_CHARS)}`
    : text;
}

/** A path-safe directory name for a branch name. */
export function branchSlug(branch: string): string {
  const slug = branch
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "worktree";
}

/**
 * Normalizes one `--link` / `--links-from` entry to a repository-relative
 * POSIX path, or returns the reason it cannot be used. Absolute paths,
 * anything that climbs out with `..`, the repository root itself and
 * anything under `.git` are refused: a link must land inside the new
 * worktree and must never aim at git's own metadata.
 */
export function normalizeLinkEntry(entry: string): {
  rel?: string;
  error?: string;
} {
  const shapeError = linkEntryUsageError(entry);
  if (shapeError !== undefined) return { error: shapeError };
  if (entry.includes("\0") || entry.includes("\n")) {
    return { error: "must not contain a NUL or a newline" };
  }
  if (path.posix.isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry)) {
    return { error: "must be relative to the repository root" };
  }
  const rel = path.posix.normalize(entry).replace(/\/+$/, "");
  if (rel === "" || rel === ".") {
    return { error: "must name a path below the repository root" };
  }
  if (rel === ".." || rel.startsWith("../")) {
    return { error: 'must not climb out of the repository with ".."' };
  }
  if (rel.split("/")[0]!.toLowerCase() === ".git") {
    return { error: "must not point into .git" };
  }
  return { rel };
}

function readLinksFile(file: string, repo: RepoContext): string[] {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (err) {
    throw new WorktreeRefusal(
      `cannot read --links-from ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "links_file_unreadable",
    );
  }
  for (const root of [repo.mainCheckout, repo.repoRoot]) {
    if (isWithin(root, real)) {
      throw new WorktreeRefusal(
        `--links-from ${file} lies inside the repository (${root}); the link list is operator configuration and must live outside it`,
        "links_file_inside_repo",
        { file: real, repository: root },
      );
    }
  }
  let text: string;
  try {
    text = fs.readFileSync(real, "utf8");
  } catch (err) {
    throw new WorktreeRefusal(
      `cannot read --links-from ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "links_file_unreadable",
    );
  }
  const entries: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0 && !line.startsWith("#")) entries.push(line);
  }
  return entries;
}

function collectLinks(
  options: CreateWorktreeOptions,
  repo: RepoContext,
): string[] {
  const raw: { entry: string; from: string }[] = [
    ...(options.links ?? []).map((entry) => ({ entry, from: "--link" })),
  ];
  if (options.linksFrom !== undefined) {
    const file = path.resolve(options.cwd, options.linksFrom);
    for (const entry of readLinksFile(file, repo)) {
      raw.push({ entry, from: `--links-from ${options.linksFrom}` });
    }
  }
  const seen = new Set<string>();
  const rels: string[] = [];
  for (const { entry, from } of raw) {
    const { rel, error } = normalizeLinkEntry(entry);
    if (rel === undefined) {
      throw new WorktreeRefusal(
        `link ${JSON.stringify(entry)} (${from}) ${error ?? "is not usable"}`,
        "link_invalid",
        { entry, source: from },
      );
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    rels.push(rel);
  }
  return rels;
}

function validateBranch(repo: RepoContext, branch: string): void {
  const checked = gitText(repo.mainCheckout, [
    "check-ref-format",
    "--branch",
    branch,
  ]);
  if (checked === undefined || checked !== branch) {
    throw new WorktreeRefusal(
      `${JSON.stringify(branch)} is not a valid branch name`,
      "branch_invalid",
    );
  }
  const holder = repo.worktrees.find((w) => w.branch === branch);
  if (holder !== undefined) {
    throw new WorktreeRefusal(
      `branch ${branch} is already checked out in ${holder.path}` +
        (holder.prunable
          ? " (git lists that worktree as prunable: its directory is gone; run `git worktree prune` in the repository if it is stale)"
          : ""),
      "branch_checked_out",
      { branch, worktree: holder.path, prunable: holder.prunable },
    );
  }
  if (branchExists(repo.mainCheckout, branch)) {
    throw new WorktreeRefusal(
      `branch ${branch} already exists; pick a new branch name (this command only creates branches)`,
      "branch_exists",
      { branch },
    );
  }
}

function resolveTarget(
  options: CreateWorktreeOptions,
  repo: RepoContext,
): string {
  let target: string;
  if (options.path !== undefined) {
    target = path.resolve(options.cwd, options.path);
  } else {
    const root =
      options.root !== undefined
        ? path.resolve(options.cwd, options.root)
        : path.join(path.dirname(repo.mainCheckout), `${repo.name}-worktrees`);
    target = path.join(root, branchSlug(options.branch));
  }
  if (isWithin(repo.mainCheckout, target)) {
    throw new WorktreeRefusal(
      `target ${target} lies inside the main checkout ${repo.mainCheckout}; choose a path outside it`,
      "target_inside_checkout",
      { target, mainCheckout: repo.mainCheckout },
    );
  }
  // A target inside another working tree of the repository would nest one
  // checkout in another: the linked worktree `--repo` was pointed at, or
  // any registered worktree whose directory still exists.
  const others = [
    repo.repoRoot,
    ...repo.worktrees.filter((w) => !w.prunable).map((w) => w.path),
  ];
  for (const other of others) {
    if (isWithin(repo.mainCheckout, other)) continue;
    if (isWithin(other, target)) {
      throw new WorktreeRefusal(
        `target ${target} lies inside the worktree ${other}; choose a path outside every working tree of the repository`,
        "target_inside_worktree",
        { target, worktree: other },
      );
    }
  }
  let exists = true;
  try {
    fs.lstatSync(target);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new WorktreeRefusal(
      `target ${target} already exists`,
      "target_exists",
      { target },
    );
  }
  return target;
}

function fetchOrigin(
  repo: RepoContext,
  warnings: string[],
): CreateWorktreeResult["fetch"] {
  const remote = gitText(repo.mainCheckout, ["remote", "get-url", "origin"]);
  if (remote === undefined) {
    const reason = "the repository has no origin remote";
    warnings.push(`fetch skipped: ${reason}`);
    return { status: "skipped", reason };
  }
  const r = git(
    repo.mainCheckout,
    ["fetch", "--quiet", "--no-recurse-submodules", "origin"],
    FETCH_TIMEOUT_MS,
  );
  if (r.error !== undefined || r.status !== 0) {
    throw new WorktreeRefusal(
      `git fetch origin failed: ${gitFailure(r)}. Pass --no-fetch to branch from the refs as they are.`,
      "fetch_failed",
    );
  }
  return { status: "fetched" };
}

function resolveBase(
  options: CreateWorktreeOptions,
  repo: RepoContext,
): CreateWorktreeResult["base"] {
  if (options.base !== undefined) {
    const sha = options.base.startsWith("-")
      ? undefined
      : commitSha(repo.mainCheckout, options.base);
    if (sha === undefined) {
      throw new WorktreeRefusal(
        `--base ${options.base} does not name a commit in ${repo.mainCheckout}`,
        "base_not_found",
        { base: options.base },
      );
    }
    return { ref: options.base, sha, source: "flag" };
  }
  const found = resolveDefaultBase(repo.mainCheckout);
  if (found === undefined) {
    throw new WorktreeRefusal(
      "cannot tell the default branch: origin/HEAD is not set and neither origin/main nor origin/master exists; pass --base <rev>",
      "default_branch_unresolved",
    );
  }
  const sha = commitSha(repo.mainCheckout, found.ref);
  if (sha === undefined) {
    throw new WorktreeRefusal(
      `the default base ${found.ref} does not resolve to a commit; pass --base <rev>`,
      "default_branch_unresolved",
    );
  }
  return { ref: found.ref, sha, source: "default", detail: found.source };
}

function writePointer(
  worktree: string,
  runDir: string | undefined,
): CreateWorktreeResult["pointer"] {
  if (runDir === undefined) return { status: "not_requested" };
  const rel = ".ai/run";
  const file = path.join(worktree, rel);
  const ignored = isIgnored(worktree, rel);
  if (ignored !== true) {
    return {
      status: "skipped",
      path: file,
      reason:
        ignored === false
          ? `${rel} is not ignored in the new worktree; add it to .gitignore, then write the pointer by hand`
          : `git could not tell whether ${rel} is ignored`,
    };
  }
  try {
    const aiDir = path.join(worktree, ".ai");
    for (const p of [aiDir, file]) {
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(p);
      } catch {
        st = undefined;
      }
      if (st?.isSymbolicLink()) {
        return {
          status: "skipped",
          path: file,
          reason: `${path.relative(worktree, p)} is a symbolic link; not writing through it`,
        };
      }
      if (st !== undefined && p === file) {
        return {
          status: "skipped",
          path: file,
          reason: `${rel} already exists in the new worktree`,
        };
      }
    }
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(file, `${runDir}\n`, { flag: "wx" });
    return { status: "written", path: file, target: runDir };
  } catch (err) {
    return {
      status: "skipped",
      path: file,
      reason: `cannot write ${rel}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function makeLinks(
  rels: readonly string[],
  repo: RepoContext,
  worktree: string,
  warnings: string[],
): Omit<CreateWorktreeResult["links"], "manifest"> & {
  identities: Map<string, LinkIdentity>;
} {
  const identities = new Map<string, LinkIdentity>();
  const made: MadeLink[] = [];
  const skipped: SkippedLink[] = [];
  for (const rel of rels) {
    const source = path.join(repo.mainCheckout, rel);
    const dest = path.join(worktree, rel);
    if (lstatOrUndefined(source) === undefined) {
      skipped.push({
        path: rel,
        reason: "source_missing",
        detail: `${source} does not exist in the main checkout`,
      });
      continue;
    }
    // A parent that is a symbolic link would send the new link (and the
    // directories made for it) through to wherever that link points, most
    // likely the main checkout. Walk the existing part of the parent chain.
    let blocked: SkippedLink | undefined;
    let cursor = worktree;
    for (const segment of path.posix.dirname(rel).split("/")) {
      if (segment === ".") break;
      cursor = path.join(cursor, segment);
      const st = lstatOrUndefined(cursor);
      if (st === undefined) break;
      if (st.isSymbolicLink()) {
        blocked = {
          path: rel,
          reason: "parent_is_symlink",
          detail: `${path.relative(worktree, cursor)} is a symbolic link; not linking through it`,
        };
        break;
      }
      if (!st.isDirectory()) {
        blocked = {
          path: rel,
          reason: "parent_not_directory",
          detail: `${path.relative(worktree, cursor)} is not a directory`,
        };
        break;
      }
    }
    if (blocked !== undefined) {
      skipped.push(blocked);
      continue;
    }
    if (lstatOrUndefined(dest) !== undefined) {
      skipped.push({
        path: rel,
        reason: "destination_exists",
        detail: `${rel} already exists in the new worktree (a tracked path?)`,
      });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(source, dest);
    } catch (err) {
      skipped.push({
        path: rel,
        reason: "link_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // Asked after the link exists: git judges a symbolic link as a file,
    // so a directory-only pattern such as `vendor/` does not cover it.
    let exclude: MadeLink["exclude"] = "already_ignored";
    if (isIgnored(worktree, rel) !== true) {
      try {
        addToExclude(repo.commonDir, excludePatternFor(rel));
        exclude = "added";
      } catch (err) {
        exclude = "failed";
        warnings.push(
          `could not add ${rel} to ${path.join(repo.commonDir, "info", "exclude")}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    made.push({ path: rel, target: source, exclude });
    // What the link reaches now, as the operator sees it; the manifest
    // keeps it so a later swap behind the same path is noticed.
    const identity = captureLinkIdentity(dest);
    if (identity !== undefined) identities.set(rel, identity);
  }
  return { made, skipped, identities };
}

/**
 * Records the links just made in the new worktree's git administration
 * directory (never in the working tree), so `probe` run in that worktree
 * can tell them from repository content. Nothing is written when no link
 * was made. A failure is a warning, not a refusal: the worktree and its
 * links exist either way.
 */
function recordLinks(
  made: readonly MadeLink[],
  identities: ReadonlyMap<string, LinkIdentity>,
  worktree: string,
  toolVersion: string,
  warnings: string[],
): LinkManifestReport {
  if (made.length === 0) return { status: "not_needed" };
  const createdAt = new Date().toISOString();
  const recordable: ManifestLink[] = [];
  const unresolved: { path: string; reason: string }[] = [];
  for (const l of made) {
    const identity = identities.get(l.path);
    if (identity === undefined) {
      // A link that does not resolve is not a `--link` source either:
      // probe refuses a source that is missing, so the remedy is to
      // create the target first.
      unresolved.push({
        path: l.path,
        reason:
          "its target does not resolve; create the target in the main checkout, then pass --link",
      });
    } else {
      recordable.push({
        path: l.path,
        target: l.target,
        createdAt,
        ...identity,
      });
    }
  }
  if (recordable.length === 0) {
    const reason = "no link resolves to its target";
    warnings.push(
      `could not record the links for probe: ${reason}; create the targets in the main checkout, then pass --link to probe`,
    );
    return { status: "failed", reason };
  }
  const written = writeLinkManifest(worktree, recordable, toolVersion);
  if (written.status === "written") {
    const unrecorded = [...unresolved, ...written.unrecorded];
    if (unrecorded.length > 0) {
      // A path the manifest cannot hold is linked with `--link`; a link
      // whose target is missing is not (see `unresolved` above).
      const described = [
        ...unresolved.map((u) => `${u.path} (${u.reason})`),
        ...written.unrecorded.map(
          (u) => `${u.path} (${u.reason}; pass --link to probe)`,
        ),
      ];
      warnings.push(`not recorded for probe: ${described.join(", ")}`);
    }
    return {
      status: "written",
      path: written.path,
      ...(unrecorded.length > 0 ? { unrecorded } : {}),
    };
  }
  warnings.push(
    `could not record the links for probe: ${written.reason}; pass --link to probe to link them`,
  );
  return {
    status: "failed",
    ...(written.path !== undefined ? { path: written.path } : {}),
    reason: written.reason,
  };
}

async function runStep(
  kind: "setup" | "smoke",
  command: string,
  worktree: string,
  options: CreateWorktreeOptions,
): Promise<ExecResult> {
  const execFn: ExecLike = options.execFn ?? execCommand;
  return execFn(command, {
    cwd: worktree,
    env: withoutRepoSelectionEnv(),
    logDir: options.logDir,
    logFileName: `worktree-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
    signal: options.signal,
  });
}

/**
 * Creates a linked worktree on a new branch, off a base the main checkout
 * is never moved to. Every check that can refuse runs before the first
 * change (the one exception is the fetch, which only updates remote
 * tracking refs); once the worktree exists, a step that does not work
 * (a pointer that cannot be written, a link whose source is missing, a
 * failed `--setup`) is reported in the result instead of undoing the
 * worktree.
 *
 * The main checkout's HEAD, index, working tree and stash are never
 * touched: git is asked to add the worktree with `-C <main checkout>`
 * and the new branch starts from a ref, which `worktree add` resolves
 * without checking anything out there. Nothing here runs `git stash`.
 */
export async function createWorktree(
  options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  if (options.path !== undefined && options.root !== undefined) {
    throw new WorktreeRefusal(
      "--path and --root are alternatives; give one",
      "path_and_root_conflict",
    );
  }
  if (options.passRegex !== undefined && options.smoke === undefined) {
    throw new WorktreeRefusal(
      "--pass-regex needs --smoke: it is the readiness predicate of the smoke command",
      "option_invalid",
    );
  }
  for (const [flag, value] of [
    ["--setup", options.setup],
    ["--smoke", options.smoke],
  ] as const) {
    if (value !== undefined && value.trim().length === 0) {
      throw new WorktreeRefusal(`${flag} needs a command`, "option_invalid");
    }
  }

  const repoPath = path.resolve(options.cwd, options.repo ?? ".");
  const repo = resolveRepo(repoPath);
  validateBranch(repo, options.branch);
  const target = resolveTarget(options, repo);
  let runDir: string | undefined;
  if (options.run !== undefined) {
    runDir = path.resolve(options.cwd, options.run);
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(runDir);
    } catch {
      st = undefined;
    }
    if (st === undefined || !st.isDirectory()) {
      throw new WorktreeRefusal(
        `--run ${runDir} is not an existing directory`,
        "run_dir_missing",
        { run: runDir },
      );
    }
  }
  const linkRels = collectLinks(options, repo);

  const warnings: string[] = [];
  const fetchReport: CreateWorktreeResult["fetch"] =
    options.fetch === false
      ? { status: "skipped", reason: "--no-fetch" }
      : fetchOrigin(repo, warnings);
  const base = resolveBase(options, repo);

  // `--no-track` is what keeps a branch started from `origin/<default>`
  // from inheriting that branch as its upstream, where a bare `git push`
  // would then aim at the default branch. The start point stays a ref
  // name (not its sha) because only a ref can be tracked.
  const added = git(repo.mainCheckout, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    options.branch,
    "--",
    target,
    base.ref,
  ]);
  if (added.error !== undefined || added.status !== 0) {
    throw new WorktreeRefusal(
      `git worktree add failed: ${gitFailure(added)}`,
      "worktree_add_failed",
      { target },
    );
  }

  const head = gitText(target, ["rev-parse", "HEAD"]) ?? base.sha;
  if (head !== base.sha) {
    warnings.push(
      `the new worktree is at ${head}, not at the ${base.sha} that ${base.ref} resolved to a moment earlier; the ref moved while the worktree was being created`,
    );
  }
  const upstream =
    gitText(target, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${options.branch}@{upstream}`,
    ]) ?? null;
  if (upstream !== null) {
    warnings.push(
      `branch ${options.branch} tracks ${upstream}; run \`git branch --unset-upstream\` in the worktree before pushing`,
    );
  }

  const pointer = writePointer(target, runDir);
  const madeLinks = makeLinks(linkRels, repo, target, warnings);
  const manifest = recordLinks(
    madeLinks.made,
    madeLinks.identities,
    target,
    options.toolVersion ?? "unknown",
    warnings,
  );
  const links = {
    made: madeLinks.made,
    skipped: madeLinks.skipped,
    manifest,
  };

  let setup: StepReport = { status: "not_requested" };
  let setupFailed = false;
  if (options.setup !== undefined) {
    const run = await runStep("setup", options.setup, target, options);
    setupFailed = run.exitCode !== 0 || run.timedOut || run.aborted;
    setup = {
      status: setupFailed ? "failed" : "ok",
      command: options.setup,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      logPath: run.logPath,
      ...(setupFailed
        ? {
            reason: run.aborted
              ? "the setup command was aborted"
              : run.timedOut
                ? "the setup command timed out"
                : run.exitCode === null
                  ? "the setup command was killed before it reported an exit code"
                  : `the setup command exited with code ${String(run.exitCode)}`,
            outputTail: tailOf(run),
          }
        : {}),
    };
  }

  let smoke: StepReport = { status: "not_requested" };
  if (options.smoke !== undefined) {
    if (setupFailed) {
      smoke = {
        status: "not_run",
        command: options.smoke,
        reason: "the setup command failed, so the smoke command was not run",
      };
    } else {
      const run = await runStep("smoke", options.smoke, target, options);
      const verdict = smokeVerdict(run, options.passRegex);
      warnings.push(...verdict.warnings);
      smoke = {
        status: verdict.status,
        command: options.smoke,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        logPath: run.logPath,
        ...(options.passRegex !== undefined
          ? { passRegex: options.passRegex.source }
          : {}),
        ...(verdict.status === "not_ready"
          ? { reason: verdict.reason, outputTail: tailOf(run) }
          : {}),
      };
    }
  }

  const notReady = setupFailed || smoke.status === "not_ready";
  return {
    status: notReady ? "fail" : "ok",
    worktree: {
      path: target,
      branch: options.branch,
      repo: repo.name,
      mainCheckout: repo.mainCheckout,
      head,
    },
    base,
    fetch: fetchReport,
    upstream,
    runBase: `run-base[${repo.name}] = ${head}`,
    pointer,
    links,
    setup,
    smoke,
    warnings,
  };
}
