/**
 * Helpers for the approval suites: a repository whose head holds a proposed
 * spec that the final lint passes, with settings on the default branch, and
 * a host adapter made of plain values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
  checkApproval,
  type ApproveReport,
  type ApproveRequest,
  type ConditionNumber,
  type ConditionResult,
} from "../../src/approve/index.js";
import type {
  HostAdapter,
  HostReview,
  ReviewState,
} from "../../src/host/index.js";
import { proposeSpecDir } from "../../src/state/index.js";
import { git } from "../canonical/helpers.js";
import {
  COMMANDS_OK,
  REMOTE_MAIN,
  Repo,
  SPEC_REL,
  rebaseMerge,
  specFiles,
  squashMerge,
} from "../lint/git-helpers.js";
import { validFiles } from "../lint/helpers.js";
import { BIND_BINDINGS, BIND_PLAN, commitSpec } from "../state/helpers.js";

/** Approvers and one agent identity, spelled in another case than the logins the tests use. */
export const CONFIG =
  "approvers: [Alice, bob, dev]\nagent_identities: [Spec-Bot]\n";

/** A repository state the check runs on. */
export interface Scenario {
  /** The repository root. */
  dir: string;
  /** The spec directory. */
  spec: string;
  /** The commit of the default branch that holds the settings; its tip unless `tip` is set. */
  c1: string;
  /** The tip of the default branch, when it moved on after `c1`. */
  tip?: string;
  /** The commit that holds the draft spec. */
  draft: string;
  /** `HEAD`. */
  head: string;
}

export interface Built extends Scenario {
  repo: Repo;
}

export interface BuildOptions {
  /** The text of `.spec-gate/config.yaml`; `null` for none. Default `CONFIG`. */
  config?: string | null;
  /** The text of `.spec-gate/commands.yaml`; `null` for none. Default `COMMANDS_OK`. */
  commands?: string | null;
  /** The test plan of the spec. Default `BIND_PLAN`. */
  plan?: string;
  /** Further files of the settings commit `c1`, such as another spec that is merged already. */
  merged?: Record<string, string>;
  /**
   * A commit on the default branch after `c1`. The default ref is set there
   * and the branch `pr` starts there; the spec still names `c1` as its
   * `base_commit` and `commands_ref`.
   */
  later?: Record<string, string>;
  /** False leaves the spec a draft. */
  propose?: boolean;
}

/**
 * A default branch with the command set and (unless `config` is `null`)
 * `.spec-gate/config.yaml`, `refs/remotes/origin/main` at its tip, and a
 * branch `pr` with a draft spec that is proposed and committed unless
 * `propose` is false.
 */
export async function build(options: BuildOptions = {}): Promise<Built> {
  const repo = await Repo.create();
  await repo.commit({ "README.md": "one\n" }, "init");
  const settings: Record<string, string> = { ...options.merged };
  if (options.commands !== null) {
    settings[".spec-gate/commands.yaml"] = options.commands ?? COMMANDS_OK;
  }
  if (options.config !== null) {
    settings[".spec-gate/config.yaml"] = options.config ?? CONFIG;
  }
  const c1 = await repo.commit(settings, "settings");
  const tip =
    options.later === undefined
      ? c1
      : await repo.commit(options.later, "the default branch moves on");
  await repo.setRef(REMOTE_MAIN, tip);
  await repo.checkout("pr", tip);
  const spec = specFiles({
    base: c1,
    ref: c1,
    plan: options.plan ?? BIND_PLAN,
  });
  spec[`${SPEC_REL}/bindings.yaml`] = BIND_BINDINGS;
  const draft = await repo.commit(spec, "spec");
  let head = draft;
  if (options.propose !== false) head = await propose(repo);
  return {
    repo,
    dir: repo.dir,
    spec: repo.spec,
    c1,
    ...(tip === c1 ? {} : { tip }),
    draft,
    head,
  };
}

/** A `spec.md` that parses, with the given id and status. */
export function otherSpec(id: string, status = "proposed"): string {
  const text = validFiles()["spec.md"]!;
  return text
    .replace(/^id: .*$/m, `id: ${id}`)
    .replace(/^status: .*$/m, `status: ${status}`);
}

/** The second, proposed spec of the stale-base scenarios. */
export const STALE_OTHER = "specs/other/spec.md";

