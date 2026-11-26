/**
 * `checkApproval`: is this spec approved?
 *
 * The tree knows `draft` and `proposed` only; "approved" is derived here,
 * from facts a host adapter supplies and from git reads at fixed commits.
 * It holds only when all seven conditions hold (see `CONDITIONS` and
 * `docs/approve.md`). The check never fetches, never writes and never reads
 * text a pull request author controls: the settings come from git at the
 * commit the default ref names (the tip of the default branch, with or
 * without a base commit given), the digests from git at the head and at the
 * commit of a review, and who reviewed what comes from the host.
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
import {
  SPECS_DIR,
  isRepoPath,
  isSpecLayoutPath,
  repoPathOf,
  specPathIn,
} from "../state/git.js";
import { readHostFacts, type Fact, type HostFacts } from "./facts.js";
import { specDigestAt, specDirMatchesCommit, specStateAt } from "./git.js";
import { allowlisted, sameAccount } from "./logins.js";
import { standingApprovals, type StandingApproval } from "./reviews.js";
import {
  APPROVE_FORMAT,
  CONDITIONS,
  GAPS,
  OK_CODE,
  type ApproveReport,
  type ApproveRequest,
  type ApproveResult,
  type ApproverProblem,
  type ConditionNumber,
  type ConditionResult,
  type FailureCode,
  type ReportedApproval,
} from "./types.js";

type Outcome =
  | { ok: true; message: string }
  | { ok: false; code: FailureCode; message: string };

const holds = (message: string): Outcome => ({ ok: true, message });
const fails = (code: FailureCode, message: string): Outcome => ({
  ok: false,
  code,
  message,
});

const HOST_FAILED = (what: string): Outcome =>
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
  git: GitInputs;
  /** The commit `defaultRef` names. */
  defaultCommit: string;
  facts: HostFacts;
  /** The settings at `defaultCommit`; the format defaults when the file is absent. */
  config: SpecGateConfig | null;
  /** The approvals that stand, or the host failure. */
  standing: Fact<StandingApproval[]>;
  /** The approvals that stand on the head commit. */
  atHead: StandingApproval[];
}

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

/** 1: an approving review stands on the head. */
function approvalAtHead(s: Subject): Outcome {
  if (!s.facts.pullRequest.ok) return HOST_FAILED("the pull request");
  if (!s.standing.ok) return HOST_FAILED("the reviews");
  if (s.facts.pullRequest.value.head !== s.git.head) {
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
  if (isAncestor(s.git.repo, s.git.head, s.defaultCommit)) {
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

/** 3: the digest at the head is the digest that was approved. */
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
      "no digest exists for the spec at the head commit",
    );
  }
  const commits = [...new Set(subjects.map((approval) => approval.commit))]
    .filter((commit) => commit !== s.git.head)
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
    if (digest !== headDigest) {
      return fails(
        "digest-mismatch",
        `the digest at the head differs from the digest at the commit ${commit} of an approving review`,
      );
    }
  }
  return holds(
    "the digest at the head equals the digest at the commit of every approving review considered",
  );
}

/** 4: `proposed` at the head, and the final lint of that head is clean. */
function proposedAndClean(
  s: Subject,
  state: { status: string } | null,
): Outcome {
  if (state === null) {
    return fails(
      "spec-unreadable",
      `${SPEC_FILE} at the head commit is missing, is not a regular file or does not parse`,
    );
  }
  if (state.status !== "proposed") {
    return fails(
      "status-not-proposed",
      `the status at the head commit is ${state.status}; only a proposed spec is approved`,
    );
  }
  if (!specDirMatchesCommit(s.git.repo, s.git.head, s.specPath, s.dir)) {
    return fails(
      "worktree-not-head",
      "the spec directory of the work tree is not, byte for byte, the one the head commit holds; the lint would judge other files",
    );
  }
  const request: GitRequest = {
    repo: s.request.repo,
    defaultRef: s.request.defaultRef,
    ...(s.request.base !== undefined ? { base: s.request.base } : {}),
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
    "the status at the head commit is proposed and the final lint has no error",
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
      `a review is not enforced for every path (${states.map((entry) => `${entry.path}: ${entry.state}`).join(", ")}); unknown counts as not enforced`,
    );
  }
  return holds(`the host enforces a review for ${REVIEW_PATHS.join(" and ")}`);
}

/** 7: the pull request changes nothing under `.spec-gate/`, judged as the lint judges it. */
function configUntouched(s: Subject): Outcome {
  const absent = { state: "absent" } as const;
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
    git: s.git,
  };
  const findings = checkSpecChangesConfig(ctx);
  if (findings.some((finding) => finding.code !== "spec-changes-config")) {
    return fails(
      "git-failed",
      "the repository could not be read; the change under .spec-gate/ is not verified",
    );
  }
  if (findings.length > 0) {
    return fails(
      "spec-changes-config",
      `the pull request changes ${count(findings.length, "path", "paths")} under .spec-gate/; a change there is a pull request of its own`,
    );
  }
  return holds(
    "no file under .spec-gate/ differs between the diff base and the head",
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
    at_head: approval.commit === s.git.head,
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
  const resolved = resolveGitInputs(dir, {
    repo: request.repo,
    defaultRef: request.defaultRef,
    ...(request.base !== undefined ? { base: request.base } : {}),
  });
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
  // Who may approve is what the default branch says now, with or without a
  // base commit: an approver revoked there after the pull request base, or
  // an account made an agent identity there, must not count. The base only
  // sets the diff base and the reference of the lint.
  const config = configOf(
    loadConfigAtReference(
      { ...git, reference: defaultCommit },
      { add: () => {} },
    ),
  );
  const standing: Fact<StandingApproval[]> = facts.reviews.ok
    ? { ok: true, value: standingApprovals(facts.reviews.value) }
    : { ok: false };
  const atHead = standing.ok
    ? standing.value.filter((approval) => approval.commit === git.head)
    : [];
  const subject: Subject = {
    request,
    dir,
    specPath,
    git,
    defaultCommit,
    facts,
    config,
    standing,
    atHead,
  };

  const state = specStateAt(git.repo, git.head, specPath);
  const headDigest = specDigestAt(git.repo, git.head, specPath);
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
  ];

  const code = (n: ConditionNumber) => conditions[n - 1]!.code;
  const pullRequest = facts.pullRequest.ok ? facts.pullRequest.value : null;
  const configCommit = facts.configCommit.ok
    ? facts.configCommit.value
    : { commit: null, approver: null };
  const report: ApproveReport = {
    format: APPROVE_FORMAT,
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
    conditions,
    approvals: reportedApprovals(subject),
    last_config_commit: {
      commit: configCommit.commit,
      approver: configCommit.approver,
    },
    gaps: GAPS.map((gap) => ({ code: gap.code, message: gap.message })),
  };
  return { kind: "report", report };
}
