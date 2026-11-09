import fs from "node:fs";
import path from "node:path";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  boundedCommand,
  boundedSpawnOptions,
  endGroupIfAbnormal,
  isTimeoutError,
} from "../bounded-spawn.js";
import {
  PATHSPEC_ENV_VARS,
  REF_FORMAT_ENV_VARS,
  REPO_SELECTION_ENV_VARS,
} from "../git-env.js";

/**
 * The branch guard of `patch`: the command refuses to write while a
 * repository that holds a target sits on a protected branch, because a
 * shell call of `agent-primitives patch` is not seen by a hook that judges
 * only the editor tools. `evaluateBranchGuard` judges one repository;
 * `patch()` calls it once for each distinct repository (the one at `-C`
 * and the one of each target) and refuses the plan when any of them does.
 *
 * The protected set is the union of three sources, compared without regard
 * to letter case (as the harness hook does):
 *   - `flag`: every `--protected <name>`;
 *   - `origin-head`: the branch `refs/remotes/origin/HEAD` points to, when
 *     it is a plain `refs/remotes/origin/<name>`;
 *   - `builtin`: `main` and `master`.
 *
 * HEAD and origin/HEAD are read with two `git symbolic-ref` calls, each
 * bounded like the identity lookup of `patch` (3 s, 64 KiB, own process
 * group, stdin closed) and each in the repository root. HEAD is read as the
 * full ref name and the `refs/heads/` prefix is cut off here: `--short`
 * would answer `heads/main` when a tag `main` exists too, and that spelling
 * matches no protected name. Anything that is not a clear answer fails
 * closed: the guard refuses with `protected_branch_unresolved`. All the
 * git calls of one plan also share an overall budget (`GuardBudget`,
 * `BRANCH_GUARD_BUDGET_FACTOR` times the per-call bound): a call gets the
 * per-call bound or what is left of the budget, whichever is less, and a
 * repository reached after the budget is used up is not asked at all and
 * is refused the same way.
 */

/** The names that are protected whatever the repository says. */
export const BUILTIN_PROTECTED = ["main", "master"] as const;

/** How long one of the guard's git calls may run. */
export const BRANCH_GUARD_TIMEOUT_MS = 3_000;

/**
 * The time all of the guard's git calls of one plan may take together, as
 * a multiple of the per-call bound: twice. Each repository costs at least
 * two calls and a hanging git costs the whole bound per call, so without a
 * cap a plan over many repositories waits three seconds per call per
 * repository. Twice the bound lets two calls hang in full (one hung
 * repository, or a flaky one) and still leaves room for the rest of a
 * healthy plan, whose calls take milliseconds; every repository that is
 * not resolved by then is refused as `protected_branch_unresolved`.
 */
export const BRANCH_GUARD_BUDGET_FACTOR = 2;

/** The most output taken from one of the guard's git calls. */
const BRANCH_GUARD_MAX_OUTPUT = 64 * 1024;

export type ProtectedSource = "flag" | "origin-head" | "builtin";

export type BranchGuardStatus =
  | "allowed"
  | "refused"
  | "would_refuse"
  | "not_a_repo"
  | "detached"
  | "allowed_protected"
  | "allowed_untracked"
  | "allowed_ignored";

/** What git says about a target's file: `untracked` and `ignored` cannot
 * reach a protected branch through `patch`; `tracked` can; `unknown` is a
 * classification that failed and is treated as `tracked`. */
export type TargetTracking = "tracked" | "untracked" | "ignored" | "unknown";

/** The guard's decision for one target, listed in `RepoGuard.targets`
 * when the repository was on a protected branch (or a detached HEAD under
 * `--protect-detached`). */
export interface TargetGuard {
  /** The target as the edits name it (their `path`). */
  path: string;
  /** `allowed_untracked` and `allowed_ignored` for a target no edit of
   * which can reach the branch; for a tracked (or unclassifiable) one the
   * status the repository's refusal settled to: `refused`,
   * `would_refuse` or `allowed_protected`. */
  status: BranchGuardStatus;
  tracking: TargetTracking;
  /** The refusal's reason, for a target whose status is `refused`,
   * `would_refuse` or `allowed_protected`. */
  reason?: string;
}

