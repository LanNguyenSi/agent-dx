/**
 * `checkApproval`: is this spec approved?
 *
 * The tree knows `draft` and `proposed` only; "approved" is derived here,
 * from facts a host adapter supplies and from git reads at fixed commits.
 * What a pull request changes is measured from one base, the one merge base
 * of the head and the tip of the default branch (`measureOf`); a base commit
 * the caller gives is only compared with the base the host reports.
 * It holds only when all eight conditions hold (see `CONDITIONS` and
 * `docs/approve.md`). The check never fetches, never writes and never reads
 * text a pull request author controls: the settings come from git at the
 * commit the default ref names (the tip of the default branch, with or
 * without a base commit given), the digests from git at the head and at the
 * commit of a review, and who reviewed what comes from the host.
 *
 * With `merged: true` the check runs after the merge instead (the merged
 * mode): the pull request must be merged, the spec is judged at the tip of
 * the default branch, the approval is looked for on the head commit the
 * host reports, and what the pull request changed is measured over the
 * ranges `landingOf` derives from its merge commit, never from a base
 * commit.
 *
 * A condition that could not be evaluated does not hold. A host method that
 * throws or returns something else than its type is `host-failed`, a git
 * read that fails is `git-failed`; neither is ever a pass.
 */
import fs from "node:fs";
import path from "node:path";
import { SPEC_FILE } from "../canonical/index.js";
import { validateConfig, type SpecGateConfig } from "../formats/index.js";
import { REVIEW_PATHS, type HostPullRequest } from "../host/index.js";
import { loadConfigAtReference } from "../lint/git/config.js";
import {
  LintGitError,
  isAncestor,
  isCommit,
  resolveHead,
  resolveRef,
} from "../lint/git/index.js";
import { resolveGitInputs, type GitRequest } from "../lint/git/resolve.js";
import { checkSpecChangesConfig } from "../lint/rules/refs.js";
import { lintSpecDir } from "../lint/run.js";
import type { GitInputs, Loaded, RuleContext } from "../lint/types.js";
import { checkRepository, type RepoCheckFinding } from "../repo/index.js";
import {
  SPECS_DIR,
  isRepoPath,
  isSpecLayoutPath,
  repoPathOf,
  specPathIn,
} from "../state/git.js";
import { arrives, standingOf } from "./binding.js";
import { readHostFacts, type Fact, type HostFacts } from "./facts.js";
import { landingOf, type Landing, type LandingResult } from "./landing.js";
import {
  isShallow,
  mergeBases,
  specCommandsAt,
  specDigestAt,
  specDirMatchesCommit,
  specStateAt,
} from "./git.js";
import { allowlisted, sameAccount } from "./logins.js";
import { standingApprovals, type StandingApproval } from "./reviews.js";
import {
  APPROVE_FORMAT,
  COMMANDS_GAP,
  CONDITIONS,
  GAPS,
  OK_CODE,
  type ApproveMode,
  type ApproveReport,
  type ApproveRequest,
  type ApproveResult,
  type ApproverProblem,
  type ConditionNumber,
  type ConditionResult,
  type FailureCode,
  type Gap,
  type ReportedApproval,
} from "./types.js";

type Failure = { ok: false; code: FailureCode; message: string };
type Outcome = { ok: true; message: string } | Failure;

const holds = (message: string): Outcome => ({ ok: true, message });
const fails = (code: FailureCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});

const HOST_FAILED = (what: string): Failure =>
  fails(
    "host-failed",
    `the host adapter did not report ${what}; a fact the host did not give is never assumed`,
  );

/** Everything the conditions read, resolved once. */
interface Subject {
  request: ApproveRequest;
  /** The spec directory, absolute. */
  dir: string;
  /** The spec directory in the repository, `specs/<name>`. */
  specPath: string;
  /**
   * The git inputs as the caller gave them, `base` included. Conditions read
   * `repo` and `head` from it, and condition 2 compares `reference` with the
   * base the host reports. No condition measures a change from its
   * `reference` or its `diffBase`: that is what `spans` is for.
   */
  git: GitInputs;
  /** `merged` for the check after the merge. */
  mode: ApproveMode;
  /**
   * Why the history of the repository cannot be relied on (it is shallow,
   * or git could not say), or `null`. Every condition that reads ancestry
   * fails with it.
   */
  history: Failure | null;
  /** After the merge: where the pull request landed, when that could be derived. */
  landing: Landing | null;
  /** The commit `defaultRef` names. */
  defaultCommit: string;
  /**
   * The commit whose spec is judged: the head in the open mode, the commit
   * `defaultRef` names in the merged mode.
   */
  at: string;
  /**
   * What the pull request changes, as ranges to measure, or why there is
   * none. In the open mode it is one range, from the measuring base to the
   * head, and conditions 4, 7 and 8 use it. In the merged mode they are the
   * ranges of the merge, and conditions 2, 7 and 8 use them.
   */
  spans: Spans;
  facts: HostFacts;
  /** The settings at `defaultCommit`; the format defaults when the file is absent. */
  config: SpecGateConfig | null;
  /** The approvals that stand, or the host failure. */
  standing: Fact<StandingApproval[]>;
  /**
   * The commit an approval must stand on: the head of the checkout in the
   * open mode, the head commit the host reports for the pull request in the
   * merged mode (`null` when the host did not report the pull request).
   */
  approvedHead: string | null;
  /** The approvals that stand on `approvedHead`. */
  atHead: StandingApproval[];
}

