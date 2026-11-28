# Approval check

A spec in the tree is `draft` or `proposed`. There is no `approved` status to
write: "approved" is derived, each time it is asked for, from facts about the
pull request that carries the spec. `checkApproval` in `src/approve/` is that
derivation. It is a library function; the CLI verb `spec-gate approve-check`
calls it for a pull request on GitHub (see "CLI").

It has two modes. This page describes the open mode first: the check of an
open pull request, at its head commit. With `merged: true` (`--merged`) it
checks a merged pull request instead, at the tip of the default branch; what
differs then is described in "After the merge".

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
| `base` | the full id of the pull request base commit; optional. It is only compared with the base the host reports, and no condition measures from it |
| `merged` | `true` for the check after the merge (see "After the merge"); optional. Left out or `false`, an open pull request is judged. Any other value is refused |
| `host` | the host adapter |

`repo`, `defaultRef` and `base` are resolved exactly as the lint resolves its
git inputs: `base` must be the full id of a commit and lie on the default
ref. That is all `base` is checked for, and it has one use: condition 2
compares it with the base commit the host reports. The final lint is given
`repo` and `defaultRef` only, never `base`. What the pull request changes is
measured from one commit, the measuring base (see "The measuring base"),
whether `base` is given or not. The settings
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
is missing, `merged` is neither `true` nor `false`, or the spec directory is
not `specs/<name>`. The host is not asked
anything then. A refusal is never an approval.

A report is not an approval either: it says `approved: true` or
`approved: false`. The CLI verb keeps the three apart by its exit code (see
"CLI").

## Conditions

`approved` is true only when all eight conditions hold. The report has one
entry per condition, in this order, each with `ok`, a `code` (`ok` when it
holds) and a `message`. The table and the sections below describe the open
mode; "After the merge" says what each condition asks for a merged pull
request, and each list of codes names the codes of both modes.

| # | Name | Holds when |
|---|---|---|
| 1 | `approval-at-head` | an approving review stands on the head commit of the pull request, and the checkout is at that commit |
| 2 | `approver-allowed` | an approver of the head commit is in `approvers`, is not the pull request author and is not an agent identity; the settings are read at the tip of the default branch and the pull request targets the default branch |
| 3 | `digest-unchanged` | the digest of the spec at the head equals the digest at the commit of every approving review considered |
| 4 | `proposed-and-clean` | the spec is `proposed` at the head, the spec directory of the work tree is the one the head holds, and the final lint has no error |
| 5 | `agent-identities-separate` | `agent_identities` is not empty and shares no account with `approvers` |
| 6 | `review-enforced` | the host enforces a review for `specs/` and for `.spec-gate/`, and reports the last change under `.spec-gate/` |
| 7 | `config-untouched` | no file under `.spec-gate/` differs between the merge base of the head with the default branch and the head |
| 8 | `repo-check-clean` | the repository check has no finding between the merge base of the head with the default branch and the head: no protected spec disappears, changes its id, goes back to `draft` or loses its log |

A condition that could not be evaluated does not hold. A host method that
throws, rejects or returns a value outside its type gives `host-failed` for
every condition that needed the fact; a git read that fails gives
`git-failed`. Neither is ever a pass.

### The measuring base

Three conditions measure what the pull request changes: the final lint of
condition 4 (its rules `bindings-log` and `spec-changes-config`, and the
ancestry rules for `base_commit` and `commands_ref`), the change under
`.spec-gate/` of condition 7 and the repository check of condition 8. All
three measure from one commit, derived once for the check: the measuring
base. It is the one merge base of `HEAD` and the default commit, the commit
`defaultRef` names, read with `git merge-base --all`.

It is not taken from `base`. A base commit says where the pull request
started, and a host can report one that is older than a commit of the
default branch the head has merged since. Measured from that older commit, a
settings file the pull request puts back to its old text shows no change, a
spec the default branch gained in between and the pull request deletes is not
in the tree the repository check starts from, and a `bindings.log` merged in
between is not there for the lint to compare with, so a second propose can
replace it. Merging such a pull request would still undo, delete or replace
what the default branch holds. Measured from the default branch, all three
show.

The lint is given `repo` and `defaultRef`. It resolves its reference to the
default commit and its diff base to the merge base of `HEAD` with it, which
is the measuring base whenever there is exactly one.

A shallow repository is refused before anything is measured, in both modes:
conditions 2, 4, 7 and 8 are `shallow-repository` (and `git-failed` when git
cannot say whether it is shallow). At a shallow boundary a commit shows no
parents, and a hidden merge base makes git report an older one, from which a
settings file put back to its older text shows no change.

When there is not exactly one, nothing is measured and conditions 4, 7 and 8
do not hold:

- more than one merge base: `ambiguous-merge-base`. This happens when the
  histories crossed: the default branch and the pull request branch each
  merged a commit the other one reached on its own. git's plain `merge-base`
  then prints one of them, and the check cannot rely on which: from one whose
  tree lacks a spec, the deletion of that spec does not show although a merge
  makes it. The check does not pick and does not run the lint. Merging
  the tip of the default branch into the pull request branch, or rebasing
  onto it, leaves one merge base;
- no merge base, or a read that fails: `git-failed`.

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

Codes: `host-failed`, `head-mismatch`, `no-approval`, `approval-stale`; after
the merge `not-merged` in place of `head-mismatch`.

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
`approver-not-qualified`, `git-failed`, `shallow-repository`; after the
merge, in place of `head-in-reference`: `not-merged`, `merge-not-on-default`,
`head-unavailable`, `merge-shape-unknown`, `ambiguous-merge-base`,
`config-in-merge`.

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
`git-failed`; after the merge `digest-mismatch-after-merge` in place of
`digest-mismatch`, `review-not-proposed`, `spec-not-in-merge` and
`ambiguous-merge-base`.

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
- There is a measuring base (`ambiguous-merge-base` and `git-failed`
  otherwise, see "The measuring base"); the lint does not run without one.
- The final lint (`lint --final` with `--repo` and `--default-ref`, never
  with `--base`, run in process) has no error (`lint-errors`, with the rule
  ids; `lint-failed` when it cannot run). Warnings do not count. The lint so
  measures from the measuring base: a `bindings.log` merged on the default
  branch is compared with the one at the head whatever base the host reports.
- `HEAD` is still the commit the check started at (`head-moved`).