/** What the envelope reports for one repository (or for the targets that
 * lie in none): no free text, the refusal's wording is in the edits. */
export interface RepoGuard {
  /** The real path of the repository's work tree; absent for
   * `not_a_repo`. */
  root?: string;
  status: BranchGuardStatus;
  /** The branch HEAD names (`HEAD` when detached); absent when it could
   * not be resolved or there is no repository. */
  branch?: string;
  /** The protected names that were in force, in source order. */
  protected: string[];
  /** The sources that contributed names to `protected`. */
  sources: ProtectedSource[];
  /** Why the guard refused, would refuse or was overridden:
   * `protected_branch` or `protected_branch_unresolved`. */
  reason?: string;
  /** One entry per target of the plan in this repository, present only
   * when the repository needed a per-target decision (a protected branch,
   * or a detached HEAD under `--protect-detached`, with at least one
   * target). The entry's `status` is the most severe of its targets', in
   * the order of `STATUS_ORDER`. */
  targets?: TargetGuard[];
}

/** What the envelope reports as `branch_guard`: the overall status (the
 * first of refused, would_refuse, allowed_protected, detached, allowed,
 * not_a_repo that any repository has), its reason, and one entry per
 * distinct repository that holds a target. */
export interface BranchGuard {
  status: BranchGuardStatus;
  reason?: string;
  repos: RepoGuard[];
}

/** A target of the plan that lies in the repository being judged. */
export interface GuardTarget {
  /** The real path of the file (absolute, symlinks resolved). */
  path: string;
  /** How the edits name it. */
  label: string;
}

export interface BranchGuardInput {
  /** The real path of the work tree to judge. */
  root: string;
  /** The targets in this repository whose path checks passed. On a
   * protected branch each is classified (ignored, untracked, tracked) and
   * only a tracked one is refused; with none, the repository is judged as
   * a whole. */
  targets?: readonly GuardTarget[];
  /** Why git must not be run in `root` (`gitDiscoveryHazard`), if so. */
  hazard: string | undefined;
  /** How long one git call may run. */
  timeoutMs: number;
  /** The time all calls of the plan may take together (shared by every
   * repository of the plan); a call gets at most what is left of it. */
  budget?: GuardBudget;
  flagNames: readonly string[];
  protectDetached: boolean;
  allowProtected: boolean;
  dryRun: boolean;
}

export interface BranchGuardVerdict {
  guard: RepoGuard;
  /** The sentence that says what was refused and how to go on; carried
   * by the edits of a refused plan, not by the envelope's guard. */
  detail?: string;
  /** True when the plan must be refused (nothing written). */
  refuse: boolean;
  /** True when `--allow-protected` overrode a refusal. */
  overridden: boolean;
  /** When the refusal rests on tracked targets: their real paths. Empty
   * or absent when the whole repository is refused. */
  refusedTargets?: ReadonlySet<string>;
  /** One sentence for each target whose classification failed (treated as
   * tracked). */
  classifyFailures?: string[];
}

/** Most severe first: `combineGuards` takes the first status of this list
 * that any repository has, and a repository's own status is the first that
 * any of its targets has. The two per-target statuses sit between
 * `detached` and `allowed`: a protected branch that only untracked or
 * ignored targets touch is more notable than a plain `allowed`, and an
 * untracked target (which `git add` could still bring in) outranks an
 * ignored one. */
const STATUS_ORDER: BranchGuardStatus[] = [
  "refused",
  "would_refuse",
  "allowed_protected",
  "detached",
  "allowed_untracked",
  "allowed_ignored",
  "allowed",
  "not_a_repo",
];

/** The entry for targets that lie in no repository. */
export function notARepoGuard(): RepoGuard {
  return { status: "not_a_repo", protected: [], sources: [] };
}