/** The ranges the conditions measure, each as the git inputs of a rule, or why there is none. */
type Spans =
  { ok: true; ranges: GitInputs[] } | { ok: false; outcome: Failure };

function refuse(message: string): ApproveResult {
  return { kind: "refused", message: `approve-check: ${message}` };
}

/** The settings a repository without a config file has. */
function defaultConfig(): SpecGateConfig {
  const parsed = validateConfig({});
  if (!parsed.ok) throw new Error("the default config does not validate");
  return parsed.value;
}

function configOf(loaded: Loaded<SpecGateConfig>): SpecGateConfig | null {
  if (loaded.state === "failed") return null;
  return loaded.state === "ok" ? loaded.value : defaultConfig();
}

/**
 * Whether the branch a pull request targets (`refs/heads/<branch>` on the
 * host) is the branch `defaultRef` holds in the checkout: that same name, or
 * the remote-tracking ref of that branch under a remote whose name has no
 * `/`.
 */
export function targetsDefault(targetRef: string, defaultRef: string): boolean {
  const heads = "refs/heads/";
  if (!targetRef.startsWith(heads)) return false;
  if (defaultRef === targetRef) return true;
  const tracking = /^refs\/remotes\/[^/]+\/(.+)$/s.exec(defaultRef);
  return tracking !== null && tracking[1] === targetRef.slice(heads.length);
}

/** Why `login` does not count as an approver, or `null` when it does. */
function approverProblem(
  login: string,
  config: SpecGateConfig,
  pullRequest: HostPullRequest,
): ApproverProblem | null {
  if (config.agent_identities.some((agent) => sameAccount(agent, login))) {
    return "is-agent";
  }
  if (sameAccount(login, pullRequest.author)) return "is-author";
  if (!allowlisted(login, config.approvers)) return "not-allowlisted";
  return null;
}

function problemOf(s: Subject, login: string): ApproverProblem | null {
  if (s.config === null || !s.facts.pullRequest.ok) return "not-evaluated";
  return approverProblem(login, s.config, s.facts.pullRequest.value);
}

const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** The commit that is judged, in the words of a message. */
const whereOf = (s: Subject): string =>
  s.mode === "merged" ? "the tip of the default branch" : "the head commit";

/** 1: an approving review stands on the head. */
function approvalAtHead(s: Subject): Outcome {
  if (!s.facts.pullRequest.ok) return HOST_FAILED("the pull request");
  if (!s.standing.ok) return HOST_FAILED("the reviews");
  if (s.mode === "merged") {
    // After the merge the checkout is at the tip of the default branch, not
    // at the head of the pull request: the approval is looked for on the
    // head commit the host reports, and only for a merged pull request.
    if (!s.spans.ok && s.spans.outcome.code === "not-merged") {
      return s.spans.outcome;
    }
  } else if (s.facts.pullRequest.value.head !== s.git.head) {
    return fails(
      "head-mismatch",
      "the checkout is not at the head commit of the pull request; check out that commit, not a merge of it",
    );
  }
  if (s.standing.value.length === 0) {
    return fails("no-approval", "no approving review stands");
  }
  if (s.atHead.length === 0) {
    return fails(
      "approval-stale",
      `${count(s.standing.value.length, "approving review stands", "approving reviews stand")}, none on the head commit; a review of an older commit does not count`,
    );
  }
  return holds(
    `${count(s.atHead.length, "approving review stands", "approving reviews stand")} on the head commit`,
  );
}

