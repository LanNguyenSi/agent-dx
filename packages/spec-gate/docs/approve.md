# Approval check

A spec in the tree is `draft` or `proposed`. There is no `approved` status to
write: "approved" is derived, each time it is asked for, from facts about the
pull request that carries the spec. `checkApproval` in `src/approve/` is that
derivation. It is a library function; the CLI verb `spec-gate approve-check`
calls it for a pull request on GitHub (see "CLI").

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
of the lint and the start of the lint's diff base, and nothing else.
Conditions 7 and 8 do not measure from it: their diff base is the merge base
of the head with the commit `defaultRef` names, whether `base` is given or
not (see "7. Nothing under `.spec-gate/` changes"). The settings
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

A report is not an approval either: it says `approved: true` or
`approved: false`. The CLI verb keeps the three apart by its exit code (see
"CLI").

## Conditions

`approved` is true only when all eight conditions hold. The report has one
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
| 7 | `config-untouched` | no file under `.spec-gate/` differs between the merge base of the head with the default branch and the head |
| 8 | `repo-check-clean` | the repository check has no finding between the merge base of the head with the default branch and the head: no protected spec disappears, changes its id, goes back to `draft` or loses its log |

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

No path under `.spec-gate/` differs between the diff base and the head. This
is the lint rule `spec-changes-config`, called as it is: the first path
component is compared without regard to case.

The diff base of this condition and of condition 8 is
`merge-base(HEAD, default commit)`, the default commit being the one
`defaultRef` names. It is not taken from `base`. A base commit says where the
pull request started, and a host can report one that is older than a commit
of the default branch the head has merged since. Measured from that older
commit, a settings file the pull request puts back to its old text shows no
change, although merging the pull request would undo what the default branch
decided in between (an approver taken off the list, for one). Measured from
the default branch it shows. `base` must be the default commit or an ancestor
of it, so this diff base is never the older of the two.

A change the default branch made itself does not count, before or after the
pull request merged it. The final lint of condition 4 keeps the base it was
given: with a base older than a merged default commit that changed the
settings, its own `spec-changes-config` reports that change and condition 4
fails, while this condition holds. When the merge base with the default
commit cannot be found, the condition is `git-failed`.

Codes: `spec-changes-config`, `git-failed`.

### 8. The repository check is clean

The repository check (see "Repository check" in [lint.md](lint.md)) has no
finding. It is `checkRepository`, the function behind `spec-gate repo-check`,
called as it is over the tree of the diff base and the tree of the head, both
read from git. The diff base is the one of condition 7,
`merge-base(HEAD, default commit)`, whether `base` is given or not: a spec the
default branch gained after the base the host reports, which the head has
merged and then deletes, is in the tree the walk starts from. So a pull
request that carries an approved spec and, beside it,
deletes another proposed spec, changes its id, puts it back to `draft` or
removes its `bindings.log` is not approved.

- The work tree is not asked. A spec the head deletes stays deleted when the
  file is restored in the work tree without a commit, and a spec the head
  holds is not a finding when the work tree lacks it.
- The whole tree is walked, not only `specs/`: a protected `spec.md` anywhere
  counts, as for `repo-check`.
- The diff base is the merge base, not the tip of the default branch: a spec
  merged there after the pull request forked, which the head has not merged,
  is not counted as removed.

A finding is `repo-check-findings`. The message gives the number of findings
and, for the first 20 in the order of the repository check (by path, then
code), the code and the path, the path quoted as a JSON text; the rest is
counted (`(and 3 more)`). A tree over a cap of the repository check is
`tree-too-large`: a tree that was not read in full is never passed.

This condition covers the pull requests `approve-check` runs on. A pull
request without a spec to approve deletes a spec just as well, so
`repo-check` still runs on every pull request.

Codes: `repo-check-findings`, `tree-too-large`, `git-failed`.

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
| `reference` | the reference commit of the final lint: `base` when given, else `default_commit`. Conditions 7 and 8 measure from the merge base of `head` with `default_commit` |
| `default_commit` | the commit `defaultRef` names; the settings were read there |
| `digest` | the digest of the spec at the head, or `null` |
| `pull_request` | `number`, `author`, `head`, `base`, `target_ref` as the host reports them, or `null` when the host failed |
| `conditions` | eight entries: `condition`, `name`, `ok`, `code`, `message` |
| `approvals` | every approval that stands, on the head or not: `login`, `commit`, `at_head`, `problem` (`null` for an approver that counts) |
| `last_config_commit` | `commit` and `approver` of the last change under `.spec-gate/`; `null` is unknown |
| `commands` | the commands the spec at the head refers to, each with `name` and `argv`, sorted by name; `null` when they cannot be read (see "Commands") |
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
    --github-repo <owner/name> --pr <number> [--api-url <url>]
```

runs the check for one open pull request on GitHub and prints the report as
one JSON line on stdout. It makes one GitHub adapter (see "GitHub adapter")
and calls `checkApproval` once. The code is `runApproveCheck` in
`src/approve/verb.ts`.

| Argument | Meaning |
|---|---|
| `<spec-dir>` | `specDir` |
| `--repo`, `--default-ref`, `--base` | the inputs of the same name; `--repo` and `--default-ref` are required |
| `--github-repo` | `repository` of the adapter: `<owner>/<name>` of the repository the pull request targets; required |
| `--pr` | the number of the pull request: digits only, 1 or more; required |
| `--api-url` | `apiUrl` of the adapter; `https://api.github.com` when left out |

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
there is repeated on stderr with the usage, and the exit code is 1 with an
empty stdout, not 2.

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
- `--base` is optional. When given, it must be the base commit the host
  reports for the pull request (`base-mismatch` otherwise). It sets the
  reference of the final lint; conditions 7 and 8 measure from the default
  branch with and without it.
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
`base.sha` and `targetRef` is `refs/heads/` followed by `base.ref`.
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
A ruleset is readable with every token that can read the repository.

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
  that was approved. This check judges the head of the pull request; comparing
  the digest on the default branch with the digest at the commit of the
  approving review is a separate, later check.
- Enforcement is the host's word: the check cannot verify a ruleset, it
  relays what the adapter reports.
- The check reads the work tree once for the lint and compares it with the
  head before; a file changed between the comparison and the lint is not
  noticed.