/** The overall guard of a plan from its per-repository entries. */
export function combineGuards(repos: RepoGuard[]): BranchGuard {
  if (repos.length === 0) return { status: "not_a_repo", repos: [] };
  let best = repos[0];
  for (const r of repos) {
    if (STATUS_ORDER.indexOf(r.status) < STATUS_ORDER.indexOf(best.status)) {
      best = r;
    }
  }
  return {
    status: best.status,
    ...(best.reason !== undefined ? { reason: best.reason } : {}),
    repos,
  };
}

/** The names `--protected` may carry: a branch name as git spells it, so
 * never empty, never padded with whitespace, never holding a control
 * character. Returns the reason it is unusable, or undefined. */
export function protectedNameProblem(name: string): string | undefined {
  if (name.length === 0) return "it is empty";
  if (name !== name.trim()) return "it has leading or trailing whitespace";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return "it holds a control character";
  }
  return undefined;
}

/** The environment of the guard's git calls: the identity lookup's
 * discovery steering variables, plus the ones that change which refs git
 * reads (a namespace, a ref storage format) or what its configuration
 * says (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` and the pairs it
 * numbers) and git's pathspec switches (`GIT_ICASE_PATHSPECS` and the
 * others: the guard names its own pathspec magic), with terminal prompts
 * off. */
export function branchGuardEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const drop = new Set<string>([
    ...REPO_SELECTION_ENV_VARS,
    ...REF_FORMAT_ENV_VARS,
    ...PATHSPEC_ENV_VARS,
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
  ]);
  for (const key of Object.keys(env)) {
    if (
      drop.has(key) ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** The time the guard's git calls of one plan may take together. Started
 * when the first repository is judged; `remainingMs` reads a monotone
 * clock. */
export class GuardBudget {
  private readonly deadline: number;
  constructor(readonly totalMs: number) {
    this.deadline = performance.now() + totalMs;
  }
  remainingMs(): number {
    return this.deadline - performance.now();
  }
}

/** What bounds one of the guard's git calls: the per-call bound and, when
 * the plan has one, the shared budget. */
interface GitLimit {
  timeoutMs: number;
  budget?: GuardBudget;
}

function limitOf(input: BranchGuardInput): GitLimit {
  return { timeoutMs: input.timeoutMs, budget: input.budget };
}

type GitAnswer =
  | { kind: "exit"; status: number; stdout: string }
  | { kind: "failed"; why: string };

function runGit(
  root: string,
  args: readonly string[],
  limit: GitLimit,
): GitAnswer {
  const name = `git ${args.join(" ")}`;
  // Each call gets the per-call bound or what is left of the plan's
  // budget, whichever is less; with nothing left it is not run at all.
  const left = limit.budget?.remainingMs();
  if (left !== undefined && left <= 0) {
    return {
      kind: "failed",
      why: `${name} was not run: the branch guard's overall time budget of ${String(limit.budget?.totalMs)} ms for the whole plan is used up`,
    };
  }
  const timeoutMs =
    left === undefined
      ? limit.timeoutMs
      : Math.min(limit.timeoutMs, Math.ceil(left));
  const budgetBound = timeoutMs < limit.timeoutMs;
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: root,
    env: branchGuardEnv(),
    encoding: "utf8",
    maxBuffer: BRANCH_GUARD_MAX_OUTPUT,
    ...boundedSpawnOptions(timeoutMs),
  };
  const run = boundedCommand("git", [...args]);
  const res = spawnSync(run.command, run.args, options);
  endGroupIfAbnormal(res);
  const e = res.error as NodeJS.ErrnoException | undefined;
  if (isTimeoutError(e)) {
    return {
      kind: "failed",
      why: budgetBound
        ? `${name} did not finish within the ${String(timeoutMs)} ms left of the branch guard's overall time budget of ${String(limit.budget?.totalMs)} ms for the whole plan and was stopped`
        : `${name} did not finish within ${String(timeoutMs)} ms and was stopped`,
    };
  }
  if (e?.code === "ENOBUFS") {
    return {
      kind: "failed",
      why: `${name} wrote more than ${String(BRANCH_GUARD_MAX_OUTPUT)} bytes and was stopped`,
    };
  }
  if (res.error !== undefined) {
    return {
      kind: "failed",
      why: `git could not be run: ${res.error.message}`,
    };
  }
  if (res.signal !== null) {
    return {
      kind: "failed",
      why: `${name} was ended by ${String(res.signal)}`,
    };
  }
  if (process.platform !== "win32" && res.status !== null) {
    if (res.status === 126 || res.status === 127) {
      return {
        kind: "failed",
        why: `git could not be run (status ${String(res.status)}: no runnable git on PATH)`,
      };
    }
    if (res.status > 128) {
      return {
        kind: "failed",
        why: `${name} was ended by a signal (status ${String(res.status)})`,
      };
    }
  }
  if (res.status === null) {
    return { kind: "failed", why: `${name} gave no exit status` };
  }
  return { kind: "exit", status: res.status, stdout: res.stdout };
}

/** `refs/heads/<name>`'s name, from `symbolic-ref HEAD` output. */
function headBranch(stdout: string): string | undefined {
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!line.startsWith("refs/heads/") || line.length <= "refs/heads/".length) {
    return undefined;
  }
  if (line.includes("\n")) return undefined;
  return line.slice("refs/heads/".length);
}