/** 2: an approver of the head is allowed, by settings the pull request cannot write. */
function approverAllowed(s: Subject): Outcome {
  if (s.history !== null) return s.history;
  if (!s.facts.pullRequest.ok) return HOST_FAILED("the pull request");
  if (!s.standing.ok) return HOST_FAILED("the reviews");
  const config = s.config;
  if (config === null) {
    return fails(
      "config-invalid",
      ".spec-gate/config.yaml at the tip of the default branch cannot be read or does not parse",
    );
  }
  const pullRequest = s.facts.pullRequest.value;
  if (!targetsDefault(pullRequest.targetRef, s.request.defaultRef)) {
    return fails(
      "target-not-default",
      "the pull request does not target the branch the default ref holds; a spec is approved for the default branch only",
    );
  }
  if (s.request.base !== undefined) {
    if (pullRequest.base !== s.git.reference) {
      return fails(
        "base-mismatch",
        "the base commit the host reports is not the base commit the check was given",
      );
    }
  } else if (
    !isCommit(s.git.repo, pullRequest.base) ||
    !isAncestor(s.git.repo, pullRequest.base, s.defaultCommit)
  ) {
    return fails(
      "base-not-on-default",
      "the base commit the host reports is not on the default ref of the checkout; the default branch may need to be fetched by the job",
    );
  }
  if (s.mode === "merged") {
    // After the merge the tip of the default branch holds the pull request,
    // so the settings read there are trusted only when no range of the
    // merge wrote under `.spec-gate/`. That takes the place of
    // `head-in-reference`.
    if (!s.spans.ok) return s.spans.outcome;
    const changed = configChanges(s.spans.ranges);
    if (changed === null) return CONFIG_NOT_READ;
    if (changed.length > 0) {
      return fails(
        "config-in-merge",
        `${count(changed.length, "path", "paths")} under .spec-gate/ changed over a range of the merge: the settings at the tip of the default branch may be the pull request's own, and who may approve is not taken from them`,
      );
    }
  } else if (isAncestor(s.git.repo, s.git.head, s.defaultCommit)) {
    // The settings are trusted because the pull request did not write the
    // commit they are read at, the tip of the default branch. A head that
    // commit already contains (a merged pull request, a branch without a
    // commit of its own) breaks that: its changes to the settings would be
    // read as the settings. A base commit given does not change this.
    return fails(
      "head-in-reference",
      "the head commit is the tip of the default branch or an ancestor of it: the settings read there may be the pull request's own, and a merged pull request is not judged by this check",
    );
  }
  if (s.atHead.length === 0) {
    return fails(
      "no-approval",
      "no approving review stands on the head commit, so there is no approver to check",
    );
  }
  const verdicts = s.atHead.map((approval) => ({
    login: approval.login,
    problem: approverProblem(approval.login, config, pullRequest),
  }));
  const allowed = verdicts.filter((v) => v.problem === null);
  if (allowed.length === 0) {
    return fails(
      "approver-not-qualified",
      `no approver of the head commit counts: ${verdicts.map((v) => `${v.login} (${v.problem})`).join(", ")}`,
    );
  }
  return holds(
    `${allowed.map((v) => v.login).join(", ")} approved the head commit, is in approvers, is not the author and is not an agent identity`,
  );
}

/**
 * 3: the digest at the commit that is judged (the head, or after the merge
 * the tip of the default branch) is the digest that was approved.
 */
function digestUnchanged(s: Subject, headDigest: string | null): Outcome {
  if (!s.standing.ok) return HOST_FAILED("the reviews");
  const subjects = s.atHead.length > 0 ? s.atHead : s.standing.value;
  if (subjects.length === 0) {
    return fails(
      "no-approval",
      "no approving review stands, so there is no approved digest to compare",
    );
  }
  if (headDigest === null) {
    return fails(
      "digest-unavailable",
      `no digest exists for the spec at ${whereOf(s)}`,
    );
  }
  const commits = [...new Set(subjects.map((approval) => approval.commit))]
    .filter((commit) => commit !== s.at)
    .sort();
  for (const commit of commits) {
    if (!isCommit(s.git.repo, commit)) {
      return fails(
        "review-commit-unavailable",
        `the commit ${commit} of an approving review is not in the repository; the check never fetches`,
      );
    }
    const digest = specDigestAt(s.git.repo, commit, s.specPath);
    if (digest === null) {
      return fails(
        "review-digest-unavailable",
        `no digest exists for the spec at the commit ${commit} of an approving review`,
      );
    }
    if (
      s.mode === "merged" &&
      specStateAt(s.git.repo, commit, s.specPath)?.status !== "proposed"
    ) {
      // The status is no part of the digest. Before the merge condition 4
      // reads it at the head, which is where a counted approval stands;
      // after the merge it reads it at the tip, so the reviewed commit is
      // asked here: an approval of a draft approves no spec.
      return fails(
        "review-not-proposed",
        `the spec is not proposed at the commit ${commit} of an approving review; an approval of a draft does not count, whatever status the default branch gave the spec later`,
      );
    }
    if (digest !== headDigest) {
      // After the merge both sides are named: the reader has no checkout of
      // the reviewed commit to compute the second one from.
      return s.mode === "merged"
        ? fails(
            "digest-mismatch-after-merge",
            `the digest ${headDigest} at the tip of the default branch ${s.at} differs from the digest ${digest} at the commit ${commit} of an approving review: what is on the default branch is not what was approved`,
          )
        : fails(
            "digest-mismatch",
            `the digest at the head differs from the digest at the commit ${commit} of an approving review`,
          );
    }
  }
  if (s.landing !== null) {
    const unbound = bindingProblem(s, s.landing, headDigest);
    if (unbound !== null) return unbound;
  }
  return holds(
    s.mode === "merged"
      ? "the digest at the tip of the default branch equals the digest at the commit of every approving review considered, the spec is proposed at each of them, and the pull request brought the spec to that state"
      : "the digest at the head equals the digest at the commit of every approving review considered",
  );
}