/** The settings of the default branch once `dev` is no approver any more. */
export const CONFIG_WITHOUT_DEV =
  "approvers: [Alice, bob]\nagent_identities: [Spec-Bot]\n";

/**
 * A pull request whose base, as the host reports it, is older than a commit
 * of the default branch its head has merged: the default branch moves on by
 * `files` after `c1`, the default ref is set there, and the branch `pr`
 * merges that commit. `c1` stays the base the host reports (`tip` is not
 * set); `newer` is the commit the default ref names.
 *
 * - `merged-only`: the pull request does nothing after the merge;
 * - `spec-deleted`: the default branch gained a proposed spec, and the pull
 *   request deletes it after the merge;
 * - `config-merged`: the default branch took `dev` off the approvers, and
 *   the pull request does nothing after the merge;
 * - `config-restored`: as before, and the pull request puts
 *   `.spec-gate/config.yaml` back to its text at `c1`.
 */
export async function staleBase(
  kind: "merged-only" | "spec-deleted" | "config-merged" | "config-restored",
): Promise<Built & { newer: string }> {
  const s = await build();
  const gained: Record<string, string> =
    kind === "config-merged" || kind === "config-restored"
      ? { ".spec-gate/config.yaml": CONFIG_WITHOUT_DEV }
      : { [STALE_OTHER]: otherSpec("other-spec") };
  await s.repo.checkout("main");
  const newer = await s.repo.commit(gained, "the default branch moves on");
  await s.repo.setRef(REMOTE_MAIN, newer);
  await s.repo.checkout("pr");
  await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the default", newer);
  let head = await s.repo.head();
  if (kind === "spec-deleted") {
    head = await s.repo.commit({ [STALE_OTHER]: null }, "delete the spec");
  } else if (kind === "config-restored") {
    head = await s.repo.commit(
      { ".spec-gate/config.yaml": CONFIG },
      "put the settings back",
    );
  }
  return { ...s, head, newer };
}

/** The bindings the `relogged` pull request writes in place of the merged ones. */
export const OTHER_BINDINGS = BIND_BINDINGS.replace(
  "selector: login works",
  "selector: login still works",
);

/**
 * A second pull request that replaces a merged `bindings.log`: the spec is
 * proposed and merged into the default branch (`newer`, where the default
 * ref is set); the branch `pr2` starts at `c1`, which the host reports as
 * its base, merges the default branch, commits the spec back to `draft`
 * without its log and with other bindings, and proposes again with the base
 * `c1`. Measured from `c1` there is no merged log to compare with, so that
 * propose writes; measured from the default branch the log was replaced.
 */
export async function relogged(): Promise<Built & { newer: string }> {
  const s = await build();
  await s.repo.checkout("main");
  await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the spec", s.head);
  const newer = await s.repo.head();
  await s.repo.setRef(REMOTE_MAIN, newer);
  await s.repo.checkout("pr2", s.c1);
  await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the default", newer);
  const file = path.join(s.spec, "spec.md");
  const text = fs.readFileSync(file, "utf8");
  if (!/^status: proposed$/m.test(text)) {
    throw new Error("the merged spec is not proposed");
  }
  fs.writeFileSync(file, text.replace(/^status: proposed$/m, "status: draft"));
  await s.repo.commit(
    {
      [`${SPEC_REL}/bindings.log`]: null,
      [`${SPEC_REL}/bindings.yaml`]: OTHER_BINDINGS,
    },
    "back to draft, without the log",
  );
  const result = proposeSpecDir(s.spec, { repo: s.dir, base: s.c1 });
  if (result.kind !== "written") {
    throw new Error(
      `the second propose did not write: ${JSON.stringify(result)}`,
    );
  }
  const head = await commitSpec(s.repo, "propose again");
  return { ...s, head, newer };
}

/**
 * A pull request whose head has two merge bases with the default branch:
 * the default branch gains a commit `d1` and merges a side commit `s1`; the
 * branch `pr` merges `s1` and `d1` separately, so neither is an ancestor of
 * the other and both are merge bases of the head and the default commit
 * `newer`. `later` says which of the two is committed last, so that both
 * orders are covered whichever one git's plain `merge-base` prints.
 *
 * - `spec-deleted`: `d1` adds a proposed spec and the pull request deletes
 *   it. The tree of `s1` does not hold it;
 * - `config-restored`: `d1` takes `dev` off the approvers and the pull
 *   request puts the settings back to their text at `c1`, which is their
 *   text at `s1`.
 */