/** `<name>` from `symbolic-ref refs/remotes/origin/HEAD` output when it is
 * a plain `refs/remotes/origin/<name>`; undefined for any other target. */
function originHeadBranch(stdout: string): string | undefined {
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const prefix = "refs/remotes/origin/";
  if (!line.startsWith(prefix) || line.length <= prefix.length) {
    return undefined;
  }
  if (line.includes("\n")) return undefined;
  const name = line.slice(prefix.length);
  return name === "HEAD" ? undefined : name;
}

interface Named {
  name: string;
  source: ProtectedSource;
}

/**
 * Decides whether `patch` may write. See the module comment for the
 * protected set and the failure rule.
 */
export function evaluateBranchGuard(
  input: BranchGuardInput,
): BranchGuardVerdict {
  // The outcome when HEAD or origin/HEAD cannot be read: fail closed.
  const unresolved = (why: string, names: Named[]): BranchGuardVerdict => {
    const detail = `patch could not tell which branch ${input.root} is on (${why}). Check the branch by hand and pass --allow-protected to edit anyway`;
    const guard: RepoGuard = {
      root: input.root,
      ...summarise(names),
      status: "refused",
      reason: "protected_branch_unresolved",
    };
    return settle(guard, detail, input);
  };

  const names: Named[] = input.flagNames.map((name) => ({
    name,
    source: "flag" as const,
  }));

  if (input.hazard !== undefined) {
    return unresolved(`git was not run: ${input.hazard}`, withBuiltin(names));
  }

  const head = runGit(
    input.root,
    ["symbolic-ref", "--quiet", "HEAD"],
    limitOf(input),
  );
  if (head.kind === "failed") return unresolved(head.why, withBuiltin(names));
  let branch: string | undefined;
  let detached = false;
  if (head.status === 0) {
    branch = headBranch(head.stdout);
    if (branch === undefined) {
      return unresolved(
        `HEAD names ${JSON.stringify(head.stdout.trim())}, which is not a branch under refs/heads/`,
        withBuiltin(names),
      );
    }
  } else if (head.status === 1 && head.stdout.trim() === "") {
    detached = true;
  } else {
    return unresolved(
      `git symbolic-ref HEAD failed with exit code ${String(head.status)}`,
      withBuiltin(names),
    );
  }

  const origin = runGit(
    input.root,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    limitOf(input),
  );
  if (origin.kind === "failed") {
    return unresolved(origin.why, withBuiltin(names));
  }
  if (origin.status === 0) {
    const name = originHeadBranch(origin.stdout);
    if (name !== undefined) names.push({ name, source: "origin-head" });
  } else if (origin.status !== 1) {
    return unresolved(
      `git symbolic-ref refs/remotes/origin/HEAD failed with exit code ${String(origin.status)}`,
      withBuiltin(names),
    );
  }
  const all = withBuiltin(names);

  if (detached) {
    const guard: RepoGuard = {
      root: input.root,
      ...summarise(all),
      status: "detached",
      branch: "HEAD",
    };
    if (!input.protectDetached)
      return { guard, refuse: false, overridden: false };
    return judgeTargets(
      { ...guard, status: "refused", reason: "protected_branch" },
      (tracked) =>
        `patch refuses to edit on a detached HEAD of ${input.root} (--protect-detached)${trackedNote(tracked)}; check out a task branch, or pass --allow-protected to edit here anyway`,
      input,
    );
  }

  const folded = (branch as string).toLowerCase();
  const hit = all.filter((n) => n.name.toLowerCase() === folded);
  const guard: RepoGuard = {
    root: input.root,
    ...summarise(all),
    status: "allowed",
    branch,
  };
  if (hit.length === 0) return { guard, refuse: false, overridden: false };
  const via = [...new Set(hit.map((n) => n.source))].join(", ");
  return judgeTargets(
    { ...guard, status: "refused", reason: "protected_branch" },
    (tracked) =>
      `patch refuses to edit on the protected branch ${JSON.stringify(branch)} of ${input.root} (protected by: ${via})${trackedNote(tracked)}; switch to a task branch, or pass --allow-protected to edit here anyway`,
    input,
  );
}