/**
 * Why the merged pull request is not the one that brought this spec, or
 * `null` when it is.
 *
 * The state judged at the tip is "proposed, with the digest at the tip"
 * (`tipDigest`). The pull request brought the spec when that state arrives
 * twice (see `arrives` in `binding.ts`):
 *
 * - over the reviewed commits: from the one merge base of the approved head
 *   with the first parent of the merge commit to that head. For a merge
 *   commit with one parent the landing already holds that base; for a merge
 *   commit with two it is read here and used here alone, so the ranges of
 *   conditions 2, 7 and 8 stay what they are. No merge base and several
 *   fail closed;
 * - on the default branch: over some measured first-parent step, each asked
 *   on its own.
 *
 * What this does not say: that the approver was shown the change. An
 * approval given before the default branch moved under the pull request
 * counts like any other; the check reads no fact about that order.
 */
function bindingProblem(
  s: Subject,
  landing: Landing,
  tipDigest: string,
): Failure | null {
  const repo = s.git.repo;
  const standingAt = (commit: string) =>
    standingOf(
      specStateAt(repo, commit, s.specPath),
      specDigestAt(repo, commit, s.specPath),
      tipDigest,
    );
  const steps = landing.ranges.slice(0, landing.commits);
  if (
    !steps.some((step) => arrives(standingAt(step.from), standingAt(step.to)))
  ) {
    return fails(
      "spec-not-in-merge",
      "no measured step of the default branch brought this spec to the state judged at the tip (proposed, with the digest at the tip): the pull request is not the one that brought it, and its approval is not an approval of this spec",
    );
  }
  let base = landing.reviewedBase;
  if (base === null) {
    const bases = mergeBases(repo, landing.head, landing.firstParent);
    if (bases.length === 0) {
      return fails(
        "git-failed",
        "the head commit of the pull request and the first parent of its merge commit share no history; what the reviewed commits brought is not known",
      );
    }
    if (bases.length > 1) {
      return fails(
        "ambiguous-merge-base",
        `the head commit of the pull request and the first parent of its merge commit have ${bases.length} merge bases; what the reviewed commits brought is not read from one of several`,
      );
    }
    base = bases[0]!;
  }
  if (!arrives(standingAt(base), standingAt(landing.head))) {
    return fails(
      "spec-not-in-merge",
      "the reviewed commits did not bring this spec to the state judged at the tip: at the approved head it is not proposed with the digest at the tip, or at the merge base of that head with the default branch it already was. The approval is not an approval of this spec",
    );
  }
  return null;
}

/**
 * 4: `proposed` at the commit that is judged, and the final lint there is
 * clean. In the open mode the lint measures from the measuring base, never
 * from a base commit given. In the merged mode the checkout must be at the
 * tip of the default branch, and the lint compares that tip with itself.
 */
function proposedAndClean(
  s: Subject,
  state: { status: string } | null,
): Outcome {
  if (state === null) {
    return fails(
      "spec-unreadable",
      `${SPEC_FILE} at ${whereOf(s)} is missing, is not a regular file or does not parse`,
    );
  }
  if (state.status !== "proposed") {
    return fails(
      "status-not-proposed",
      `the status at ${whereOf(s)} is ${state.status}; only a proposed spec is approved`,
    );
  }
  if (s.mode === "merged" && s.git.head !== s.defaultCommit) {
    // The lint takes its git view from `HEAD` and its files from the work
    // tree; both must be the tip that is judged.
    return fails(
      "checkout-not-default-tip",
      "the checkout is not at the commit the default ref names; after the merge the check judges the tip of the default branch and the lint reads the checkout",
    );
  }
  if (!specDirMatchesCommit(s.git.repo, s.at, s.specPath, s.dir)) {
    return fails(
      "worktree-not-head",
      `the spec directory of the work tree is not, byte for byte, the one ${whereOf(s)} holds; the lint would judge other files`,
    );
  }
  if (s.history !== null) return s.history;
  // After the merge the lint measures nothing from the pull request, so no
  // range is needed for it.
  if (s.mode === "open" && !s.spans.ok) return s.spans.outcome;
  // The lint is given the default ref and never the base commit. It then
  // resolves its reference to the default commit and its diff base to the
  // merge base of the head with it, which is the measuring base: there is
  // exactly one, or the line above returned.
  const request: GitRequest = {
    repo: s.request.repo,
    defaultRef: s.request.defaultRef,
  };
  const lint = lintSpecDir(s.dir, { final: true, git: request });
  if (!lint.ok) {
    return fails("lint-failed", "the final lint could not run");
  }
  if (!lint.report.ok || lint.report.counts.errors > 0) {
    const rules = [...new Set(lint.report.errors.map((f) => f.rule))].sort();
    return fails(
      "lint-errors",
      `the final lint reports ${count(lint.report.counts.errors, "error", "errors")}: ${rules.join(", ")}`,
    );
  }
  if (resolveHead(s.git.repo) !== s.git.head) {
    return fails("head-moved", "HEAD moved while the check ran");
  }
  return holds(
    `the status at ${whereOf(s)} is proposed and the final lint has no error`,
  );
}