export async function crissCross(
  kind: "spec-deleted" | "config-restored",
  later: "side" | "default",
): Promise<Built & { newer: string; bases: [string, string] }> {
  const s = await build();
  const onDefault = async (): Promise<string> => {
    await s.repo.checkout("main");
    return s.repo.commit(
      kind === "config-restored"
        ? { ".spec-gate/config.yaml": CONFIG_WITHOUT_DEV }
        : { [STALE_OTHER]: otherSpec("other-spec") },
      "the default branch moves on",
    );
  };
  const onSide = async (): Promise<string> => {
    await s.repo.checkout("side", s.c1);
    return s.repo.commit({ "side.txt": "side\n" }, "a side commit");
  };
  let d1: string;
  let s1: string;
  if (later === "side") {
    d1 = await onDefault();
    s1 = await onSide();
  } else {
    s1 = await onSide();
    d1 = await onDefault();
  }
  await s.repo.checkout("main");
  await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the side", s1);
  const newer = await s.repo.head();
  await s.repo.setRef(REMOTE_MAIN, newer);
  await s.repo.checkout("pr");
  await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the side", s1);
  await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the default", d1);
  const head = await s.repo.commit(
    kind === "config-restored"
      ? { ".spec-gate/config.yaml": CONFIG }
      : { [STALE_OTHER]: null },
    kind === "config-restored" ? "put the settings back" : "delete the spec",
  );
  return { ...s, head, newer, bases: [d1, s1] };
}

/** How a test merges a pull request into the default branch. */
export type MergeHow = "merge-commit" | "squash" | "rebase";

/** The unrelated commits `land` puts on the default branch before a merge. */
export const FILLERS = 5;

/** The first-parent chain of `commit` in `dir`, `commit` first, `count` commits. */
export async function chainOf(
  dir: string,
  commit: string,
  count: number,
): Promise<string[]> {
  const out = await git(dir, [
    "rev-list",
    "--first-parent",
    `--max-count=${count}`,
    commit,
  ]);
  return out.split("\n");
}

/** The first-parent steps below `commit`, the last one first, as ranges. */
export async function stepsOf(
  dir: string,
  commit: string,
  steps: number,
): Promise<{ from: string; to: string }[]> {
  const chain = await chainOf(dir, commit, steps + 1);
  return chain.slice(0, -1).map((to, i) => ({ from: chain[i + 1]!, to }));
}

/**
 * A merged pull request: the scenario after its merge. `head` stays the
 * head commit of the pull request, which the host reports and the reviews
 * stand on; the checkout is on `main` at `landed`.
 */
export interface Landed extends Scenario {
  /** The commit the merge put on the default branch, as the host reports it. */
  merge: string;
  /** The commit the default ref names. */
  landed: string;
}

/**
 * Merges the branch `pr` of `s` into `main` the way a host does: `main`
 * first moves on by an unrelated commit, then a merge commit whose second
 * parent is the head, one squashed commit, or the commits of the branch
 * replayed. The default ref is set to the result and `main` is checked out
 * there. The base the host reports stays `c1`, which is older than the
 * first parent of the merge: before the merge `main` moves on by
 * `FILLERS` unrelated commits and one more, so that a pull request of up
 * to that many commits has only unrelated commits of the default branch
 * in the first-parent steps the check measures.
 */
export async function land(s: Built, how: MergeHow): Promise<Built & Landed> {
  const head = await s.repo.sh("rev-parse", "pr");
  await s.repo.checkout("main");
  for (let i = 1; i <= FILLERS; i += 1) {
    await s.repo.commit({ [`filler-${i}.txt`]: `${i}\n` }, `filler ${i}`);
  }
  let merge: string;
  if (how === "squash") merge = await squashMerge(s.repo, "pr");
  else if (how === "rebase") merge = await rebaseMerge(s.repo, "pr");
  else {
    await s.repo.checkout("main");
    await s.repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge pr", head);
    merge = await s.repo.head();
    await s.repo.setRef(REMOTE_MAIN, merge);
  }
  return { ...s, head, merge, landed: merge };
}