Codes: `spec-unreadable`, `status-not-proposed`, `worktree-not-head`,
`ambiguous-merge-base`, `lint-failed`, `lint-errors`, `head-moved`,
`git-failed`, `shallow-repository`; after the merge also
`checkout-not-default-tip`, `bindings-after-merge`, and, when where the
pull request landed is not known, `host-failed`, `not-merged`,
`merge-not-on-default`, `head-unavailable`, `merge-shape-unknown`.

### 5. Agent identities are set apart

`agent_identities` at the tip of the default branch must not be empty, and no agent
identity may be an approver (the wide comparison). Otherwise nothing tells an
agent's approve from a person's: `approval-not-verifiable`.

Codes: `config-invalid`, `approval-not-verifiable`.

### 6. The host enforces the review

The adapter reports, for `specs/` and for `.spec-gate/`, one of `enforced`,
`not-enforced` and `unknown`. Both must be `enforced`; `unknown` counts as
not enforced: `approval-not-enforced`. The detail of the failure names, for
each path that is not `enforced`, why: for `unknown` that the host could not
read whether a review is enforced, with a pointer to "Token and permissions"
below; for `not-enforced` that the host reports no required review. The
check fails closed in both cases.

The adapter also reports the last change under `.spec-gate/` on the default
branch and who approved it, and the report always lists it
(`last_config_commit`). A review rule that was switched on later does not
cover an earlier merge, so the reader sees who let the current settings in.
"Unknown" (`null`) is an answer and does not fail the condition; an adapter
that fails to answer does (`host-failed`).

Codes: `host-failed`, `approval-not-enforced`.

### 7. Nothing under `.spec-gate/` changes

No path under `.spec-gate/` differs between the measuring base and the head
(see "The measuring base"). This is the lint rule `spec-changes-config`,
called as it is: the first path component is compared without regard to
case.

A settings file the pull request puts back to its text at an older base is a
change: merging the pull request would undo what the default branch decided
in between (an approver taken off the list, for one). A change the default
branch made itself does not count, before or after the pull request merged
it. The final lint of condition 4 runs the same rule from the same base, so
a change here fails condition 4 as well.

Codes: `spec-changes-config`, `ambiguous-merge-base`, `git-failed`,
`shallow-repository`; after the merge also `host-failed`, `not-merged`,
`merge-not-on-default`, `head-unavailable`, `merge-shape-unknown`.

### 8. The repository check is clean

The repository check (see "Repository check" in [lint.md](lint.md)) has no
finding. It is `checkRepository`, the function behind `spec-gate repo-check`,
called as it is over the tree of the measuring base and the tree of the head
(see "The measuring base"), both read from git, whether `base` is given
or not: a spec the default branch gained after the base the host reports,
which the head has merged and then deletes, is in the tree the walk starts
from. So a pull request that carries an approved spec and, beside it,
deletes another proposed spec, changes its id, puts it back to `draft` or
removes its `bindings.log` is not approved.

- The work tree is not asked. A spec the head deletes stays deleted when the
  file is restored in the work tree without a commit, and a spec the head
  holds is not a finding when the work tree lacks it.
- The whole tree is walked, not only `specs/`: a protected `spec.md` anywhere
  counts, as for `repo-check`.
- The walk starts at the measuring base, not at the tip of the default
  branch: a spec merged there after the pull request forked, which the head
  has not merged, is not counted as removed.

A finding is `repo-check-findings`. The message gives the number of findings
and, for the first 20 in the order of the repository check (by path, then
code), the code and the path, the path quoted as a JSON text; the rest is
counted (`(and 3 more)`). A tree over a cap of the repository check is
`tree-too-large`: a tree that was not read in full is never passed.

This condition covers the pull requests `approve-check` runs on. A pull
request without a spec to approve deletes a spec just as well, so
`repo-check` still runs on every pull request.

Codes: `repo-check-findings`, `tree-too-large`, `ambiguous-merge-base`,
`git-failed`, `shallow-repository`; after the merge also `host-failed`,
`not-merged`, `merge-not-on-default`, `head-unavailable`,
`merge-shape-unknown`.

## After the merge

`checkApproval({ ..., merged: true })`, on the command line
`approve-check --merged`, answers another question than the open mode: is the
spec a merged pull request left on the default branch the spec that was
approved?

The open mode cannot answer it. A squash merge and a rebase merge write new
commits, so the approved head is not what the default branch holds; a merge
can be made by an actor who may bypass the review; and the default branch
moves on afterwards. The open mode refuses a head the default branch already
holds (`head-in-reference`).

Like the open mode it decides from the host's facts and from git, never from
text of the pull request. It needs two more facts of the host: whether the
pull request is merged, and the commit the merge put on the target branch
(`merged` and `mergeCommit` of `HostPullRequest`).

The eight conditions keep their numbers and names, and `approved` is still
all of them:

| # | After the merge, the condition asks |
|---|---|
| 1 | The host reports the pull request as merged, and an approving review stands on the head commit the host reports for it. |
| 2 | An approver of that head commit is in `approvers`, is not the pull request author and is not an agent identity; the settings are read at the tip of the default branch, the pull request targeted the default branch, its merge commit is on the default branch and no range of the merge changes a path under `.spec-gate/`. |
| 3 | The digest of the spec at the tip of the default branch equals the digest at the commit of every approving review considered, the spec is `proposed` at each of those commits, and the state judged at the tip (`proposed`, with the digest at the tip) arrives both over the reviewed commits and over a measured step of the default branch. |
| 4 | The spec is `proposed` at the tip of the default branch, the checkout is at that commit, the spec directory of the work tree is the one it holds, the bindings at the tip are the ones the approved head and the default branch before the merge hold, extended by log entries only, and the final lint has no error. |
| 5 | `agent_identities` is not empty and shares no account with `approvers`. |
| 6 | The host enforces a review for `specs/` and for `.spec-gate/`, and reports the last change under `.spec-gate/`. |
| 7 | No path under `.spec-gate/` differs over a range of the merge. |
| 8 | The repository check has no finding over a range of the merge. |

Conditions 5 and 6 ask what they ask in the open mode.

### What is judged, and where

