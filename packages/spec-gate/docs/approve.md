# Approval check

A spec in the tree is `draft` or `proposed`. There is no `approved` status to
write: "approved" is derived, each time it is asked for, from facts about the
pull request that carries the spec. `checkApproval` in `src/approve/` is that
derivation. It is a library function; no CLI verb calls it yet.

```ts
import { checkApproval } from "./src/approve/index.js";

const result = await checkApproval({ repo, specDir, defaultRef, base, host });
```

It decides from two sources and nothing else:

- facts a host adapter supplies (`HostAdapter` in `src/host/`): the pull
  request, its reviews, what the host enforces;
- git, read at fixed commits through the same hardened calls the lint uses
  (see "Git inputs" in [lint.md](lint.md)): offline and read-only, it never
  fetches and never writes.

It never reads text a pull request author controls. The title, the body,
comments and commit messages of the pull request are not an input, and the
settings are never taken from the head of the pull request or from the work
tree.

## Inputs

| Field | Meaning |
|---|---|
| `repo` | the trusted checkout root, as `--repo` of the lint: never discovered from the spec directory |
| `specDir` | the spec directory, `specs/<name>` inside `repo` |
| `defaultRef` | the full name of the ref that holds the default branch in `repo` (for example `refs/remotes/origin/main`), as `--default-ref` of the lint; required |
| `base` | the full id of the pull request base commit, as `--base` of the lint; optional |
| `host` | the host adapter |

`repo`, `defaultRef` and `base` are resolved exactly as the lint resolves its
git inputs, and are handed to the final lint unchanged. The reference commit
is `base` when given, else the commit `defaultRef` names; it is the reference
of the lint and the start of the diff base, and nothing else. The settings
(`approvers`, `agent_identities`) are always read at the commit `defaultRef`
names, the tip of the default branch, whether `base` is given or not. The head
is `HEAD` of `repo`: the checkout must be at the head commit of the pull
request, not at a merge of it with the target branch.

## Result

A report, whenever the inputs can be used; otherwise a refusal.

```ts
type ApproveResult =
  | { kind: "report"; report: ApproveReport }
  | { kind: "refused"; message: string };
```