/** The part of a refusal that names the tracked targets; empty when the
 * whole repository is judged (no target was classified). */
function trackedNote(tracked: readonly string[]): string {
  if (tracked.length === 0) return "";
  return ` (tracked ${tracked.length === 1 ? "target" : "targets"}: ${tracked.map((t) => JSON.stringify(t)).join(", ")})`;
}

interface Classified {
  target: GuardTarget;
  tracking: TargetTracking;
  /** Why a classification failed (`tracking` is `unknown`). */
  why?: string;
}

/** Escapes the characters git's glob magic reads in a name. */
function globEscape(name: string): string {
  return name.replace(/[\\*?[\]]/g, "\\$&");
}

/** The fallback's directory listings of one repository, by directory (the
 * index does not change while the guard judges the plan): the entry names,
 * or why the listing failed. */
type DirListings = Map<string, string[] | { unknown: string }>;

function listDirectoryEntries(
  root: string,
  parent: string,
  limit: GitLimit,
): string[] | { unknown: string } {
  const specs =
    parent === "."
      ? [":(glob)*"]
      : [
          ...new Set([
            parent,
            parent.normalize("NFC"),
            parent.normalize("NFD"),
          ]),
        ].map((dir) => `:(glob,icase)${globEscape(dir)}/*`);
  const listed = runGit(
    root,
    ["ls-files", "-z", "--full-name", "--", ...specs],
    limit,
  );
  if (listed.kind === "failed") return { unknown: listed.why };
  if (listed.status !== 0) {
    return {
      unknown: `git ls-files failed with exit code ${String(listed.status)}`,
    };
  }
  return listed.stdout.split("\0").filter((entry) => entry !== "");
}

/**
 * The identity fallback of `classifyTarget`, for a target the pathspec
 * lookup found no index entry for. The pathspec lookup compares spellings
 * (case for ASCII, NFC, NFD); this one compares files. It lists the index
 * entries that sit directly in the target's directory (`:(glob,icase)`
 * with the directory in its spelling, NFC and NFD form, so only that
 * directory's own entries are listed, not everything below it; for a
 * root-level target, the top-level entries) and compares the `dev:ino` of
 * each entry, as `lstat` finds it under the index's spelling, with the
 * target's. On a volume that folds letter case or Unicode form an entry
 * and a variant spelling are the same file whatever `core.ignorecase` and
 * `core.precomposeunicode` say, and on a volume that does not they are two
 * files and the entry is not found. A listing that git does not finish
 * within the bound or output cap, or any stat error but "no such entry",
 * is `unknown`. A directory is listed once for all the targets in it.
 */