/** 5: agent identities are configured and are not approvers. */
function agentIdentitiesSeparate(s: Subject): Outcome {
  if (s.config === null) {
    return fails(
      "config-invalid",
      ".spec-gate/config.yaml at the tip of the default branch cannot be read or does not parse",
    );
  }
  const { agent_identities: agents, approvers } = s.config;
  if (agents.length === 0) {
    return fails(
      "approval-not-verifiable",
      "agent_identities is empty at the tip of the default branch: nothing tells an agent's approve from a person's",
    );
  }
  const both = agents.filter((agent) =>
    approvers.some((approver) => sameAccount(agent, approver)),
  );
  if (both.length > 0) {
    return fails(
      "approval-not-verifiable",
      `an agent identity is also an approver at the tip of the default branch: ${[...both].sort().join(", ")}`,
    );
  }
  return holds(
    "agent_identities is not empty and shares no account with approvers",
  );
}

/** 6: the host enforces the review for both paths. */
function reviewEnforced(s: Subject): Outcome {
  for (const reviewPath of REVIEW_PATHS) {
    if (!s.facts.enforcement[reviewPath].ok) {
      return HOST_FAILED(`the review enforcement for ${reviewPath}`);
    }
  }
  if (!s.facts.configCommit.ok) {
    return HOST_FAILED("the last change under .spec-gate/");
  }
  const states = REVIEW_PATHS.map((reviewPath) => {
    const fact = s.facts.enforcement[reviewPath];
    return { path: reviewPath, state: fact.ok ? fact.value : "unknown" };
  });
  if (states.some((entry) => entry.state !== "enforced")) {
    return fails(
      "approval-not-enforced",
      `a review is not enforced for every path (${states.map((entry) => `${entry.path}: ${entry.state}`).join(", ")}); ${states
        .filter((entry) => entry.state !== "enforced")
        .map((entry) =>
          entry.state === "unknown"
            ? `${entry.path} the host could not read whether a review is enforced (a workflow token cannot read classic branch protection, and a branch without classic protection answers the same way; a ruleset that requires a review is readable with a token that can read the repository; see "Token and permissions" in docs/approve.md)`
            : `${entry.path} the host reports no required review`,
        )
        .join("; ")}; unknown counts as not enforced`,
    );
  }
  return holds(`the host enforces a review for ${REVIEW_PATHS.join(" and ")}`);
}

/**
 * The measuring base: what conditions 4, 7 and 8 measure the pull request
 * from. It is derived once, and those conditions use nothing else.
 */
type Measure =
  | {
      ok: true;
      /** The head against the default commit, the diff base their one merge base. */
      git: GitInputs;
    }
  | { ok: false; outcome: Failure };

/**
 * Derives the measuring base: the one merge base of the head and the commit
 * the default ref names.
 *
 * A base commit given by the caller is not it. A base says where the pull
 * request started, and a host can report one that is older than a default
 * commit the head has merged since. Measured from that older commit, a file
 * the pull request puts back to its old content shows no change, a spec the
 * default branch gained in between is not in the tree a walk starts from,
 * and a log merged in between is not there to be compared with. Measured
 * from the default branch, all three show.
 *
 * With more than one merge base there is no commit to measure from: git
 * would pick one, the check cannot rely on which, and from one whose tree
 * lacks a spec the deletion of that spec does not show while a merge still
 * makes it. That is `ambiguous-merge-base`, and nothing is measured. No
 * merge base and a failed read are `git-failed`.
 */
function measureOf(git: GitInputs, defaultCommit: string): Measure {
  let bases: string[];
  try {
    bases = mergeBases(git.repo, git.head, defaultCommit);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return {
      ok: false,
      outcome: fails(
        "git-failed",
        `the repository could not be read (${err.code}); the merge base of the head with the default branch is not known and nothing is measured from a guess`,
      ),
    };
  }
  if (bases.length === 0) {
    return {
      ok: false,
      outcome: fails(
        "git-failed",
        "the head and the tip of the default branch share no history; there is no commit to measure the pull request from",
      ),
    };
  }
  if (bases.length > 1) {
    return {
      ok: false,
      outcome: fails(
        "ambiguous-merge-base",
        `the head and the tip of the default branch have ${bases.length} merge bases; the pull request is not measured from one of several. Merge the tip of the default branch into the pull request branch, or rebase onto it, so that one remains`,
      ),
    };
  }
  return {
    ok: true,
    git: {
      repo: git.repo,
      reference: defaultCommit,
      diffBase: bases[0]!,
      head: git.head,
    },
  };
}