/** Commits `files` on `main` after the merge and moves the default ref there. */
export async function afterMerge(
  m: Built & Landed,
  files: Record<string, string | null>,
  message = "the default branch moves on after the merge",
): Promise<Built & Landed> {
  await m.repo.checkout("main");
  const landed = await m.repo.commit(files, message);
  await m.repo.setRef(REMOTE_MAIN, landed);
  return { ...m, landed };
}

/** The settings of the default branch once `alice` is no approver any more. */
export const CONFIG_ONLY_BOB =
  "approvers: [bob]\nagent_identities: [Spec-Bot]\n";

/**
 * A squash merge that carries its own change to the settings, which the
 * head of the pull request never made: the default branch took `alice` off
 * the approvers after `c1`, the base the host reports, and the squashed
 * commit puts `.spec-gate/config.yaml` back to its text at `c1`. Nothing
 * under `.spec-gate/` differs between `c1` and the squashed commit, or
 * between `c1` and the head; only the first parent of the squashed commit
 * shows the change, and no other commit of the measured steps does.
 */
export async function squashWithOwnSettings(): Promise<Built & Landed> {
  const s = await build();
  await s.repo.checkout("main");
  await s.repo.commit(
    { ".spec-gate/config.yaml": CONFIG_ONLY_BOB },
    "alice is no approver any more",
  );
  // An unrelated commit in between: of the first-parent steps the check
  // measures for this pull request of two commits, only the squashed commit
  // itself changes the settings.
  await s.repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
  await s.repo.sh("merge", "-q", "--squash", "pr");
  const merge = await s.repo.commit(
    { ".spec-gate/config.yaml": CONFIG },
    "squash pr",
  );
  await s.repo.setRef(REMOTE_MAIN, merge);
  return { ...s, merge, landed: merge };
}

/** Changes the normative layer of the spec in the work tree of `dir`. */
export function editSpec(dir: string): void {
  const file = path.join(dir, SPEC_REL, "spec.md");
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("HTTP 401")) throw new Error("nothing to edit");
  fs.writeFileSync(file, text.replace("HTTP 401", "HTTP 403"));
}

/**
 * A squash merge whose one commit holds another normative layer than the
 * head that was approved: the spec is edited between the squash and its
 * commit.
 */
export async function squashEdited(): Promise<Built & Landed> {
  const s = await build();
  await s.repo.checkout("main");
  await s.repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
  await s.repo.sh("merge", "-q", "--squash", "pr");
  editSpec(s.dir);
  const merge = await s.repo.commit({}, "squash pr");
  await s.repo.setRef(REMOTE_MAIN, merge);
  return { ...s, merge, landed: merge };
}

/** As `keep`, for a merged pull request. */
export function keepLanded(m: Landed): Landed {
  return { ...keep(m), merge: m.merge, landed: m.landed };
}

/** The pull request of `m` as the host reports it after the merge. */
export function landedPull(
  m: Landed,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return pullRequestOf(m, { merged: true, mergeCommit: m.merge, ...over });
}

/**
 * Runs the check after the merge for `m`: the host reports the pull request
 * as merged with the merge commit of `m`, and an approval by `alice` on its
 * head, unless `says` changes it.
 */
export async function checkLanded(
  m: Landed,
  says: HostSays = {},
  over: Partial<ApproveRequest> = {},
): Promise<ApproveReport> {
  return check(
    m,
    { pullRequest: landedPull(m), ...says },
    { merged: true, ...over },
  );
}

/** Proposes the draft at `HEAD` and commits the result. */
export async function propose(repo: Repo): Promise<string> {
  const result = proposeSpecDir(repo.spec, {
    repo: repo.dir,
    defaultRef: REMOTE_MAIN,
  });
  if (result.kind !== "written") {
    throw new Error(`propose did not write: ${JSON.stringify(result)}`);
  }
  return commitSpec(repo, "propose");
}

const kept: string[] = [];