function trackedByIdentity(
  root: string,
  target: GuardTarget,
  rel: string,
  limit: GitLimit,
  listings: DirListings,
): "tracked" | "other" | { unknown: string } {
  let own: fs.Stats;
  try {
    own = fs.lstatSync(target.path);
  } catch (err) {
    return { unknown: `could not stat the target: ${(err as Error).message}` };
  }
  if (own.ino === 0) return { unknown: "the volume reports no inode numbers" };
  const parent = path.posix.dirname(rel);
  let entries = listings.get(parent);
  if (entries === undefined) {
    entries = listDirectoryEntries(root, parent, limit);
    listings.set(parent, entries);
  }
  if (!Array.isArray(entries)) return entries;
  for (const entry of entries) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(root, entry));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return {
        unknown: `could not stat an index entry: ${(err as Error).message}`,
      };
    }
    if (st.dev === own.dev && st.ino === own.ino) return "tracked";
  }
  return "other";
}

/** Whether git folds letter case for this repository (`core.ignorecase`,
 * set by `git init` on a case-insensitive volume). Read once per
 * repository, only to choose `icase` for the fast lookup of
 * `classifyTarget`. Unset is false; anything but a clear answer counts as
 * true (fail closed: the lookup then also matches other spellings, which
 * can only refuse more). */
function readIgnoreCase(root: string, limit: GitLimit): boolean {
  const res = runGit(root, ["config", "--type=bool", "core.ignorecase"], limit);
  if (res.kind === "failed") return true;
  if (res.status === 1) return false;
  if (res.status !== 0) return true;
  return res.stdout.trim() !== "false";
}

/** Asks git, in the repository root, whether one target is tracked,
 * ignored or untracked, in that order.
 *
 * Tracked first, because the on-disk spelling of a file need not be the
 * index's: on a case-insensitive volume `Bar.md` can be `bar.md` on disk
 * (git status clean), and a file can be stored in the index as NFC and
 * sit on disk as NFD. `git check-ignore` and a plain pathspec compare
 * bytes, so asking them first would call such a tracked file untracked.
 * Two steps. The fast path is one `git ls-files -z --full-name` with
 * literal pathspecs of the root-relative path in its spelling, its NFC
 * form and its NFD form (a prefix directory included), each `icase` when
 * `core.ignorecase` is true; any listed entry is a tracked file. When it
 * lists nothing, `trackedByIdentity` compares files instead of
 * spellings, which does not trust the configuration: it also catches a
 * case variant with `core.ignorecase` false or unset on a folding volume,
 * a letter outside ASCII that differs only in case, and a partly
 * decomposed index entry. A variant that is a different file on the volume
 * is untracked.
 *
 * Only a file that neither step finds goes on to `git check-ignore -q`,
 * which tells ignored from untracked. Anything but a clear answer from
 * git is `unknown`. */
function classifyTarget(
  root: string,
  target: GuardTarget,
  ignoreCase: boolean,
  limit: GitLimit,
  listings: DirListings,
): Classified {
  const unknown = (why: string): Classified => ({
    target,
    tracking: "unknown",
    why,
  });
  const rel = path.relative(root, target.path).split(path.sep).join("/");
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith("../") ||
    path.isAbsolute(rel)
  ) {
    return unknown(`the target lies outside ${root}`);
  }
  const magic = ignoreCase ? "literal,icase" : "literal";
  const spellings = [
    ...new Set([rel, rel.normalize("NFC"), rel.normalize("NFD")]),
  ];
  const listed = runGit(
    root,
    [
      "ls-files",
      "-z",
      "--full-name",
      "--",
      ...spellings.map((spelling) => `:(${magic})${spelling}`),
    ],
    limit,
  );
  if (listed.kind === "failed") return unknown(listed.why);
  if (listed.status !== 0) {
    return unknown(
      `git ls-files failed with exit code ${String(listed.status)}`,
    );
  }
  if (listed.stdout !== "") return { target, tracking: "tracked" };
  const same = trackedByIdentity(root, target, rel, limit, listings);
  if (typeof same === "object") return unknown(same.unknown);
  if (same === "tracked") return { target, tracking: "tracked" };
  const ignored = runGit(
    root,
    ["check-ignore", "-q", "--", target.path],
    limit,
  );
  if (ignored.kind === "failed") return unknown(ignored.why);
  if (ignored.status === 0) return { target, tracking: "ignored" };
  if (ignored.status === 1) return { target, tracking: "untracked" };
  return unknown(
    `git check-ignore failed with exit code ${String(ignored.status)}`,
  );
}