/**
 * Why the history of `repo` cannot be relied on, or `null` when it can. In a
 * shallow repository a commit at the boundary shows no parents and a merge
 * base can be older than the true one, from which a file put back to its
 * older text shows no change: nothing is measured there.
 */
function historyProblem(repo: string): Failure | null {
  let shallow: boolean;
  try {
    shallow = isShallow(repo);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return fails(
      "git-failed",
      `the repository could not be read (${err.code}); whether its history is complete is not known`,
    );
  }
  return shallow
    ? fails(
        "shallow-repository",
        "the repository is shallow: its history ends at a boundary, where a commit shows no parents and a merge base can be older than the true one. Nothing is measured in it; the job must check out the full history",
      )
    : null;
}

/** The one range of the open mode: from the measuring base to the head. */
function openSpans(measure: Measure): Spans {
  return measure.ok ? { ok: true, ranges: [measure.git] } : measure;
}

/**
 * The ranges of the merged mode, and the landing they come from: where the
 * merged pull request `pull` landed on the branch whose tip is
 * `defaultCommit` (see `landingOf`). They are derived from git and from the
 * head and the merge commit the host reports, and from nothing else: no
 * base commit of the caller or of the host is a start of a range.
 *
 * A pull request the host did not report is `host-failed`, a git read that
 * fails is `git-failed`, and a landing that cannot be derived keeps its own
 * code. None of them leaves a range to measure.
 */
function landedOf(
  repo: string,
  pull: HostPullRequest | null,
  defaultCommit: string,
): { spans: Spans; landing: Landing | null } {
  const none = (outcome: Failure) => ({
    spans: { ok: false, outcome } as const,
    landing: null,
  });
  if (pull === null) return none(HOST_FAILED("the pull request"));
  let result: LandingResult;
  try {
    result = landingOf(repo, pull, defaultCommit);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return none(
      fails(
        "git-failed",
        `the repository could not be read (${err.code}); where the pull request landed is not known and nothing is measured from a guess`,
      ),
    );
  }
  if (!result.ok) return none(fails(result.code, result.message));
  const landing = result.landing;
  return {
    spans: {
      ok: true,
      ranges: landing.ranges.map((range) => ({
        repo,
        reference: defaultCommit,
        diffBase: range.from,
        head: range.to,
      })),
    },
    landing,
  };
}

const CONFIG_NOT_READ = fails(
  "git-failed",
  "the repository could not be read; the change under .spec-gate/ is not verified",
);

/**
 * The paths under `.spec-gate/` that differ over `ranges`, by the rule of
 * the lint, each as the rule prints it; a path that differs over several
 * ranges is listed once. `null` when a range could not be read.
 */
function configChanges(ranges: readonly GitInputs[]): string[] | null {
  const absent = { state: "absent" } as const;
  const changed: string[] = [];
  for (const git of ranges) {
    const ctx: RuleContext = {
      inputs: {
        spec: absent,
        testplan: absent,
        bindings: absent,
        questions: absent,
        triage: absent,
        meta: absent,
      },
      status: null,
      profile: "full",
      mode: "final",
      git,
    };
    const findings = checkSpecChangesConfig(ctx);
    if (findings.some((finding) => finding.code !== "spec-changes-config")) {
      return null;
    }
    const before = [...changed];
    for (const finding of findings) {
      if (!before.includes(finding.file)) changed.push(finding.file);
    }
  }
  return changed;
}

/**
 * 7: the pull request changes nothing under `.spec-gate/`, judged by the
 * rule of the lint: from the measuring base in the open mode, over every
 * range of the merge in the merged mode.
 */
function configUntouched(s: Subject): Outcome {
  if (!s.spans.ok) return s.spans.outcome;
  const changed = configChanges(s.spans.ranges);
  if (changed === null) return CONFIG_NOT_READ;
  if (changed.length > 0) {
    return fails(
      "spec-changes-config",
      s.mode === "merged"
        ? `${count(changed.length, "path", "paths")} under .spec-gate/ changed over a range of the merge; a change there is a pull request of its own`
        : `the pull request changes ${count(changed.length, "path", "paths")} under .spec-gate/; a change there is a pull request of its own`,
    );
  }
  return holds(
    s.mode === "merged"
      ? "no file under .spec-gate/ differs over a range of the merge"
      : "no file under .spec-gate/ differs between the merge base with the default branch and the head",
  );
}