The tip of the default branch is the commit `defaultRef` names when the check
runs. `spec.md` and `testplan.yaml` are read from git at that commit, and
`spec`, `digest` and `commands` of the report are those of the spec as that
commit holds it (the command set still comes from its `commands_ref`, see
"Commands"). The merge commit may lie below the tip: a commit the
default branch gained after the merge is part of what is judged. So the answer
is about the default branch as it is now, and it can change when the branch
moves on.

- Condition 1 does not look at the checkout. The approval must stand on the
  head commit the host reports for the pull request; a review of the merge
  commit or of the tip is `approval-stale`. A pull request the host does not
  report as merged is `not-merged`, also when it names a merge commit: for an
  open pull request a host can name a trial merge there.
- Condition 3 also asks that the pull request is the one that brought the
  spec to the state judged at the tip (`spec-not-in-merge`, see "The pull
  request that brought the spec").
- Condition 3 asks that the spec is `proposed` at the commit of every
  approving review considered (`review-not-proposed`, which names the
  commit). Condition 4 reads the status at the tip only, and the status is no
  part of the digest: without this, an approval of a pull request that added
  the spec as a draft would count once another pull request, approved by
  nobody, set the status to `proposed`. The open mode needs no such test: an
  approval counts there only on the head, where condition 4 reads the status.
- Condition 3 compares the digest at the tip with the digest at the commit of
  each approving review considered, both computed from git. A difference is
  `digest-mismatch-after-merge`, and the message names both digests and both
  commits. It covers a squash that carried other content than the approved
  head and a later commit that changed the spec. The commit of the review is
  usually not in the history of the default branch after a squash or rebase
  merge: the job must have it in the repository
  (`review-commit-unavailable` otherwise; nothing is fetched).
- Condition 4 reads the status at the tip. The lint reads the spec directory
  from the work tree and its git view from `HEAD`, so `HEAD` must be the
  commit `defaultRef` names (`checkout-not-default-tip`) and the spec
  directory of the work tree must be the one that commit holds
  (`worktree-not-head`).
- Condition 4 also checks the bindings after the merge. The final lint at
  the tip compares the tip with itself, so its `bindings-log` rule (see
  [lint.md](lint.md)) is run once more, alone, with the tip as `HEAD` and
  each of these commits as the diff base: the head commit the host reports,
  where the approving reviews stand, and the start of every measured
  first-parent step (see "The ranges of the merge"), the first parent of the
  merge commit first. From each, every `bindings.log` that commit holds for
  a spec of this id must be extended by the log at the tip, entry for entry
  with the hash chain continued, and `bindings.yaml` at the tip must be the
  replay of the entries after it over `bindings.yaml` read from git there
  (or over the propose commit, when that is an ancestor of the tip). A
  commit of the steps that holds no log for the spec is not asked: it has
  no log to extend. The head commit must hold a `bindings.log` at the path
  of the spec that parses, so that it has a propose entry; a head without
  one (no log, an empty or a cut-off one) is `bindings-after-merge`, since a
  log written on the default branch later would be anchored at whatever
  commit it names. A finding is `bindings-after-merge`; the message names
  the commit it was measured from (the head commit, the first parent, or a
  step below it) and the codes of the rule, never the content of a file.
  This covers a squash that carried other bindings than the approved head,
  a log entry of the head dropped or rewritten on the way to the tip, a
  later commit that changed `bindings.yaml` without a log entry, and a pull
  request that put a merged spec back to `draft` and proposed it again. The
  rule does not run when `bindings.yaml` or `testplan.yaml` of the spec
  directory does not parse; that is `bindings-after-merge` as well. A git
  read that fails is `git-failed`. Where the pull request landed must be
  known for this; when it is not, condition 4 carries the code of the
  landing, as conditions 2, 7 and 8 do.
- The settings of conditions 2 and 5 are read at the tip, as in the open mode:
  an approver taken off the list on the default branch after the merge does
  not count, and neither does an account made an agent identity there since.

### The ranges of the merge

What the pull request changed is measured over ranges of commits that are
derived from git and from two facts of the host, the head commit of the pull
request and its merge commit (`landingOf` in `src/approve/landing.ts`). The
merge commit must be the commit `defaultRef` names or an ancestor of it
(`merge-not-on-default`; a default ref that was not fetched since the merge
gives this too).

The first range runs from the first parent of the merge commit to the merge
commit: the first parent is what the default branch held before. Whether that
range is the whole pull request depends on how it was merged, and git shows
two shapes that can be told:

| Shape | git shows | Ranges |
|---|---|---|
| `merge-commit` | the merge commit has two parents, the second is the head commit of the pull request, and that head was not in the history of the first parent | first parent to merge commit |
| `single-commit` | the merge commit has one parent, and the head commit of the pull request is not in its history: a squash merge or a rebase merge | each of the last N first-parent steps below the merge commit, N being the number of commits between the reviewed base and the head commit; and the reviewed base to the head commit |

The reviewed base is the one merge base of the head commit with the first
parent of the merge commit. The head commit must be in the repository for it
(`head-unavailable`), and it must have exactly one merge base with that
parent (`ambiguous-merge-base` for several, `git-failed` for none).

A squash merge puts the whole pull request into its one commit. A rebase merge
replays the commits of the pull request one by one, and the host names the
last of them; the others are the commits before it on the first-parent chain.
Git does not say which of the two happened, and no comparison of the trees at
both ends does. A replay can undo a change of the default branch in one commit
that an earlier commit of the same pull request repeated: the reviewed commits
as a whole then change nothing, the last replayed commit changes nothing, and
the default branch still loses the change. A pull request whose commits copy a
change of `.spec-gate/config.yaml` from the default branch and then undo it
puts a revoked approver back that way, and one that adds and deletes a spec
the default branch gained deletes that spec.

So every step is measured on its own. A replay makes at most one commit per
commit of the pull request, so the last N first-parent steps below the merge
commit hold every replayed commit, and each of them is a range of its own.
After a squash merge of a pull request of several commits the steps before
the last are commits of the default branch itself, and what they change is
counted too: a squash that follows a commit of the default branch that
changed `.spec-gate/` or removed a proposed spec, within N - 1 commits, is not
approved, although the pull request did neither. The check cannot tell that
commit from a replayed one.

A rebase merge can reach commits of the default branch as well. N counts
every commit of the pull request, its merge commits included, and a replay
makes no commit for a merge commit and none for a commit that would change
nothing. A pull request that merged the default branch once (an update of the
branch) and is then replayed has one step more than replayed commits, and that
step is the commit of the default branch below them.

Two more refusals keep the steps honest: a pull request of more than 50
commits is not measured, and neither is a merge commit whose first-parent
history is shorter than N steps (both `merge-shape-unknown`).

The trees are only compared. No merge is computed to say what the landed tree
should be: a merge started by git could run a merge driver the repository
configures and writes objects, and a merge of the head onto a replayed commit
gives the landed tree as well, so it would tell nothing.

Conditions 2, 7 and 8 use every range, and a path or a finding that several
ranges show is counted once:

- condition 7: no path under `.spec-gate/` differs over a range, by the lint
  rule `spec-changes-config` as in the open mode;
- condition 8: the repository check has no finding over a range;
- condition 2: after the merge the tip of the default branch holds the pull
  request, so the settings read there could be its own. They are trusted only
  when no range changes a path under `.spec-gate/`; otherwise the condition
  is `config-in-merge`, whoever approved. This takes the place of
  `head-in-reference`.

Every other shape is `merge-shape-unknown`, and conditions 2, 7 and 8 do not
hold:

- the head commit of the pull request is itself in the history of the merge
  commit without a merge commit of its own: the default branch was moved to
  it by fast-forward, or the branch was pushed there. The first parent of
  such a commit is a commit of the pull request, and a range from it would
  leave out what the commits before it changed;
- a merge commit whose second parent is the head while the first parent
  already held that head;
- a merge commit with two parents whose second parent is not the head, with
  more than two parents, or with none.

A change the default branch made itself lies in no range and is not counted,
with the exception named above: the commits right before a squash merge, as
many as the pull request has commits less one, and the commits right before
the replayed commits of a rebase merge, as many as the pull request has merge
commits and commits the replay dropped.

### The pull request that brought the spec

Condition 3 ties the pull request to the spec. What it guarantees is this
claim, and no more: the check after the merge approves only when

- the spec is `proposed` with the digest judged at the tip at the approved
  head commit, and is not so at the one merge base of that head with the first
  parent of the merge commit; and
- some measured first-parent step of the default branch goes from another
  state to that state.

Both parts are one question about the two ends of a range (`arrives` in
`src/approve/binding.ts`). At a commit the spec is in one of four states:

| State | The spec at the commit |
|---|---|
| `absent` | no `spec.md` that parses |
| `not-proposed` | a `spec.md` that parses with another status than `proposed` |
| `proposed-other` | `proposed`, with another digest than the tip has, or with none |
| `proposed-tip` | `proposed`, with the digest judged at the tip |

The state judged at the tip arrives over a range when the spec is
`proposed-tip` at its end and is not at its start: three of the sixteen pairs.
A range whose end is in another state never counts, whatever its start is. So
a spec that is a draft, or is not there, at both ends of a step was not
brought by it, and neither was one that arrives at a text the tip does not
hold.

The first part is asked over the reviewed commits in both shapes. For
`single-commit` the range is the one conditions 2, 7 and 8 measure as well.
For `merge-commit` the merge base of the head with the first parent is read
for this condition alone, and the ranges of conditions 2, 7 and 8 stay as
they are; no merge base is `git-failed` and several are
`ambiguous-merge-base`, for condition 3 only. The second part asks each
measured step on its own, not the two ends of all steps: a pull request that
puts an earlier text back right after another one changed it leaves both ends
equal.

When a part does not hold, the condition is `spec-not-in-merge`, and the
message says which. That refuses:

- a later pull request that only edits another file: the spec is
  `proposed-tip` at both ends of its steps and of its reviewed commits;
- a pull request merged while the default branch held the spec as a draft,
  when a later push proposes it again: the spec is a draft at both ends of the
  step;
- a merge commit whose own tree proposes the spec while the reviewed commits
  never touched it: the step arrives, the reviewed commits do not;
- a merge commit the host names where the spec is at neither end of a
  measured step, or is `proposed-tip` at both.

It approves a pull request that only proposes a draft the default branch
already held (the status is no part of the digest, and the state arrives over
it), an approved edit, and an approved pull request that puts an earlier text
back.

The claim does not say that the approver was shown the change; see "Known
gaps".

### The measuring base and `base` after the merge

The measuring base of the open mode, the merge base of `HEAD` and the default
commit, is not used after the merge: `HEAD` is the default commit, so that
merge base is the tip itself and nothing would differ from it. The ranges of
the merge take its place for conditions 7 and 8.

No range starts at `base`, and none at the base commit the host reports. A
base the host reports can be older than the first parent of the merge commit:
measured from it, a settings file the merge puts back to its old text shows no
change. `base` keeps its one use, the comparison with the base the host
reports in condition 2 (`base-mismatch`, `base-not-on-default`), and the
report is the same with and without it but for `reference`.

The final lint of condition 4 is given `repo` and `defaultRef`, as in the open
mode. Its diff base is then the tip itself, so its rules that measure a change
(`spec-changes-config`, and `bindings-log` against a log merged before)
compare the tip with itself and report nothing the pull request did. What the
pull request changed under `.spec-gate/` and to other specs is measured by
conditions 7 and 8. A `bindings.log` it replaced is not: see "Known gaps".

### In a job after the merge

- Run it for the pull request the host names for the merge (the event of the
  merge or the pull request the host associates with the pushed commit),
  never for a number taken from text.
- Check out the commit `--default-ref` names, with the complete history of the
  default branch (for example `fetch-depth: 0`). A shallow repository is
  refused (`shallow-repository`, exit 1): at a shallow boundary a commit shows
  no parents, so a merge commit is not recognised, and a hidden merge base
  makes git report an older one, from which the reviewed range shows another
  change than the pull request made.
- Bring the head commit of the pull request into the repository before the
  check, with its history down to the default branch. The check never fetches.
  On GitHub that commit stays readable as `refs/pull/<number>/head` after a
  squash or rebase merge.
- `--base` is optional and nothing is measured from it.
- The exit codes are those of the open mode: 0 only for `approved: true`. An
  open pull request with `--merged` exits 1 (`not-merged`).
- When the default branch moves on, the answer of an earlier run is about an
  earlier tip. Run the check again to have it for the new one.

## Report

Format `spec-gate-approve/1`. The report is deterministic: the same
repository state and the same host facts give the same report. It holds no
time, no absolute path, and nothing a host adapter threw.

| Field | Meaning |
|---|---|
| `format` | `spec-gate-approve/1` |
| `mode` | `open`, or `merged` for the check after the merge |
| `spec` | the frontmatter `id` at the commit that was judged (the head; after the merge the tip of the default branch), or `null` |
| `path` | the spec directory in the repository, `specs/<name>` |
| `approved` | true only when every condition holds |
| `approve_reported` | true when an approving review stands on the head (condition 1 holds) and condition 5 is `approval-not-verifiable` or condition 6 is `approval-not-enforced`: an approve was seen, an approval is not claimed. Never true together with `approved` |
| `head` | `HEAD` of the checkout: in the open mode the commit that was judged. After the merge that commit is `default_commit`, and condition 4 holds only when `head` equals it |
| `reference` | the base commit that is compared with the base the host reports: `base` when given, else `default_commit`. No condition measures from it; conditions 4, 7 and 8 measure from the one merge base of `head` and `default_commit` |
| `default_commit` | the commit `defaultRef` names; the settings were read there |
| `digest` | the digest of the spec at the commit that was judged, or `null` |
| `pull_request` | `number`, `author`, `head`, `base`, `target_ref` as the host reports them, or `null` when the host failed |
| `merge` | after the merge, the merge as it was measured: `commit` (the merge commit the host reports), `first_parent`, `shape` (`merge-commit` or `single-commit`), `reviewed_base` (the merge base of the reviewed range, `null` for `merge-commit`), `commits` (how many first-parent steps were measured) and `ranges` (each with `from` and `to`: the steps, the last one first, then the reviewed range). `null` in the open mode, and after the merge when no range could be derived; conditions 2, 7 and 8 then say why |
| `conditions` | eight entries: `condition`, `name`, `ok`, `code`, `message` |
| `approvals` | every approval that stands, on the head or not: `login`, `commit`, `at_head`, `problem` (`null` for an approver that counts). After the merge the head is the head commit the host reports for the pull request |
| `last_config_commit` | `commit` and `approver` of the last change under `.spec-gate/`; `null` is unknown |
| `commands` | the commands the spec at the commit that was judged refers to, each with `name` and `argv`, sorted by name; `null` when they cannot be read (see "Commands") |
| `gaps` | the checks the approval does not make, each with a `code` and a `message`; a gap never changes `approved` |

### Commands

`commands` shows the reader what a runner may start for the spec:

- every command a test-plan row names with `check_command_ref`;
- the command of the set that carries `{selector}`, when the set has one. It
  is what a runner starts for every row whose binding has a selector, and it
  is listed whatever the bindings say: a binding can gain a selector after the
  approval.

`spec.md` and `testplan.yaml` are read from git at the head, the set from
`.spec-gate/commands.yaml` at the `commands_ref` of that spec, through the
readers of the digest (see [digest.md](digest.md)). The set is never read at
the tip of the default branch, at the head or from the work tree: a set that
changed since `commands_ref` is not what the spec binds. Each entry has the
`name` and the `argv` list, element for element, `{selector}` left as it is
written. The entries are sorted by name, by code units. No other command of
the set is listed.

When the commands cannot be read, `commands` is `null` and `gaps` holds
`commands-not-resolved` with the reason in its message: `spec-unreadable`,
`testplan-unreadable`, `commands-ref-unresolvable`, `commands-file-missing`,
`commands-file-invalid`, `command-ref-unknown` (a row names a command the set
lacks) or `git-failed`. A set that cannot be read is never shown as an empty
list. An empty list means a set was read, no row names a command and no
command carries `{selector}`.

The field is not a condition and changes none: the list of conditions is the
same with and without it. What it shows is bound elsewhere. `commands_ref` and
the argv list of every command a row names are part of the digest (condition
3), and the final lint (condition 4) refuses a `static` row that names a
command the set lacks. A spec without such a row, in a repository without a
command set, can therefore be approved with `commands: null`.

## CLI

```
spec-gate approve-check <spec-dir> --repo <dir> --default-ref <ref> [--base <commit>]
    --github-repo <owner/name> --pr <number> [--api-url <url>] [--merged]
```

runs the check for one open pull request on GitHub and prints the report as
one JSON line on stdout. It makes one GitHub adapter (see "GitHub adapter")
and calls `checkApproval` once. The code is `runApproveCheck` in
`src/approve/verb.ts`. With `--merged` it runs the check after the merge for
one merged pull request (see "After the merge" and "In a job after the
merge").

| Argument | Meaning |
|---|---|
| `<spec-dir>` | `specDir` |
| `--repo`, `--default-ref`, `--base` | the inputs of the same name; `--repo` and `--default-ref` are required |
| `--github-repo` | `repository` of the adapter: `<owner>/<name>` of the repository the pull request targets; required |
| `--pr` | the number of the pull request: digits only, 1 or more; required |
| `--api-url` | `apiUrl` of the adapter; `https://api.github.com` when left out |
| `--merged` | `merged: true`: the check after the merge. It takes no value |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | a report whose `approved` is `true` |
| 1 | a report whose `approved` is not `true`; the conditions in the JSON line say why |
| 2 | no report: a usage error, a refusal of the check, an option the adapter refuses, a missing token or an exception. stderr says which, stdout is empty |

Only exit 0 means approved. A job that reads "the command ran" as a pass is
wrong for 1 and for 2 alike.

Exit 0 without a report exists, and a job must not read it as an approval:

- `--version` and `-V` anywhere on the command line, among the arguments of
  the verb too, print the version and exit 0. They are options of the
  program, which reads them before the verb does.
- `spec-gate help approve-check` and `spec-gate --help` print help and exit 0.

So a job must also require the JSON line with `approved: true` on stdout;
help and version print none. `--help` and `-h` among the arguments of the
verb are no help request: the verb has no help option of its own, they are
arguments it does not know, and the exit code is 2. A job that takes the spec
directory from the pull request (a changed path) passes it after `--`, so
that a value which starts with `-` is read as the directory and refused, not
as an option.

All of this holds from the verb name on. Arguments before the verb name are
handled by the program, not by the verb: an option the program does not know
there is reported on stderr with the usage, and the exit code is 1 with an
empty stdout, not 2. The report names the option and never repeats its value
(`--token=<redacted>`, in the `--name=value` form; a short option with
something attached, `-tVALUE`, is reported as `-t<redacted>`; the value of
`--name value` is not part of the report at all). A bare argument there is not
an option: it is reported as an unknown command and printed as it is, so the
token is passed in `GITHUB_TOKEN` only, never on the command line.

A host that answers with an error or cannot be reached is not a refusal: the
conditions that needed its facts are `host-failed`, the report is printed and
the exit code is 1.

### Token

The token is read from the environment variable `GITHUB_TOKEN` and from
nowhere else. There is no option for it. Without the variable, or with an
empty one, the verb exits 2 and names the variable.

The token is not printed:

- the report holds no field for it, and the adapter does not use an answer of
  the host that repeats it (see "Errors and limits");
- a refusal names the input that is wrong and never its value;
- an argument or option the verb does not know is refused without being
  repeated on stderr, so a token passed as `--token=...` by mistake after the
  verb name is not printed either. Before the verb name the program handles
  the argument and repeats it on stderr (see "Exit codes"): a token put
  there by mistake is printed;
- before anything is written, both outputs are searched for the token, as it
  is and as a JSON text holds it. An output that holds it is withheld as a
  whole and the verb exits 2.

The permissions the token needs are listed under "Token and permissions".

### In a pull request job

- Check out the head commit of the pull request, not a merge of it. A pull
  request job of GitHub Actions checks out a merge of the head with the
  target branch unless it is told the head commit; at such a merge condition 1
  is `head-mismatch` and the exit code is 1.
- Fetch the default branch with its history before the check. The check
  never fetches: it needs the commit `--default-ref` names (for example
  `refs/remotes/origin/main`) and the merge base of that commit and the head.
- The checkout must hold the complete history of the head and of the default
  branch (for example `fetch-depth: 0`). A shallow repository is refused:
  conditions 2, 4, 7 and 8 are `shallow-repository` and the exit code is 1. A
  shallow boundary can hide the true merge base, so that git reports an older
  one and the conditions that measure from it see less than the merge changes.
  When `HEAD` and the default ref share no history the checkout can see (a
  clone of depth 1, for one), the check refuses before that test, as for git
  inputs that do not resolve: exit 2, no report and no word about a shallow
  repository. The remedy is the same full-history checkout.
- `--base` is optional. When given, it must lie on the default ref and be
  the base commit the host reports for the pull request (`base-mismatch`
  otherwise). Nothing is measured from it: the report is the same with and
  without it, but for `reference` and condition 2.
- When the report says `ambiguous-merge-base`, merge the tip of the default
  branch into the pull request branch (or rebase onto it) and run the check
  on the new head.
- For a host other than github.com, give its API root as `--api-url`.
- Whether the pull request can change the job that runs the check is a
  property of the host setup, outside this command.

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
- report `merged: true` only when the host itself says the pull request was
  merged, and then `mergeCommit` as the commit the merge put on the target
  branch (the merge commit, the one commit of a squash merge, the last commit
  of a rebase merge). For a pull request that is not merged `mergeCommit` is
  `null`: a trial merge the host computed for an open pull request is never
  reported;
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

`ciRunStatus(commit, run)` (`verified`, `unverified`, `unknown`) is part of
the interface for the evidence checks; the approval check does not call it.
`run` is the host's own name of a CI run: its id, or its address on the host.
`verified` means only that such a run exists in this repository, has completed
and ran at `commit`. It does not say which workflow ran, how the run ended, or
that a given evidence file came out of it.

## GitHub adapter

`createGitHubHost` in `src/host/github.ts` is a `HostAdapter` for one pull
request of one repository, over the GitHub REST API. `spec-gate approve-check`
makes one per run (see "CLI").

```ts
import { createGitHubHost } from "./src/host/index.js";

const host = createGitHubHost({
  repository: "acme/widgets",
  pullRequest: 7,
  token,
});
```

| Option | Meaning |
|---|---|
| `repository` | `<owner>/<name>`, the repository the pull request targets: letters, digits, `-` and `_`, and `.` in the name |
| `pullRequest` | the number of the pull request, a positive integer |
| `token` | a token that may read the repository: printable ASCII without a space |
| `apiUrl` | the API root, `https://api.github.com` when left out. It must be `https:`; `http:` is accepted only for the loopback hosts `127.0.0.1`, `[::1]` and `localhost`. It carries no credentials, query or fragment. A value that is not a text, `null` included, is refused and not read as left out |
| `fetch` | a replacement for the global `fetch`: a seam for tests |

An option that does not fit is refused when the adapter is made, before
anything is sent, and the refusal does not repeat the value.

One adapter is one view of the host. It asks for the pull request and for the
enforcement once and keeps the answer, a failure too, so the branch whose
enforcement it reports is the branch it reports as the target. Reviews, the
last change under `.spec-gate/` and CI runs are asked for on every call. Make
a new adapter for a new check.

### Requests

Every request is a `GET` with `Accept: application/vnd.github+json` and an
`X-GitHub-Api-Version` header that pins one version of the API
(`GITHUB_API_VERSION` in `src/host/github.ts`, the version the mapping below
was checked against). The paths are below `/repos/{owner}/{repo}`; `{branch}`
is `base.ref` of the pull request.

| Method | Requests | Described in the GitHub REST documentation under |
|---|---|---|
| `pullRequest()` | `/pulls/{number}` | "Get a pull request" |
| `reviews()` | `/pulls/{number}/reviews`, every page | "List reviews for a pull request" |
| `reviewEnforcement(path)` | `/rules/branches/{branch}`, every page; then `/branches/{branch}/protection` | "Get rules for a branch", "Get branch protection" |
| `lastConfigCommit()` | `/commits?sha={branch}&path=.spec-gate&per_page=1`; `/commits/{sha}/pulls`, every page; `/pulls/{n}/reviews`, every page | "List commits", "List pull requests associated with a commit" |
| `ciRunStatus(commit, run)` | `/actions/runs/{id}` | "Get a workflow run" |

The pull request: `author` is `user.login`, `head` is `head.sha`, `base` is
`base.sha` and `targetRef` is `refs/heads/` followed by `base.ref`. `merged`
is the boolean `merged`, and an answer without it throws. `mergeCommit` is
`merge_commit_sha` for a merged pull request, where it must be a full commit
id, and `null` for every other one: for an open pull request that field holds
the trial merge GitHub computed, which is on no branch, and it is not read.
`merged_at` and `state` of the pull request are not read: a closed pull
request is not a merged one.
`base.repo.full_name` must name the repository the adapter was made for (the
case of the ASCII letters aside) and `number` must be the number asked for;
otherwise the method throws. The head may lie in a fork. The title, the body,
the labels and the branch name of the head are not read.

A review: `login` is `user.login`, `state` is `state`, `commit` is `commit_id`
and `submittedAt` is `submitted_at`. A `PENDING` entry was never submitted and
is left out. Any other state outside `APPROVED`, `CHANGES_REQUESTED`,
`COMMENTED` and `DISMISSED` throws, and so does an entry without a login, a
full commit id or a time with a zone: a review that cannot be read is never
dropped, because the reviews that remain would then tell another story. That
holds for a review whose commit the host no longer has (`commit_id` is `null`)
and for a review without a user as well: such a pull request stays
`host-failed`.

### Pages

A list is asked for 100 entries at a time. Per "Using pagination in the REST
API", a response whose list goes on carries a `Link` header with a
`rel="next"` entry. The adapter reads a further page when that entry is there
or when the page is full, so a full page whose header is missing is not taken
for the end. The next link must stay on the origin of the API root, name the
same list (under `/repos/{owner}/{repo}` or, as GitHub writes it,
`/repositories/{id}`) and name the page that follows; a link that does not is
an error, as is a header that cannot be read. The page itself is then
requested at the adapter's own path: the token is never sent to an address
taken from a header. At most 30 pages of one list are read; a longer list is
an error, never a shortened list.

### Enforcement

`enforced` needs positive evidence that every pull request into the target
branch needs at least one approving review. Two sources can give it:

- a ruleset: `/rules/branches/{branch}` lists a rule of type `pull_request`
  whose `parameters.required_approving_review_count` is 1 or more. Per "Get
  rules for a branch" the list holds the active rules that apply to the
  branch, from the repository and from the organization, and leaves out the
  rules of rulesets in `evaluate` or `disabled` mode;
- a classic branch protection: `/branches/{branch}/protection` answers with
  `required_pull_request_reviews.required_approving_review_count` of 1 or
  more.

The ruleset is asked first, and the classic protection only when the ruleset
does not prove the review.

| Rulesets | Classic protection | Answer |
|---|---|---|
| require an approving review | not asked | `enforced` |
| no such rule, or not readable | requires an approving review | `enforced` |
| readable, no such rule | readable, no such requirement | `not-enforced` |
| anything else | | `unknown` |

A source is not readable when it answers 403 or 404. "Get branch protection"
documents 404 without saying whether the branch has no protection or the
token may not see it, and "Troubleshooting the REST API" names 404 as the
answer to a request that may not see a private resource. So the adapter does
not tell the two apart: a branch without a classic protection and without a
ruleset that requires the review is reported as `unknown`, not as
`not-enforced`. Both fail condition 6.

A required code-owner review (`require_code_owner_review` in a ruleset,
`require_code_owner_reviews` in a classic protection) with a review count of
0 is not evidence: the adapter does not read a code-owners file and cannot
say which paths it covers. Who may bypass a rule (the bypass list of a
ruleset, `enforce_admins` and the bypass allowances of a classic protection)
is not read either; see "Admin bypass" under "Known gaps". Any actor on such
a list (a role, a team, an app, not only an administrator) can merge without
the review while the adapter reports `enforced`.

Rulesets and branch protections hold for a branch, not for a path, so the
answer is the same for `specs/` and `.spec-gate/`.

### Last change under `.spec-gate/`

`commit` is the first entry of the commits of the target branch that touch
the path `.spec-gate`, or `null` when there is none. The adapter asks for
that path as it is written here: a change under a directory spelled in
another case, such as `.Spec-Gate`, is not seen here (the lint rule of
condition 7 does see it).

`approver` is looked up through the pull requests the host associates with
that commit. Exactly one of them must be merged, into the target branch of
this repository, with that commit as its `merge_commit_sha`. An approval of
that pull request counts only when it is tied to what was merged: it was
submitted on the head commit of the merged pull request (`head.sha`) and not
after the merge (`merged_at`). The approver is then the account whose
approval stood at the merge and was submitted last, by the rule of condition
1 (on a tie, the first account in order). So none of these names an approver:

- (a) an approval of an earlier commit, when more was pushed before the
  merge;
- (b) a later approval of an older commit, whoever gave it;
- (c) an approval submitted after the merge. A review after the merge does
  not take an earlier approval away either.

In every other case `approver` is `null`: a change that was pushed without a
pull request; usually a pull request merged with a merge commit, since the
commit that changed the files is then a commit of the merged branch and not
the merge commit; a merged pull request whose head commit or merge time the
host does not give in a readable form; and reviews of that pull request that
cannot be read as reviews (an entry without a user, without a commit or with
an unknown state, or more pages than the cap). `null` is "unknown" and does
not fail condition 6, so one unreadable review on an old pull request does
not fail the fact for every pull request of the repository. A request that
fails (a status other than 200, a time limit, a body over the cap or a body
that is not a JSON list) still throws.

### CI runs

`run` is a run id (digits) or the address
`https://github.com/{owner}/{repo}/actions/runs/{id}` of a run of the same
repository; anything else is `unverified` and nothing is asked. The address
is read only when the API root is `https://api.github.com`: on another root
the id in it would name another run than the one the address shows, so the
answer is `unverified` and nothing is asked. So is a `commit` that is not a
full commit id. Then `verified` needs all of: the run
exists (404 is `unverified`), its `repository.full_name` is this repository,
its `head_sha` is `commit` and its `status` is `completed`. The remaining gap:
any workflow of the repository counts, whatever started it and however it
ended, and a run address on another host than `github.com` is never
verified. This adapter never answers `unknown`.

### Errors and limits

The adapter throws instead of guessing, and the approval check turns that
into `host-failed`:

- any status other than 200, except the ones named above (403 and 404 for a
  source of the enforcement, 404 for a CI run);
- a redirect. Redirects are not followed, so the token does not travel to
  another address;
- a rate limit: 403 or 429 with `x-ratelimit-remaining: 0` or a `retry-after`
  header ("Rate limits for the REST API"). The error says `rate limited`, and
  the request is not repeated. With one of these headers a rate limit is
  never read as a missing permission. A secondary rate limit that carries
  neither is known only by the text of its message, which the adapter does
  not read: on a source of the enforcement it counts as not readable, which
  fails condition 6 as well;
- a request that takes longer than 10 seconds, headers and body together;
- a body over 4 MiB, a body that is not UTF-8 or not JSON, and a field that
  is missing or of another type;
- a body that holds the token in any text or key.

The message of a failed request holds the method, the path the adapter built,
the status and one fixed phrase, for example `github: GET
/repos/acme/widgets/pulls/7 answered 403 (rate limited)`. It never holds the
token, a response body or a header, and the error carries no cause. The path
can hold the name of the target branch and a commit id as the host reported
them, both only after their form was checked; nothing else of a response
reaches a message.

### Token and permissions

The token is sent as `Authorization: Bearer` and nowhere else, only to the
API root, and only over TLS or to a loopback host. The adapter object does not
hold it.

Reading needs these repository permissions ("Permissions required for
fine-grained personal access tokens"; in a workflow the keys of
`permissions:`):

| Permission | For |
|---|---|
| Pull requests: read (`pull-requests: read`) | the pull request, its reviews, the pull requests of a commit |
| Contents: read (`contents: read`) | the commits of the target branch |
| Actions: read (`actions: read`) | CI runs |
| Metadata: read (every token has it) | the rules of rulesets |
| Administration: read | the classic branch protection |

The token of a workflow run cannot be given the administration permission.
With such a token the classic protection is not readable, and a repository
that enforces the review through a classic protection alone gets `unknown`.
A branch without any classic protection gets `unknown` the same way,
because the host answers both cases alike.
A ruleset is readable with every token that can read the repository.
With a workflow token, enforce the review through a ruleset: classic
protection alone reads as `unknown` and the check fails closed.

## Known gaps

Named here instead of closed:

- `coldread-not-checked` (in `gaps` of every report): the cold-read digest is
  not compared, because no cold-read format exists yet.
- Admin bypass and every other bypass actor: who may bypass a ruleset or a
  branch protection is not read. That is the bypass list of a ruleset, and
  `enforce_admins` and the bypass allowances of a classic protection. Any
  actor on such a list (an administrator, a role, a team, an app) can merge
  without the review the adapter reports as enforced.
- `commands-not-resolved` (in `gaps` when `commands` is `null`): the commands
  of the spec could not be read at its `commands_ref`, so the report shows
  none. No condition depends on it.
- Squash merges: what lands on the default branch can differ from the head
  that was approved. The open mode judges the head of the pull request and
  says nothing about what was merged; the check after the merge compares the
  digest at the tip of the default branch with the digest at the commit of the
  approving review (see "After the merge"). A job that runs only the open mode
  leaves this open.
- Merges whose shape git cannot tell: after a fast-forward of the default
  branch to the head of the pull request, or a push of the branch, and for a
  merge commit that is not a merge of that head into the default branch, the
  check after the merge reports `merge-shape-unknown` and never approves.
  There is no setting that makes it pick a range for such a merge. The same
  holds for a pull request of more than 50 commits merged into one commit or
  replayed.
- A squash merge is measured like a rebase merge: git does not tell the two
  apart, so for a pull request of N commits the N - 1 commits of the default
  branch before a squashed commit are measured as if the pull request had
  made them. When one of them changed `.spec-gate/` or removed a proposed
  spec, the check after the merge does not approve that pull request. The
  same holds for a rebase merge of a pull request that holds merge commits or
  commits the replay drops: N counts them, the replay makes no commit for
  them, and as many commits of the default branch below the replayed ones
  are measured.
- Bindings after the merge: condition 4 measures the log at the tip from the
  approved head and from the start of every measured first-parent step, not
  from a commit of the default branch after the merge commit. An entry that
  a later pull request appended there and a still later commit rewrote (with
  a recomputed hash chain and bindings that match it) is not noticed, as
  long as the log the approved head holds is still extended and the bindings
  at the tip are the replay of the entries after it. The removal of a log is
  noticed in both modes, by condition 8. Nor is `bindings.yaml` at the
  approved head compared with the head's own log when the propose commit
  already lies on the default branch: a head whose bindings were changed by
  hand without an entry is refused right after the merge, but approved once
  a later commit of the default branch puts the bindings back to what the
  log replays.
- Which pull request, in the open mode: an approval of a commit counts for
  every spec in the tree of that commit, whether the pull request changed
  that spec or not. The check after the merge asks that the pull request
  brought the spec to the state judged at the tip (`spec-not-in-merge`); the
  open mode does not.
- An approval given before the default branch moved, after the merge: the
  binding of condition 3 reads the states of the spec at commits, not when a
  review was given. A spec is on the default branch as proposed; a branch
  first sets it back to draft and then restores the same text beside another
  change, so that the approver is shown that other change alone; then the
  first commit alone reaches the default branch, and the pull request is
  merged. At that point git shows what a pull request shows that only
  proposes a draft the default branch held, which must be approved, so the
  check approves this one too. Telling the two apart needs a fact of the
  host about the order of the review and the move of the base, which the
  adapter does not supply. A decided boundary; whether a host dismisses a
  review when the base of a pull request changes is a setting of the host.
- A second pull request with the same commits: when a pull request whose
  commits hold a spec that already landed (the same commits, or a cherry-pick
  of them) is squashed within N - 1 commits after the commit that brought that
  spec, or rebase merged within as many commits as it has merge commits and
  commits the replay drops, the measured steps hold that landing and the
  reviewed commits hold the spec, so it is taken for the one that brought it.
  The state is judged against the digest at the tip, so this holds even when
  that pull request was squashed with another text and the approved text was
  put back on the tip later.
- The merge commit and the head are the host's word: the check verifies that
  the merge commit is on the default branch and reads its history from git,
  and cannot verify that it is the commit that merged this pull request. A
  host that names another commit moves the measured steps: when they still
  hold the commit that brought the spec, they are measured as they are, and
  when no step of them brings the spec to the state judged at the tip, the
  condition is `spec-not-in-merge`. Named later by fewer
  commits than the pull request has, the steps can leave out the first
  commits of a rebase merge. The number of steps comes from the head commit
  the host reports, so the check relies on the host to report the head that
  was merged.
- Enforcement is the host's word: the check cannot verify a ruleset, it
  relays what the adapter reports.
- The check reads the work tree once for the lint and compares it with the
  head before; a file changed between the comparison and the lint is not
  noticed.