A refusal means the check could not start: `specDir` is not a directory or is
a link, a git input does not resolve (the lint's own messages), `defaultRef`
is missing, or the spec directory is not `specs/<name>`. The host is not asked
anything then. A refusal is never an approval.

## Conditions

`approved` is true only when all seven conditions hold. The report has one
entry per condition, in this order, each with `ok`, a `code` (`ok` when it
holds) and a `message`.

| # | Name | Holds when |
|---|---|---|
| 1 | `approval-at-head` | an approving review stands on the head commit of the pull request, and the checkout is at that commit |
| 2 | `approver-allowed` | an approver of the head commit is in `approvers`, is not the pull request author and is not an agent identity; the settings are read at the tip of the default branch and the pull request targets the default branch |
| 3 | `digest-unchanged` | the digest of the spec at the head equals the digest at the commit of every approving review considered |
| 4 | `proposed-and-clean` | the spec is `proposed` at the head, the spec directory of the work tree is the one the head holds, and the final lint has no error |
| 5 | `agent-identities-separate` | `agent_identities` is not empty and shares no account with `approvers` |
| 6 | `review-enforced` | the host enforces a review for `specs/` and for `.spec-gate/`, and reports the last change under `.spec-gate/` |
| 7 | `config-untouched` | no file under `.spec-gate/` differs between the diff base and the head |

A condition that could not be evaluated does not hold. A host method that
throws, rejects or returns a value outside its type gives `host-failed` for
every condition that needed the fact; a git read that fails gives
`git-failed`. Neither is ever a pass.

### 1. An approving review on the head

Per account, the latest decisive review counts. `APPROVED`,
`CHANGES_REQUESTED` and `DISMISSED` are decisive; `COMMENTED` is not. So a
comment after an approval leaves the approval standing, and a later request
for changes or a dismissal takes it away. Reviews are ordered by the time the
host reports, not by their position in the list. Two spellings of a login that
differ only in case are one account. When an account has several decisive
reviews at its latest time, the approval stands only if all of them approve
one commit: a tie is never resolved in favour of an approval.

An approval stands on the commit the review was submitted on. Only an
approval whose commit is the head counts: a review of an older commit is
`approval-stale`, whatever the pull request looked like then.

The head is `HEAD` of the checkout, and it must be the head commit the host
reports for the pull request (`head-mismatch` otherwise): everything else the
check reads from git is read at `HEAD`, so a checkout at another commit would
judge another tree than the one that was reviewed.

Codes: `host-failed`, `head-mismatch`, `no-approval`, `approval-stale`.

### 2. An allowed approver

At least one approver of the head commit must count. An approver counts when
all three hold; the report names the first that does not, in this order:

| Problem | Meaning | Comparison |
|---|---|---|
| `is-agent` | the login is one of `agent_identities` | wide |
| `is-author` | the login is the author of the pull request | wide |
| `not-allowlisted` | the login is not in `approvers` | narrow |

Host logins are case-insensitive, and a comparison can be wrong in two
directions, so there are two:

- narrow, for "is this reviewer an approver": equal but for the case of the
  ASCII letters. A letter outside ASCII is compared exactly, a compatibility
  form (a full-width letter) or a letter of another script is a different
  login, and `alice[bot]` is not `alice`.
- wide, for "might this be the author or an agent": Unicode compatibility
  forms and case are folded, and the `[bot]` suffix a host puts on the login
  of an app is ignored. `spec-bot[bot]` is the agent identity `Spec-Bot`.

Both err towards "not approved". An approver that could not be judged because
the settings or the pull request are unavailable is `not-evaluated`.

`approvers` and `agent_identities` come from `.spec-gate/config.yaml` read
from git at the commit `defaultRef` names, the tip of the default branch,
through the reader the lint uses. That holds with and without `base`: who may
approve is what the default branch says now, not what it said at the base of
the pull request, so an approver removed there since, or an account made an
agent identity there since, does not count. A pull
request that edits the file, in a commit or in the work tree, changes nothing
about who may approve it. A repository without the file has empty lists; a
file that cannot be read or does not parse is `config-invalid`.

The condition also ties the settings to the branch the spec is merged into:

- `target-not-default`: the branch the host reports as the target
  (`refs/heads/<branch>`) is not the branch `defaultRef` holds. `defaultRef`
  holds it when it is that same name, or `refs/remotes/<remote>/<branch>` with
  a remote name that has no `/`. The first component after `refs/remotes/` is
  always read as the remote and the rest as the branch, so under a remote
  named `a/b` the ref `refs/remotes/a/b/main` is taken for the branch `b/main`
  of a remote `a`: a pull request that targets `refs/heads/b/main` is accepted
  and one that targets `refs/heads/main` is refused. Name the default ref
  under a remote without `/`, or as `refs/heads/<branch>`.
- `base-mismatch`: `base` was given and the host reports another base commit.
- `base-not-on-default`: `base` was not given and the base commit the host
  reports is not the commit `defaultRef` names or an ancestor of it (a stale
  local default ref gives this too; the job must fetch the default branch,
  the check does not).
- `head-in-reference`: the head commit is the commit `defaultRef` names or an
  ancestor of it. The settings are trusted because the pull request did not
  write the commit they are read at; a head that the tip of the default branch
  already contains (a merged pull request, a branch without a commit of its
  own) breaks that, since its own change to the settings would be read as the
  settings. This holds with and without `base`. The check judges an open pull
  request; it does not judge a merged one.

Codes: `host-failed`, `config-invalid`, `target-not-default`,
`base-mismatch`, `base-not-on-default`, `head-in-reference`, `no-approval`,
`approver-not-qualified`, `git-failed`.

### 3. The digest that was approved

The digest (see [digest.md](digest.md)) of the spec at the head must equal the
digest at the commit of every approving review that is considered. Both are
computed from git: `spec.md` and `testplan.yaml` from the tree of the commit,
the commands at `commands_ref`. The work tree is not read, and no digest
quoted in the pull request is.

The reviews considered are the approvals that stand on the head; when there
are none, the approvals that stand on other commits. With an approval on the
head the comparison is of a commit with itself and the condition asks only
that a digest exists there. Without one it tells the reader whether the
normative layer changed since the approval: an approval of an older commit
with an unchanged digest fails condition 1 and holds here.

Codes: `host-failed`, `no-approval`, `digest-unavailable` (no digest exists
at the head: a file is missing or does not parse, a command is unknown),
`review-commit-unavailable` (the commit of a review is not in the repository;
nothing is fetched), `review-digest-unavailable`, `digest-mismatch`,
`git-failed`.

### 4. Proposed, and the final lint is clean

- The frontmatter `status` of `spec.md`, read from git at the head, is
  `proposed` (`status-not-proposed`; `spec-unreadable` when the file is
  missing there, is not a regular file or does not parse).
- The spec directory of the work tree holds exactly the files the head commit
  holds there, byte for byte, and nothing but regular files and directories
  (`worktree-not-head`). The lint reads the spec directory from the work
  tree, so its verdict is about the head only when the two are the same. An
  edited, added or removed file fails this, and so does a file the repository
  ignores, a link, and a checkout that rewrites line ends.
- The final lint (`lint --final` with the git inputs as given, run in
  process) has no error (`lint-errors`, with the rule ids; `lint-failed` when
  it cannot run). Warnings do not count.
- `HEAD` is still the commit the check started at (`head-moved`).

Codes: `spec-unreadable`, `status-not-proposed`, `worktree-not-head`,
`lint-failed`, `lint-errors`, `head-moved`, `git-failed`.

### 5. Agent identities are set apart

`agent_identities` at the tip of the default branch must not be empty, and no agent
identity may be an approver (the wide comparison). Otherwise nothing tells an
agent's approve from a person's: `approval-not-verifiable`.

Codes: `config-invalid`, `approval-not-verifiable`.

### 6. The host enforces the review

The adapter reports, for `specs/` and for `.spec-gate/`, one of `enforced`,
`not-enforced` and `unknown`. Both must be `enforced`; `unknown` counts as
not enforced: `approval-not-enforced`.

The adapter also reports the last change under `.spec-gate/` on the default
branch and who approved it, and the report always lists it
(`last_config_commit`). A review rule that was switched on later does not
cover an earlier merge, so the reader sees who let the current settings in.
"Unknown" (`null`) is an answer and does not fail the condition; an adapter
that fails to answer does (`host-failed`).

Codes: `host-failed`, `approval-not-enforced`.

### 7. Nothing under `.spec-gate/` changes

No path under `.spec-gate/` differs between the diff base
(`merge-base(HEAD, reference commit)`) and the head. This is the lint rule
`spec-changes-config`, called as it is: the first path component is compared
without regard to case, and a change made only on the default branch after
the fork does not count.

Codes: `spec-changes-config`, `git-failed`.

## Report

Format `spec-gate-approve/1`. The report is deterministic: the same
repository state and the same host facts give the same report. It holds no
time, no absolute path, and nothing a host adapter threw.

| Field | Meaning |
|---|---|
| `format` | `spec-gate-approve/1` |
| `spec` | the frontmatter `id` at the head, or `null` |
| `path` | the spec directory in the repository, `specs/<name>` |
| `approved` | true only when every condition holds |
| `approve_reported` | true when an approving review stands on the head (condition 1 holds) and condition 5 is `approval-not-verifiable` or condition 6 is `approval-not-enforced`: an approve was seen, an approval is not claimed. Never true together with `approved` |
| `head` | the commit that was checked |
| `reference` | the reference commit of the final lint and of the diff base: `base` when given, else `default_commit` |
| `default_commit` | the commit `defaultRef` names; the settings were read there |
| `digest` | the digest of the spec at the head, or `null` |
| `pull_request` | `number`, `author`, `head`, `base`, `target_ref` as the host reports them, or `null` when the host failed |
| `conditions` | seven entries: `condition`, `name`, `ok`, `code`, `message` |
| `approvals` | every approval that stands, on the head or not: `login`, `commit`, `at_head`, `problem` (`null` for an approver that counts) |
| `last_config_commit` | `commit` and `approver` of the last change under `.spec-gate/`; `null` is unknown |
| `gaps` | the checks the approval does not make, each with a `code` and a `message`; a gap never changes `approved` |

## What the check can and cannot say

It can say: an identity on the approver list, other than the pull request
author and other than every configured agent identity, approved exactly this
commit, on a host that enforces that review, for a spec whose normative layer
is the one at that commit, with settings the pull request did not write.

It cannot say that a person approved. The host condition for a real approval
is outside this package: the agent works under an identity of its own that
has no right to approve (a bot account), and the host enforces the review for
`specs/` and `.spec-gate/`. An agent that holds the token of an identity on
the approver list is not detected.

## What a host adapter must guarantee

`HostAdapter` (`src/host/types.ts`) has five methods. An adapter must:

- take every value from the host's own event or API, never from text of the
  pull request (title, body, comments, commit messages, labels);
- report commits as full commit ids, the target as `refs/heads/<branch>`, and
  times as ISO 8601 with a zone;
- return every submitted review, all pages, with the state each has now (a
  dismissed approval is `DISMISSED`), and leave out a review that was never
  submitted;
- report `enforced` for a path only when the host refuses to merge a change
  there without an approving review (a branch protection or ruleset that
  requires it); a code-owners file that nothing enforces is `not-enforced`,
  and what it cannot determine is `unknown`;
- throw when it cannot answer, instead of guessing, and end every call in
  bounded time: the check waits for each answer;
- keep secrets out of what it returns. What it throws is discarded.

`ciRunStatus(ref)` (`verified`, `unverified`, `unknown`) is part of the
interface for the evidence checks; the approval check does not call it.

## Known gaps

Named here instead of closed:

- `coldread-not-checked` (in `gaps` of every report): the cold-read digest is
  not compared, because no cold-read format exists yet.
- Admin bypass: an administrator who may bypass a ruleset can merge without
  the review the adapter reports as enforced.
- Squash merges: what lands on the default branch can differ from the head
  that was approved. This check judges the head of the pull request; comparing
  the digest on the default branch with the digest at the commit of the
  approving review is a separate, later check.
- Enforcement is the host's word: the check cannot verify a ruleset, it
  relays what the adapter reports.
- The check reads the work tree once for the lint and compares it with the
  head before; a file changed between the comparison and the lint is not
  noticed.