/** The most findings of the repository check a message of condition 8 lists. */
export const MAX_LISTED_FINDINGS = 20;

/**
 * 8: the repository check has no finding, judged as `repo-check` judges it.
 *
 * It runs from the measuring base to the head, both trees read from git.
 * The work tree is not asked, so a spec the head deletes stays deleted
 * whatever the checkout holds, and the walk covers the whole tree, not only
 * `specs/`. In the merged mode it runs over every range of the merge, and a
 * finding of several ranges is listed once.
 */
function repoCheckClean(s: Subject): Outcome {
  if (!s.spans.ok) return s.spans.outcome;
  const findings: RepoCheckFinding[] = [];
  for (const git of s.spans.ranges) {
    const found = checkRepository(git).findings;
    if (found.some((finding) => finding.code === "tree-too-large")) {
      return fails(
        "tree-too-large",
        "the tree of the diff base or of the head is over a cap of the repository check; a tree that was not read in full is never passed",
      );
    }
    const before = [...findings];
    for (const finding of found) {
      if (
        !before.some(
          (other) => other.code === finding.code && other.path === finding.path,
        )
      ) {
        findings.push(finding);
      }
    }
  }
  // One range arrives sorted; several are put into the same order.
  if (s.spans.ranges.length > 1) {
    findings.sort(
      (a, b) => compareText(a.path, b.path) || compareText(a.code, b.code),
    );
  }
  if (findings.length > 0) {
    // The findings arrive sorted by path, then code. A path is text of the
    // tree, so it is quoted: where one ends is never a guess.
    const listed = findings
      .slice(0, MAX_LISTED_FINDINGS)
      .map((finding) => `${finding.code} ${JSON.stringify(finding.path)}`);
    const more = findings.length - listed.length;
    return fails(
      "repo-check-findings",
      `the repository check reports ${count(findings.length, "finding", "findings")}: ${listed.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`,
    );
  }
  return holds(
    s.mode === "merged"
      ? "no protected spec disappears, changes its id, goes back to draft or loses its log over a range of the merge"
      : "no protected spec of the merge base with the default branch disappears, changes its id, goes back to draft or loses its log at the head",
  );
}

/** A git read that fails inside a condition fails that condition. */
function evaluate(check: () => Outcome): Outcome {
  try {
    return check();
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return fails(
      "git-failed",
      `the repository could not be read (${err.code}); the condition is not verified`,
    );
  }
}

function result(condition: ConditionNumber, outcome: Outcome): ConditionResult {
  const def = CONDITIONS.find((c) => c.condition === condition)!;
  return {
    condition,
    name: def.name,
    ok: outcome.ok,
    code: outcome.ok ? OK_CODE : outcome.code,
    message: outcome.message,
  };
}

function reportedApprovals(s: Subject): ReportedApproval[] {
  if (!s.standing.ok) return [];
  return s.standing.value.map((approval) => ({
    login: approval.login,
    commit: approval.commit,
    at_head: approval.commit === s.approvedHead,
    problem: problemOf(s, approval.login),
  }));
}

/**
 * Checks the approval of the spec in `specDir`. Returns a report whenever
 * the inputs can be used, approved or not; a `refused` result means the
 * check could not start (no directory, git inputs that do not resolve, a
 * spec directory outside `specs/<name>`) and is never an approval.
 */