/**
 * The verdict of a repository that would be refused (a protected branch,
 * or a detached HEAD under `--protect-detached`), per target: an ignored or
 * an untracked target cannot reach the protected branch through `patch`
 * and is allowed; a tracked one, or one whose classification failed (fail
 * closed), is refused, and a refusal of any of them is the whole plan's
 * (the caller refuses every file). With no target to classify the
 * repository is judged as a whole.
 */
function judgeTargets(
  refused: RepoGuard,
  describe: (tracked: string[]) => string,
  input: BranchGuardInput,
): BranchGuardVerdict {
  const targets = input.targets ?? [];
  if (targets.length === 0) return settle(refused, describe([]), input);
  const ignoreCase = readIgnoreCase(input.root, limitOf(input));
  const listings: DirListings = new Map();
  const classified = targets.map((t) =>
    classifyTarget(input.root, t, ignoreCase, limitOf(input), listings),
  );
  const classifyFailures = classified
    .filter((c) => c.tracking === "unknown")
    .map(
      (c) =>
        `could not tell whether ${JSON.stringify(c.target.label)} is tracked (${c.why ?? "no answer"}); treated as tracked`,
    );
  const blocking = classified.filter(
    (c) => c.tracking === "tracked" || c.tracking === "unknown",
  );
  const own = (c: Classified): TargetGuard => ({
    path: c.target.label,
    status: c.tracking === "ignored" ? "allowed_ignored" : "allowed_untracked",
    tracking: c.tracking,
  });
  if (blocking.length === 0) {
    const { reason: _reason, ...rest } = refused;
    void _reason;
    const entries = classified.map(own);
    const status = STATUS_ORDER.find((s) =>
      entries.some((e) => e.status === s),
    ) as BranchGuardStatus;
    return {
      guard: { ...rest, status, targets: entries },
      refuse: false,
      overridden: false,
      classifyFailures,
    };
  }
  const base = settle(
    refused,
    describe(blocking.map((c) => c.target.label)),
    input,
  );
  const entries = classified.map((c): TargetGuard => {
    if (!blocking.includes(c)) return own(c);
    return {
      path: c.target.label,
      status: base.guard.status,
      tracking: c.tracking,
      ...(base.guard.reason !== undefined ? { reason: base.guard.reason } : {}),
    };
  });
  return {
    ...base,
    guard: { ...base.guard, targets: entries },
    refusedTargets: new Set(blocking.map((c) => c.target.path)),
    classifyFailures,
  };
}

function withBuiltin(names: Named[]): Named[] {
  return [
    ...names,
    ...BUILTIN_PROTECTED.map((name) => ({
      name,
      source: "builtin" as const,
    })),
  ];
}

/** The `protected` and `sources` fields: names deduplicated without regard
 * to case (first spelling kept), sources in the order they contributed. */
function summarise(names: Named[]): Pick<RepoGuard, "protected" | "sources"> {
  const seen = new Set<string>();
  const out: string[] = [];
  const sources: ProtectedSource[] = [];
  for (const n of names) {
    if (!sources.includes(n.source)) sources.push(n.source);
    const key = n.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n.name);
  }
  return { protected: out, sources };
}

/** Turns a would-be refusal into the final verdict: overridden by
 * `--allow-protected`, only reported in a dry run, or enforced. */
function settle(
  guard: RepoGuard,
  detail: string,
  input: BranchGuardInput,
): BranchGuardVerdict {
  if (input.allowProtected) {
    return {
      guard: { ...guard, status: "allowed_protected" },
      detail: `overridden by --allow-protected: ${detail}`,
      refuse: false,
      overridden: true,
    };
  }
  if (input.dryRun) {
    return {
      guard: { ...guard, status: "would_refuse" },
      detail: `a real run would be refused: ${detail}`,
      refuse: false,
      overridden: false,
    };
  }
  return { guard, detail, refuse: true, overridden: false };
}