afterAll(() => {
  for (const dir of kept.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A copy of a built repository that outlives the test that built it (the
 * scratch directories of the lint helpers go after every test), for the
 * cases that only change what the host says. Removed after the file.
 */
export function keep(built: Scenario): Scenario {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-approve-"));
  kept.push(root);
  const dir = path.join(root, "repo");
  fs.cpSync(built.dir, dir, { recursive: true });
  return {
    dir,
    spec: path.join(dir, SPEC_REL),
    c1: built.c1,
    ...(built.tip === undefined ? {} : { tip: built.tip }),
    draft: built.draft,
    head: built.head,
  };
}

/** A review submitted at minute `minute` of one fixed hour. */
export function review(
  login: string,
  state: ReviewState,
  commit: string,
  minute = 0,
): HostReview {
  return {
    login,
    state,
    commit,
    submittedAt: `2024-05-01T10:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/**
 * What the fake host says. Each entry is the value its method resolves to,
 * or a function that is called instead (to throw, or to return anything).
 */
export interface HostSays {
  pullRequest?: unknown;
  reviews?: unknown;
  /** One value for both paths, or one per path. */
  enforcement?: unknown;
  configCommit?: unknown;
}

export type FakeHost = HostAdapter & { calls: string[] };

const give = (value: unknown): unknown =>
  typeof value === "function" ? (value as () => unknown)() : value;

/**
 * A host for `s` on which everything holds unless `says` changes it: a pull
 * request by `dev` from the head to the default branch, one approval by
 * `alice` on the head, both paths enforced.
 */
export function hostFor(s: Scenario, says: HostSays = {}): FakeHost {
  const calls: string[] = [];
  const has = (key: keyof HostSays) => Object.hasOwn(says, key);
  const facts = {
    pullRequest: has("pullRequest") ? says.pullRequest : pullRequestOf(s),
    reviews: has("reviews")
      ? says.reviews
      : [review("alice", "APPROVED", s.head)],
    enforcement: has("enforcement") ? says.enforcement : "enforced",
    configCommit: has("configCommit")
      ? says.configCommit
      : { commit: s.c1, approver: "bob" },
  };
  return {
    calls,
    pullRequest: async () => {
      calls.push("pullRequest");
      return give(facts.pullRequest) as never;
    },
    reviews: async () => {
      calls.push("reviews");
      return give(facts.reviews) as never;
    },
    reviewEnforcement: async (reviewPath) => {
      calls.push(`reviewEnforcement ${reviewPath}`);
      const all = give(facts.enforcement);
      return (
        typeof all === "object" && all !== null
          ? give((all as Record<string, unknown>)[reviewPath])
          : all
      ) as never;
    },
    lastConfigCommit: async () => {
      calls.push("lastConfigCommit");
      return give(facts.configCommit) as never;
    },
    ciRunStatus: async () => {
      calls.push("ciRunStatus");
      throw new Error("the approval check does not ask for a CI run");
    },
  };
}

/** The pull request of `s` as the host reports it when all is well. */
export function pullRequestOf(
  s: Scenario,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 7,
    author: "dev",
    head: s.head,
    base: s.tip ?? s.c1,
    targetRef: "refs/heads/main",
    merged: false,
    mergeCommit: null,
    ...over,
  };
}

export function requestFor(
  s: Scenario,
  host: HostAdapter,
  over: Partial<ApproveRequest> = {},
): ApproveRequest {
  return {
    repo: s.dir,
    specDir: s.spec,
    defaultRef: REMOTE_MAIN,
    host,
    ...over,
  };
}

/** Runs the check and returns its report; a refusal throws. */
export async function check(
  s: Scenario,
  says: HostSays = {},
  over: Partial<ApproveRequest> = {},
): Promise<ApproveReport> {
  const result = await checkApproval(requestFor(s, hostFor(s, says), over));
  if (result.kind !== "report") {
    throw new Error(`the check refused: ${result.message}`);
  }
  return result.report;
}

/** A change a test makes to the spec directory `spec` of a work tree. */
// The base no-unused-vars rule reads the names in a signature as variables.
// eslint-disable-next-line no-unused-vars
export type SpecChange = (spec: string) => void;

/** A way a test merges the pull request of `s`, whose head is `head`. */
// eslint-disable-next-line no-unused-vars
export type Merge = (s: Built, head: string) => Promise<void>;

export const cond = (
  report: ApproveReport,
  condition: ConditionNumber,
): ConditionResult => report.conditions[condition - 1]!;

/** The code of every condition, in order. */
export const codes = (report: ApproveReport): string[] =>
  report.conditions.map((c) => c.code);

/** The numbers of the conditions that do not hold. */
export const failing = (report: ApproveReport): number[] =>
  report.conditions.filter((c) => !c.ok).map((c) => c.condition);