export async function checkApproval(
  request: ApproveRequest,
): Promise<ApproveResult> {
  if (typeof request.defaultRef !== "string" || request.defaultRef === "") {
    return refuse(
      "needs the default ref: the full name of the ref that holds the default branch",
    );
  }
  if (request.merged !== undefined && typeof request.merged !== "boolean") {
    // A value that only reads as true or false does not pick a mode.
    return refuse("merged must be true or false");
  }
  const mode: ApproveMode = request.merged === true ? "merged" : "open";
  const dir = path.resolve(request.specDir);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return refuse("the spec directory is not a directory");
  }
  if (!dirStat.isDirectory()) {
    return refuse("the spec directory is not a directory, or is a link");
  }
  // The check derives its own measuring base and history check below.
  const resolved = resolveGitInputs(
    dir,
    {
      repo: request.repo,
      defaultRef: request.defaultRef,
      ...(request.base !== undefined ? { base: request.base } : {}),
    },
    { callerMeasures: true },
  );
  if (!resolved.ok) return refuse(resolved.message);
  const git = resolved.git!;
  const specPath = specPathIn(git.repo, dir);
  if (specPath === null || !isSpecLayoutPath(specPath)) {
    return refuse(
      `the spec directory must be ${SPECS_DIR}/<name>, one level below ${SPECS_DIR}/ at the top level of the repository`,
    );
  }
  if (!isRepoPath(repoPathOf(specPath, SPEC_FILE))) {
    return refuse(
      "the path of the spec directory holds a character the git reads do not accept",
    );
  }
  let defaultCommit: string;
  try {
    defaultCommit = resolveRef(git.repo, request.defaultRef);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return refuse("the default ref does not resolve to a commit");
  }

  const facts = await readHostFacts(request.host);
  const pull = facts.pullRequest.ok ? facts.pullRequest.value : null;
  const history = historyProblem(git.repo);
  // In a history that cannot be relied on nothing is derived and nothing
  // is measured.
  const landed =
    mode === "merged" && history === null
      ? landedOf(git.repo, pull, defaultCommit)
      : null;
  const spans: Spans =
    history !== null
      ? { ok: false, outcome: history }
      : landed === null
        ? openSpans(measureOf(git, defaultCommit))
        : landed.spans;
  // Who may approve is what the default branch says now, with or without a
  // base commit: an approver revoked there after the pull request base, or
  // an account made an agent identity there, must not count. The base is
  // only compared with the base the host reports.
  const config = configOf(
    loadConfigAtReference(
      { ...git, reference: defaultCommit },
      { add: () => {} },
    ),
  );
  const standing: Fact<StandingApproval[]> = facts.reviews.ok
    ? { ok: true, value: standingApprovals(facts.reviews.value) }
    : { ok: false };
  // After the merge the checkout is not at the head of the pull request:
  // the approval must stand on the head commit the host reports.
  const approvedHead = mode === "merged" ? (pull?.head ?? null) : git.head;
  const atHead = standing.ok
    ? standing.value.filter((approval) => approval.commit === approvedHead)
    : [];
  // After the merge the spec is judged where it landed, at the commit the
  // default ref names, wherever the checkout is.
  const at = mode === "merged" ? defaultCommit : git.head;
  const subject: Subject = {
    request,
    dir,
    specPath,
    git,
    mode,
    history,
    landing: landed?.landing ?? null,
    defaultCommit,
    at,
    spans,
    facts,
    config,
    standing,
    approvedHead,
    atHead,
  };

  const state = specStateAt(git.repo, at, specPath);
  const headDigest = specDigestAt(git.repo, at, specPath);
  const conditions: ConditionResult[] = [
    result(
      1,
      evaluate(() => approvalAtHead(subject)),
    ),
    result(
      2,
      evaluate(() => approverAllowed(subject)),
    ),
    result(
      3,
      evaluate(() => digestUnchanged(subject, headDigest)),
    ),
    result(
      4,
      evaluate(() => proposedAndClean(subject, state)),
    ),
    result(
      5,
      evaluate(() => agentIdentitiesSeparate(subject)),
    ),
    result(
      6,
      evaluate(() => reviewEnforced(subject)),
    ),
    result(
      7,
      evaluate(() => configUntouched(subject)),
    ),
    result(
      8,
      evaluate(() => repoCheckClean(subject)),
    ),
  ];
  // What a runner may start for this spec. It is shown to the reader and is
  // no condition: the digest of condition 3 already binds the same argv
  // lists for every command a row names.
  const commands = specCommandsAt(git.repo, at, specPath);
  const gaps: Gap[] = GAPS.map((gap) => ({
    code: gap.code,
    message: gap.message,
  }));
  if (!commands.ok) {
    gaps.push({
      code: COMMANDS_GAP,
      message: `the commands of the spec could not be read from git at its commands_ref (${commands.problem}); the report lists none`,
    });
  }

  const code = (n: ConditionNumber) => conditions[n - 1]!.code;
  const pullRequest = pull;
  const landing = landed?.landing ?? null;
  const configCommit = facts.configCommit.ok
    ? facts.configCommit.value
    : { commit: null, approver: null };
  const report: ApproveReport = {
    format: APPROVE_FORMAT,
    mode,
    spec: state?.id ?? null,
    path: specPath,
    approved: conditions.every((c) => c.ok),
    approve_reported:
      conditions[0]!.ok &&
      (code(5) === "approval-not-verifiable" ||
        code(6) === "approval-not-enforced"),
    head: git.head,
    reference: git.reference,
    default_commit: defaultCommit,
    digest: headDigest,
    pull_request:
      pullRequest === null
        ? null
        : {
            number: pullRequest.number,
            author: pullRequest.author,
            head: pullRequest.head,
            base: pullRequest.base,
            target_ref: pullRequest.targetRef,
          },
    merge:
      landing === null
        ? null
        : {
            commit: landing.merge,
            first_parent: landing.firstParent,
            shape: landing.shape,
            reviewed_base: landing.reviewedBase,
            commits: landing.commits,
            ranges: landing.ranges.map((range) => ({
              from: range.from,
              to: range.to,
            })),
          },
    conditions,
    approvals: reportedApprovals(subject),
    last_config_commit: {
      commit: configCommit.commit,
      approver: configCommit.approver,
    },
    commands: commands.ok ? commands.commands : null,
    gaps,
  };
  return { kind: "report", report };
}
