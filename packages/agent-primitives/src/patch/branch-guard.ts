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
import { REF_FORMAT_ENV_VARS, REPO_SELECTION_ENV_VARS } from "../git-env.js";

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
 * closed: the guard refuses with `protected_branch_unresolved`.
 */

/** The names that are protected whatever the repository says. */
export const BUILTIN_PROTECTED = ["main", "master"] as const;

/** How long one of the guard's git calls may run. */
export const BRANCH_GUARD_TIMEOUT_MS = 3_000;

/** The most output taken from one of the guard's git calls. */
const BRANCH_GUARD_MAX_OUTPUT = 64 * 1024;

export type ProtectedSource = "flag" | "origin-head" | "builtin";

export type BranchGuardStatus =
  | "allowed"
  | "refused"
  | "would_refuse"
  | "not_a_repo"
  | "detached"
  | "allowed_protected";

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

export interface BranchGuardInput {
  /** The real path of the work tree to judge. */
  root: string;
  /** Why git must not be run in `root` (`gitDiscoveryHazard`), if so. */
  hazard: string | undefined;
  timeoutMs: number;
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
}

const STATUS_ORDER: BranchGuardStatus[] = [
  "refused",
  "would_refuse",
  "allowed_protected",
  "detached",
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
 * numbers), with terminal prompts off. */
export function branchGuardEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const drop = new Set<string>([
    ...REPO_SELECTION_ENV_VARS,
    ...REF_FORMAT_ENV_VARS,
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

type GitAnswer =
  | { kind: "exit"; status: number; stdout: string }
  | { kind: "failed"; why: string };

function runGit(
  root: string,
  args: readonly string[],
  timeoutMs: number,
): GitAnswer {
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
  const name = `git ${args.join(" ")}`;
  const e = res.error as NodeJS.ErrnoException | undefined;
  if (isTimeoutError(e)) {
    return {
      kind: "failed",
      why: `${name} did not finish within ${String(timeoutMs)} ms and was stopped`,
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
    input.timeoutMs,
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
    input.timeoutMs,
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
    return settle(
      { ...guard, status: "refused", reason: "protected_branch" },
      `patch refuses to edit on a detached HEAD of ${input.root} (--protect-detached); check out a task branch, or pass --allow-protected to edit here anyway`,
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
  return settle(
    { ...guard, status: "refused", reason: "protected_branch" },
    `patch refuses to edit on the protected branch ${JSON.stringify(branch)} of ${input.root} (protected by: ${via}); switch to a task branch, or pass --allow-protected to edit here anyway`,
    input,
  );
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
