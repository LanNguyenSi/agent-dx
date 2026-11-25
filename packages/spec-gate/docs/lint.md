# Lint

`spec-gate lint <spec-dir>` checks a spec directory and prints one JSON
report line. It is deterministic: the same files give the same report, byte
for byte, and the report holds no absolute path and no time. The engine
reads the spec directory's files; it never runs a command, and it reads a git
repository only when it is given a reference (see "Git inputs"), offline and
read-only: it never fetches and never writes.

```
spec-gate lint <spec-dir> [--strict] [--final] [--profile <light|full>] [--config <path>]
                          [--repo <dir>] [--default-ref <ref>] [--base <commit>]
spec-gate lint-ack <spec-dir> <rule> <id> --reason <text>
spec-gate propose <spec-dir> --repo <dir> (--default-ref <ref> | --base <commit>)
spec-gate bind <spec-dir> <tp-id> --status <new|existing> [--selector <s>] [--file <path>]
               [--fixtures <path>]... [--notes <text>]
```

`propose` and `bind` change the state of a spec and are described under
"Propose and bind" below.

## What is read

| File | Required | Read as |
|---|---|---|
| `spec.md` | yes | the spec grammar in [formats.md](formats.md) |
| `testplan.yaml` | yes | the test-plan format |
| `bindings.yaml` | no | the bindings format |
| `questions.json` | no | the questions format |
| `triage.json` | no | the triage format; decides the profile |
| `source/meta.json` | no (the full profile reports its absence through `ledger-complete`) | `base_commit` and `commands_ref` (each a full commit id, 40 or 64 lower-case hex digits, both required) and the source line list (`lines[]`, each `{ id, kind }`) |
| `acks.yaml` | no | acknowledged warnings, see below |
| the file given to `--config` | no | repo-wide settings in `.spec-gate/config.yaml` format; it sits outside the spec directory and is only read for `--config`, which cannot be combined with git inputs |
| `.spec-gate/config.yaml` at the reference commit | no | the same settings, read from git instead of a path when git inputs are given; see "Git inputs" |

Every read refuses a symlink and anything that is not a regular file (a file
below a directory that is a link counts), refuses a file over 4 MiB, and
decodes UTF-8 strictly. Each problem is an error finding, never an
exception and never exit 2:

- rule `file`: the file is missing (only for a required file), or its code is
  one of `input-missing`, `input-unreadable`, `input-not-regular`,
  `input-too-large`, `input-not-utf8`.
- rule `format`: the file does not parse. The format error's `code` and
  `path` are carried through, and `id` is set when the path starts with an ID.

A file that did not parse is skipped by every rule that needs it. A broken
`testplan.yaml` gives its format errors and no "AC is uncovered" findings.

## Report

One line on stdout, format `spec-gate-lint/1`:

```json
{"format":"spec-gate-lint/1","spec":"<frontmatter id or null>","mode":"lint","profile":"full","profile_source":"triage","status":"draft","ok":true,"errors":[],"warnings":[],"acked":[],"skipped":[],"counts":{"errors":0,"warnings":0,"acked":0}}
```

| Field | Meaning |
|---|---|
| `spec` | the frontmatter `id`, or `null` when `spec.md` did not parse |
| `mode` | `lint`, or `final` with `--final` |
| `profile` | `full` or `light` |
| `profile_source` | `triage`, `flag` or `default` |
| `status` | the frontmatter `status`, or `null` |
| `ok` | no error, and with `--strict` no unacknowledged warning |
| `errors`, `warnings` | findings |
| `acked` | acknowledged warnings, each a finding plus `reason` |
| `skipped` | the rules not evaluated in this run, each `{ rule, reason }`, sorted by rule id |
| `counts` | the length of `errors`, `warnings` and `acked` |

A finding is `{ rule, level, file, path, id?, line?, code?, message }`:

- `file` is relative to the spec directory. A finding about a repository file
  outside it names `repo:<path relative to the repository root>` instead. A
  finding about the file given to `--config` names `config:<basename of that
  path>` (for example `config:config.yaml`); the caller's path never appears
  in the report, and its message names the basename only.
- `path` is dotted like the format layer: `$`, `AC-2`, `TP-1.kind`, `[0].rule`.
- `id` is the spec or test-plan ID the finding is about, or a target the rule
  defines (`triage` for `profile-default`).
- `line` is the 1-based line where the file is line oriented.
- `code` is the stable code of the underlying problem for `file` and `format`
  findings.
- `level` comes from the rule registry, never from the rule.

`skipped` names every rule that was not evaluated, with one reason: `profile`
(the rule does not run in the active profile), `gate` (a gated rule while the
status gate is closed), `input-absent` (an input the rule needs is not there),
`input-failed` (an input the rule needs or uses did not parse or could not be
read) and `no-git` (the rule needs a repository and no git input, neither
`--default-ref` nor `--base`, was given). A rule
that was evaluated and found nothing is not listed. Reasons are checked in the
order `profile`, `gate`, `no-git`, `input-failed`, `input-absent`; the first
that applies is the one named. `skipped` is sorted by rule id.

A skipped rule did not look, so it is not a pass. Under `--final`, which is the
run that gates `propose` and approval, every error rule skipped with reason
`no-git` or `input-absent` adds one error finding of the engine rule
`rule-skipped`: `file` and `path` are `$` (the run, not a file), `id` is the
skipped rule's id, `code` is the reason, and the finding cannot be
acknowledged. The reasons `profile` and `gate` are legitimate (the rule does
not apply, and no gate is closed under `--final`), and `input-failed` already
failed the run with the `file` or `format` error of the broken input, so none
of them adds a finding. Warning rules never add one. The `skipped` list stays
as it is. Without `--final` nothing changes. In practice a final run needs
git inputs, and every optional file that an error rule needs, such as
`triage.json` for `triage-stale` or `source/meta.json` for
`meta-frontmatter-mismatch`, must be there.

`errors`, `warnings` and `acked` are each sorted by `file`, `line` (a finding without a line first),
`path`, `rule`, `id` (none first) and `message`; strings compare by UTF-16 code
unit. Usage errors go to stderr as text, never into the report.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | no error finding, and with `--strict` no unacknowledged warning |
| 1 | the report has an error, or with `--strict` an unacknowledged warning |
| 2 | a usage error (unknown option, missing argument, a bad `--profile` value, a `--config` value with no file name or together with git inputs, a git input without `--repo` or that is refused, see "Git inputs"), a spec directory that is missing or not a directory, or an unexpected exception |

Help and version exit 0. `lint-ack` exits 0 when it wrote an entry and 2 on any
refusal. The two state verbs follow the same convention:

| Verb | 0 | 1 | 2 |
|---|---|---|---|
| `lint` | no error finding | findings | usage error, not a spec directory, unexpected exception |
| `lint-ack` | entry written | never | usage error, any refusal, unexpected exception |
| `propose` | `status: proposed` and `bindings.log` written | the final lint has an error finding (its report on stdout, nothing written) | usage error, any refusal (nothing written, except when the second write fails after the first: then `spec.md` is already proposed, see below), unexpected exception |
| `bind` | entry appended and `bindings.yaml` written | never | usage error, any refusal (nothing written, except when the second write fails after the first: then `bindings.log` already holds the entry, see below), unexpected exception |

A refusal is one line on stderr and nothing on stdout. `digest`, `triage` and
`intake file` keep their own exit codes.

## Propose and bind

`spec-gate propose <spec-dir>` moves a draft to `proposed`. It needs git
inputs, given and resolved as for the lint (see "Git inputs"), and refuses,
writing nothing, when they are missing (`--repo` alone is not enough), when
the spec directory is not `specs/<name>`, exactly one level below the
top-level `specs/` of the repository, when
the frontmatter `status` is not `draft`, when `bindings.log` already exists,
or when `spec.md` or `bindings.yaml` in the work tree is missing, not a
regular file, not committed at `HEAD` or not byte for byte the file at `HEAD`:
the propose entry hashes the committed `bindings.yaml`, so a spec without
bindings commits a `bindings.yaml` holding `{}`. Then it runs the lint as
`--final` with the same git inputs, in process. A report with an error
finding, a `rule-skipped` one included, is printed on stdout, exit 1, and
nothing is written. On a clean final lint it changes the frontmatter line
`status: draft` to `status: proposed` (no other byte of `spec.md` changes, so
the digest stays the same) and creates `bindings.log` with the propose entry
for the commit at `HEAD`; it prints `proposed <id> at <commit>`. Commit both
files next. `spec.md` is written first and `bindings.log` second: a run
stopped between the two leaves a proposed spec without a log, which
`bindings-log` reports. To recover, restore `spec.md` from `HEAD` (for example
`git checkout -- <spec-dir>/spec.md`) and run `propose` again.

`spec-gate bind <spec-dir> <tp-id> --status <new|existing>` is the one way a
binding changes after `proposed`. It refuses, writing nothing, unless the
status is `proposed`, the TP ID is a row of `testplan.yaml` and already a key
of `bindings.yaml` (no ID is added or renamed), `bindings.log` parses, the new
binding (built from `--status`, `--selector`, `--file`, every `--fixtures`
and `--notes`; an option left out is absent from the binding) passes the
bindings parser, and its status suits the row's kind: a kind with binding
status `existing` at `proposed` takes `existing` only, `any` takes either,
`none` takes no binding, and `new` (red-first) may move on to `existing` once
the test exists but never back. It appends one bind entry with the full new
binding to `bindings.log` and rewrites `bindings.yaml` (a block mapping in its
key order; comments are dropped), each through a temporary file renamed into
place, and prints `bound <tp-id> (entry <n>)`. `bindings.log` is written
first: a run stopped between the two leaves a log one entry ahead of
`bindings.yaml`, which `bindings-log` reports as a replay mismatch, and
running the same bind again repairs it. `bind` reads no git; the lint checks
the log against the propose commit.

## Git inputs

The reference-state rules compare what a spec names (`base_commit`,
`commands_ref`) and what a spec change touches (`.spec-gate/`) with git. The
caller gives the repository state; the lint never fetches, never writes and
never reads a remote, so the same repository gives the same report.

| Flag | Meaning |
|---|---|
| `--default-ref <ref>` | a full ref name under `refs/` (for example `refs/remotes/origin/main`): the remote-tracking ref of the pull request's target branch, fetched by the job; resolved to a commit once, offline. An annotated tag peels to its commit |
| `--base <commit>` | the full id of the pull request base commit (a commit object; an abbreviation and the id of a tag object are refused) |
| `--repo <dir>` | the trusted checkout root: a directory inside the git work tree to read; required with `--default-ref` and `--base`, never discovered from `<spec-dir>`; `<spec-dir>` must lie inside that work tree |

Git inputs are given when `--default-ref` or `--base` is, and they need
`--repo`: without it the run is a usage error. The repository is never found
by walking up from `<spec-dir>`, because the spec author writes that
directory, and a spec pull request can commit files that look like a git
directory (`HEAD`, `objects/`, `refs/`, `config`, `info/grafts`) and so
present a repository of its own choosing as the one to read. `--repo` alone is
not a git input: the git rules are skipped with `no-git` (and fail a `--final`
run, see above). Everything git needs is resolved once, before any rule runs,
into full commit ids:

- the reference commit: the `--base` commit when given, else the commit
  `--default-ref` names. It is the commit the ancestry checks compare
  against. With both flags `--base` wins, and `--default-ref` is still
  validated, so a bad value is never ignored; `--base` must then be an
  ancestor of the `--default-ref` commit, or equal to it (a usage error
  otherwise: a base that is not on `--default-ref` is a commit the author
  could have put on a branch of their own).
- the head: `HEAD` of the repository. The rules read committed state; the
  working tree is not diffed (the spec files themselves are read from the
  working tree as always).
- the diff base: `merge-base(HEAD, reference commit)`. A change made only on
  the base side after the fork does not count against the spec change.
  When several merge bases exist the one git names first is used; a change
  from another side can then only be over-reported, never missed.

A value that cannot be used is a usage error (exit 2, one line on stderr, no
report), never a finding: a `--default-ref` that is not a valid full ref name
under `refs/` (a short name, a leading dash, a name `git check-ref-format`
refuses), that names no ref, or that does not lead to a commit; a `--base`
that is not the full id of a commit in the repository, or not an ancestor of
(or equal to) the `--default-ref` commit when both are given; a git input
without `--repo`; a `--repo` with no path or outside a git work tree, or in a
repository that is not the one the `.git` entry of its work tree names (see
the repository check below); a spec
directory outside the repository; a
repository without a commit at `HEAD`; a `HEAD` that shares no history with
the reference commit; and `--config` together with git inputs. The message
names the flag, never git's output, an argument or a path.

Every git call is an argument list (no shell) with a scrubbed environment (no
`GIT_*` variable of the caller; `GIT_NO_REPLACE_OBJECTS`, `GIT_NO_LAZY_FETCH`,
`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_GRAFT_FILE` set to the
null device and `GIT_ALLOW_PROTOCOL` set to the empty string, so a replace ref
or a graft file cannot change what an id means and no transport is started,
whatever `protocol.<name>.allow` the repository sets), four configuration
overrides before the subcommand (`safe.bareRepository=explicit`,
`core.fsmonitor=false`, `core.hooksPath` set to the null device and
`protocol.allow=never`, so that the repository's own configuration starts no
program and, with git 2.38 or newer, a bare repository is never found by
walking up), a time limit of 30 seconds and an output cap of
4 MiB. A git that is stopped by a signal is never an exit status: it is a git
call that could not run (`git-failed`), so a killed ancestry check never reads
as "not an ancestor". A value from outside goes behind
`--end-of-options`, and only full commit ids are passed on after they were
resolved. A file is read at a commit by `ls-tree` first: the entry must be a
regular file (a symbolic link, a submodule and a directory are refused, and a
path below a link is not found), and only then is the blob read. Git's own
messages never reach the report. A git call that cannot run or does not
finish is an error finding of the rule that needed it (code `git-failed`), not
a pass.

The repository check. Git looks for the repository from `--repo` upwards, and
the one it finds is used only when all of this holds, each part with its own
usage error:

1. `<top level>/.git` exists and is not a symbolic link.
2. It leads to the git directory git found: it is that directory, or a
   regular file `gitdir: <path>` whose path (a relative one counts from the
   top level) is that directory.
3. The common git directory is not inside the work tree, unless it is the
   git directory and that is `<top level>/.git` itself.

Git never checks out an entry named `.git`, so nothing a spec author commits
can be the `.git` entry of a work tree: a git directory found by walking up
into committed files (`HEAD`, `objects/` and `refs/` somewhere in the tree)
fails part 1 or 2, wherever its `core.worktree` points. Every layout git
makes itself passes: a plain checkout, a linked worktree (also one inside a
bare repository), a separate git directory outside the work tree, a
submodule. A submodule's repository is whichever one its URL names, and a pull
request can set that URL, so `--repo` names the superproject root.

What the caller must guarantee. The lint can only be as strict as the
repository state it is given.

- `--repo` is the trusted checkout root: the directory the job's checkout step
  made, not a path taken from the spec or the pull request.
- `--default-ref` is the remote-tracking ref of the pull request's target
  branch (for example `refs/remotes/origin/main`, after a fetch the job made),
  or the base the host event names, that the spec author cannot move. It is never a local branch
  and never the head of the pull request, and a ref the author can push to is
  the author's own input.
- `--base` is the pull request base id from the host event (for example the
  base sha of a `pull_request` event), a full commit id.
- The full history is fetched. A shallow clone does not hold the commits the
  ancestry checks compare, so `base_commit` and `commands_ref` report as not
  being commits, and the diff base may not be found.
- The checkout is the one the job trusts: the lint refuses a repository that
  the `.git` entry of its work tree does not name (the repository check
  above), but it does not vouch for a checkout whose `.git` the pull request
  could have replaced, or that something other than git put on disk.
- Git is 2.38 or newer. The protection against a repository found by walking
  up from the spec directory relies on `safe.bareRepository=explicit`, which
  git has known since 2.38; an older git ignores it and only the layout check
  above stands. `GIT_NO_LAZY_FETCH` (git 2.45 and newer) is defence in depth:
  a read never fetches because no transport is allowed
  (`GIT_ALLOW_PROTOCOL`), whichever git version runs. The lint does not check
  the version.

A pull-request job, after checking out the merge or head commit with full
history, fetches the pull request's target branch and names its
remote-tracking ref (`PR_BASE_REF` is the name of the target branch and
`PR_BASE_SHA` its commit, both from the host event):

```
git fetch origin "+refs/heads/$PR_BASE_REF:refs/remotes/origin/$PR_BASE_REF"
spec-gate lint specs/<id> --final \
  --repo "$GITHUB_WORKSPACE" \
  --default-ref "refs/remotes/origin/$PR_BASE_REF" \
  --base "$PR_BASE_SHA"
```

The config. With git inputs `.spec-gate/config.yaml` is read at the reference
commit, never from the working tree and never from the head of the spec pull
request, so a pull request cannot change the limits it is checked against. A
config that does not exist there means the format defaults. One that is a
link, over 4 MiB, not UTF-8 or unreadable is a `file` finding, one that does
not parse is a `format` finding, both naming `repo:.spec-gate/config.yaml`,
and the rules still run on their defaults. Without git inputs `--config <path>`
works as before; with git inputs it is a usage error.

## Profiles

The profile comes from `triage.json`: the class its fields give when
derived in memory (the file is never written). The stored `class` never
picks the profile, stale or not; the class the fields derive does, so even
a file whose stored class or `rule_version` no longer matches its fields
takes its profile from those fields. That mismatch is a `triage-stale`
error, and `triage-stale` runs in both profiles. `--profile` only fills in
when `triage.json` gives no usable profile.

| `triage.json` | `--profile` | Profile | `profile_source` | Finding |
|---|---|---|---|---|
| usable, class gives `light` or `full` | absent or equal | the class's profile | `triage` | none |
| usable, class gives `light` or `full` | different | the class's profile | `triage` | `profile-mismatch` |
| usable, class gives no spec | any | the flag, else `full` | `flag` or `default` | `profile-no-spec` |
| absent | given | the flag | `flag` | none |
| absent | absent | `full` | `default` | `profile-default` (warning) |
| unparsable | given | the flag | `flag` | the `format` errors |
| unparsable | absent | `full` | `default` | the `format` errors |

So `triage.json` wins over the flag. The light profile runs `file`, `format`,
the profile and acknowledgement rules, the three form rules, and `triage-stale`
(a stale `triage.json` is an error whatever the profile). The full profile
runs every rule.

## Status gating

A rule marked gated applies only when the frontmatter `status` is `proposed`
or the run is `--final`; `--final` rates a spec as if it were proposed. Every
other rule always applies. The gated rules are `binding-status`,
`residual-open` and `bindings-log`: they state what must hold at approval, not
while a spec is a draft.

## Rules

The table is generated from the registry in `src/lint/registry.ts`, and a test
fails when it drifts. A rule is added by registering it there; the report shape
does not change. Every registered rule that does not need git has a positive
and a negative fixture under `test/fixtures/lint-<rule>/`, and a test checks
that they exist; the rules that need git are covered as described under
"Writing a rule".

<!-- BEGIN generated: rules -->
| Rule | Level | Profiles | Gated | Ackable | Checks |
|---|---|---|---|---|---|
| `file` | error | light, full | no | no | A required file is missing, or a file is a link, not a regular file, over the size limit, not UTF-8 or unreadable. |
| `format` | error | light, full | no | no | A file does not parse; carries the format error's code and path. |
| `profile-no-spec` | error | light, full | no | no | The triage class leads to no spec (unsuitable, decision, split, clarify). |
| `profile-mismatch` | error | light, full | no | no | `--profile` disagrees with the profile the triage class gives. |
| `profile-default` | warning | light, full | no | yes | No `triage.json` and no `--profile`: the full profile is used. Acknowledge with id `triage`. |
| `ack-invalid` | error | light, full | no | no | An ack names an unknown rule, an error rule or a rule that cannot be acknowledged, or repeats an earlier ack. |
| `rule-skipped` | error | light, full | no | no | Under --final, an error rule was skipped with reason no-git or input-absent: one error per rule, id the skipped rule's id, code the reason; a final run that did not look is not a pass. |
| `ack-unused` | warning | light, full | no | no | A valid ack for a rule that ran in this run matches no current warning. |
| `goal-count` | error | light, full | no | no | Exactly one GOAL line (form rule 1). |
| `ac-coverage` | error | light, full | no | no | Every AC is covered by at least one test-plan row; required fields per kind are checked by the format layer (form rule 2). |
| `non-goals-empty` | error | light, full | no | no | The Non-goals section is not empty; a non-goal needs no test-plan row (form rule 3). |
| `df-coverage` | error | full | no | no | Every DF with affects_behavior true is covered by at least one test-plan row. |
| `tp-covers-unknown` | error | full | no | no | Every ID in a test-plan row's covers is an AC, DF or NG ID of spec.md. |
| `binding-unknown` | error | full | no | no | Every key of bindings.yaml is a test-plan row ID; the file may be absent. |
| `binding-status` | error | full | yes | no | At proposed every binding has the status its row's kind requires, a kind needing one has one, and kind manual has none; a red-first row may be existing once bindings.log holds a bind entry for it. |
| `ledger-complete` | error | full | no | no | The ledger's source line IDs are exactly the IDs in the lines of source/meta.json; a missing source/meta.json is one error, not a skip. |
| `ledger-target-unknown` | error | full | no | no | Every target ID of a source-ledger entry is a live ID of spec.md. |
| `ac-source-unknown` | error | full | no | no | Every SL ID in an AC's source is the ID of a source-ledger entry. |
| `owner-none` | error | full | no | no | No AC has owner none: such a line is a divergence, not a requirement. |
| `residual-open` | error | full | yes | no | At proposed no residual has status open and no blocking divergence, blind-spot or untestable question of questions.json is without an answer. |
| `dc-unanswered` | error | full | no | no | Every DC's question has an answer in questions.json; an unknown question ID or no questions.json at all is the same error. |
| `dc-self-reported` | warning | full | no | yes | A DC whose answer has no comment_url has no checkable source. Acknowledge with the DC ID. |
| `retired-id-live` | error | full | no | no | No ID of retired_ids is a live test-plan row ID or question ID; live spec IDs are already a format error. |
| `prose` | warning | full | no | yes | No AC text, test-plan claim or expected contains a whole word of the fixed vague-word list in src/lint/prose.ts. Acknowledge with the AC or row ID. |
| `question-budget` | warning | full | no | yes | The number of unanswered questions is at most questions.warn_above (default 7, set with --config). Acknowledge with id questions. |
| `triage-stale` | error | light, full | no | no | triage.json stores the class its own fields derive and the current rule version; it runs in both profiles. |
| `meta-frontmatter-mismatch` | error | light, full | no | no | base_commit and commands_ref in source/meta.json equal those in the spec.md frontmatter; it needs no repository and runs in both profiles. |
| `base-commit-not-ancestor` | error | light, full | no | no | The frontmatter base_commit is the full id of a commit in the repository and an ancestor of the reference commit (the --base commit, else the --default-ref commit); a commit that exists only on the pull request head or a fork is an error. |
| `commands-ref-not-ancestor` | error | light, full | no | no | The frontmatter commands_ref is the full id of a commit in the repository and an ancestor of the reference commit, checked like base_commit. |
| `spec-changes-config` | error | light, full | no | no | No path under .spec-gate/ (the first path component compared without regard to case, after Unicode normalisation) differs between merge-base(HEAD, reference commit) and HEAD, renames not detected; changes made only on the base side do not count. |
| `static-command-unknown` | error | light, full | no | no | Every static test-plan row's check_command_ref names a command of .spec-gate/commands.yaml at commands_ref; a missing or invalid command set there is an error, and the set is not read at a commands_ref that failed its ancestry check. |
| `bindings-log` | error | light, full | yes | no | At proposed bindings.log exists; it parses (seq from 1 in steps of 1, one propose entry and it is first, entry shapes, hash chain); its propose commit is an ancestor of HEAD where spec.md was a draft without a log; bindings.yaml read from git at that commit hashes to the propose entry; every bind entry names a TP ID it had and keeps to its row's kind; the replay of the bind entries over it equals bindings.yaml, compared as parsed bindings; the spec directory is specs/<name>, one level below the top-level specs/; every log the diff base holds there for a spec of the same id is extended, not rewritten or removed; and a proposed spec has not left its directory. |
<!-- END generated: rules -->

The form rules:

- one GOAL: a missing GOAL is an error; a second GOAL is a `format` error
  (duplicate ID) and is not reported twice.
- every AC is covered by at least one test-plan row through `covers`. The
  required fields of each kind are checked by the format layer. A row may also
  cover a non-goal, but a non-goal needs no row.
- the Non-goals section is not empty.

The content rules run in the full profile, except `triage-stale` which runs in
both; the reference-state rules also run in both. Their families:

Coverage. `df-coverage`: every DF whose parsed `affects_behavior` is `true`
is named by at least one test-plan row's `covers`; a DF with `false` may
stay uncovered. `tp-covers-unknown`: every entry of a row's `covers` is an
AC, DF or NG ID that spec.md has.

References. `binding-unknown`: every key of `bindings.yaml` is a TP ID of
`testplan.yaml`; the rule runs when `bindings.yaml` is absent and finds
nothing then. `binding-status` (gated): for each row, the
`bindingStatusAtProposed` of its kind says what the binding must look like:
`new` and `existing` demand a `bindings.yaml` entry with exactly that
status (a missing entry is an error of its own), `none` (kind manual)
allows no entry at all, and `any` is unchecked. One exception: a row whose
kind needs `new` (red-first) may have status `existing` once
`spec-gate bind` moved it there, that is when `bindings.log` in the spec
directory parses and holds a bind entry for that TP ID. Whether the log is
authentic is checked by `bindings-log`.

Ledger. `ledger-complete`: the `sourceLine` IDs of the ledger equal the IDs
of `lines[]` in `source/meta.json`, one error per meta line that no ledger
entry maps and one error per ledger entry whose source line the meta does
not list; without `source/meta.json` the rule does not pass and is not
skipped: it reports one error on that file (`input-missing` at `$`) because
the source lines the ledger must match are unknown. A `source/meta.json`
that failed to parse is skipped `input-failed`. `ledger-target-unknown`: every target ID of a
ledger entry is a live ID of spec.md. `ac-source-unknown`: every SL ID in
an AC's `source` is the ID of a ledger entry. `owner-none`: an AC whose
`owner` is the reserved word `none` is an error: nobody stands behind the
line, so it records a divergence rather than a requirement. The match trims
and lower-cases the `owner`, so `None` and `NONE` are the same error; the
message says the reserved word must be written `none`.

Residuals and decisions. `residual-open` (gated): no residual has status
`open` (a residual class is always `divergence`, `blind-spot` or
`untestable`), and every `questions.json` question with `blocking: true`
and one of the three open-point classes `divergence`, `blind-spot` or
`untestable` has an answer; the rule runs without
a `questions.json` and checks only the residuals then. `dc-unanswered`:
every DC's `question` ID has an entry in `answers[]`; a question ID the
file does not hold is the same error. With no `questions.json` there is no
answer anywhere, so every DC is an error; a `questions.json` that failed to
parse is skipped `input-failed`, its `format` error already failing the run.
`dc-self-reported`: a DC with an answer that has no `comment_url` is an
ackable warning about that DC.

IDs. `retired-id-live`: no ID of `retired_ids` is a TP ID of
`testplan.yaml` or a QN ID of `questions.json`; a retired ID that is live
in spec.md is already a `format` error.

Prose. `prose`: an AC text, a row `claim` or a row `expected` containing a
whole word of the fixed list is an ackable warning naming the word. Before
matching, the text is normalised to NFC and every run of whitespace (a
no-break space included) collapses to one space, so a decomposed `möglichst`
and `bei  Bedarf` both hit. The
match is case-insensitive (so a list entry flags the month name `May` too)
and whole-word in the sense that the word may
only stand next to characters that are neither letters, digits nor `_`
(a listed word as the head or tail of a longer word, or followed by a digit
or `_`, does not match); phrases with a space match their words one collapsed
space apart. One finding per pair of
line and word; one acknowledgement for `(prose, <id>)` covers every listed
word found in that AC or row. The list, in `src/lint/prose.ts`: should, may, might,
could, appropriate, reasonable, fast, quickly, user-friendly, easy, robust,
as needed, if possible, etc, sollte, sollten, koennte, könnte, eventuell,
ggf, moeglichst, möglichst, schnell, benutzerfreundlich, einfach,
angemessen, bei Bedarf, usw.

Budget. `question-budget`: a question is unanswered when no entry of
`answers[]` names its ID; the number of unanswered questions must not
exceed `questions.warn_above`. `spec-gate lint --config <path>` reads that
number from a `.spec-gate/config.yaml`-format file parsed by the format
layer's config parser. A file that does not parse is a `format` finding and
one that cannot be read is a `file` finding, both naming `file` as
`config:<basename of the path>` (see the `file` field above), never the
path given to `--config`; in both cases the budget falls back to the default of
7 and the rule still runs. `--config ""` is a usage error: exit 2, one line
on stderr, no report. The finding is ackable with id `questions`.

Reference states. The five rules below check the revisions a spec names; none
of them can be acknowledged. `meta-frontmatter-mismatch` needs no repository
and runs in both profiles, like the others, because a reference state is not a
matter of how much content a spec carries: `base_commit` and `commands_ref` in
`source/meta.json` must equal those in the `spec.md` frontmatter, one error
per field that differs. It needs `source/meta.json`: absent, it is skipped
`input-absent` (the full profile reports the absence through `ledger-complete`),
and failed (a missing or malformed commit id is a `format` error), skipped
`input-failed`. The remaining four need git inputs and are skipped `no-git`
without them.

- `base-commit-not-ancestor` and `commands-ref-not-ancestor`: the
  frontmatter value is the full id of a commit object in the repository and an
  ancestor of the reference commit (`git merge-base --is-ancestor`; the
  reference commit itself counts). "The commit exists" and "reachable from
  `HEAD`" are not the test: a commit that exists only on the head of the pull
  request, or on a fork, is the spec author's own input and is an error, even
  when the head descends from it and `meta.json` names the same commit. Codes:
  `not-a-commit` (absent, abbreviated, or the id of a tag object) and
  `not-ancestor`. After a squash merge the commits of the pre-PR default
  branch stay valid and a commit of the squashed pull request branch is not
  an ancestor of the new tip, so it is an error.
- `spec-changes-config`: no path at or below `.spec-gate/` differs between the
  diff base and `HEAD`; one error per changed path, named `repo:<path>`
  (control characters in a path print as `?`). The first path component is
  compared without regard to case, after Unicode normalisation (NFC), so
  `.Spec-Gate/commands.yaml` counts: on a case-insensitive file system it is
  the same directory. The changed paths of the whole tree are listed and
  matched in code, not by a pathspec. Renames are not detected, so a
  moved file shows both paths, and no textconv or external diff program runs.
- `static-command-unknown`: every test-plan row of kind `static` has a
  `check_command_ref` that names a command of `.spec-gate/commands.yaml` at
  `commands_ref`. The file is read at that commit only, never from the working
  tree or the head. A missing or non-regular file there, a file that is not
  valid UTF-8 and one that does not parse are one error each (codes
  `commands-file-missing`, `commands-file-invalid`), and so is every row whose
  name the set does not have (the finding names the row). The command set at a
  `commands_ref` that failed `commands-ref-not-ancestor` is never read: the rule
  then reports one error with code `commands-ref-untrusted`. A spec with no
  static row needs no command set.

Bindings log. `bindings-log` needs git inputs and is gated; it runs in both
profiles and cannot be acknowledged. A spec directory that is not
`specs/<name>`, exactly one level below the top-level `specs/` of the
repository (both compared as real paths), is one error with code
`spec-off-layout`, at `proposed` and under `--final`, with or without a log:
the top level, a directory elsewhere and one deeper inside `specs/` are all
reported, nothing else is checked then, and `propose` refuses the same
places. In `specs/<name>` the rule reads `bindings.log` in the spec
directory (format in [formats.md](formats.md)). Without one it reports nothing
at `draft` (so the final lint `propose` runs can pass) and one error with code
`log-missing` at `proposed`. Otherwise it reports, as errors of the rule:

- a log that does not parse, with the parser's code and the line: `log-empty`,
  `log-line-ending`, `log-blank-line`, `log-not-json`, `log-entry-shape`,
  `log-propose-not-first`, `log-seq`, `log-chain`; nothing else is checked
  then;
- a propose commit that is not the full id of a commit (`propose-not-a-commit`)
  or not an ancestor of `HEAD` (`propose-not-ancestor`): a commit on a branch
  of its own, or one a force push removed, binds nothing;
- `bindings.yaml` read from git at the propose commit, never from the work
  tree: missing there (`propose-bindings-missing`), its raw bytes not hashing
  to the propose entry (`propose-hash-mismatch`), or not parsing
  (`propose-bindings-invalid`);
- a propose commit at which `spec.md` was not a draft (`propose-not-draft`) or
  `bindings.log` already existed (`propose-log-present`): a propose entry that
  names a later commit would re-anchor the bindings there;
- a bind entry for a TP ID that `bindings.yaml` did not have at the propose
  commit (`bind-unknown-id`, at the entry's line), and one whose status breaks
  the rule of its row's kind given the status before it, the rule `bind`
  applies (`bind-kind`, at the entry's line);
- a replay that differs from `bindings.yaml` in the spec directory, compared as
  parsed bindings: one error per TP ID that differs or only one side has
  (`replay-mismatch`, file `bindings.yaml`), so a hand edit after `proposed`
  is caught;
- a log at the diff base (for example the one merged with the spec) that the
  log in the spec directory does not extend byte for byte (`log-rewritten`): a
  merged entry is never changed, removed or reordered, even with a recomputed
  chain; a log at the diff base that is gone from the spec directory is
  `log-removed`, at `proposed` and under `--final` alike. The diff base is
  searched by the spec's identity, not only its path: every directory whose
  `spec.md` there carries the same frontmatter `id` counts, so a renamed or
  copied spec directory does not start a fresh log. The search covers the
  layout and nothing else: the directories directly inside `specs/`, listed
  one level deep, so what a spec directory holds (its evidence files, for
  one) never grows the listing. A spec directory anywhere else never passes
  this rule, so a log merged through the lint lives in `specs/`; a proposed
  spec that reached the default branch elsewhere without a passing lint is
  not followed when it later moves into `specs/`. Only a regular `spec.md`
  that parses counts, so a link or a submodule entry never fails the run;
- a directory that held this spec at the diff base with a `bindings.log` or a
  status other than `draft`, and that no longer holds a `spec.md` at `HEAD`
  (`spec-moved`): a proposed spec keeps its directory.

A git read that cannot run is an error with its code, as for the
reference-state rules.

Limitation: after a squash or rebase merge the propose commit is not an
ancestor of the default branch, so on the default branch and in later pull
requests the rule reports `propose-not-ancestor` for such a spec. Re-anchoring
the log after such a merge is not supported yet.

Triage. `triage-stale`: a `triage.json` that stores a `class` must store
the very class its own fields derive and the current `rule_version`; one
error per mismatch. The rule runs in both profiles: the profile step always
follows the class the fields derive, so a stale file is caught whichever
profile it lands in.

## Acknowledgements

`acks.yaml` sits next to `spec.md` and stays out of the digest. It is a YAML
list of `{ rule, id, reason }`: all strings, each one line and not empty, and
no other key.

```yaml
- rule: "profile-default"
  id: "triage"
  reason: "triage runs later in this flow"
```

An ack matches a warning by `(rule, id)`. A matched warning moves from
`warnings` to `acked` with its reason and is counted there; an acknowledged
warning does not fail `--strict`.

- An ack for an error rule, an unknown rule, a warning that cannot be
  acknowledged (`ack-unused`), or a repeat of an earlier `(rule, id)` is an
  `ack-invalid` error. It acknowledges nothing.
- A valid ack that matches no current warning is an `ack-unused` warning, but
  only when its rule was evaluated in this run. An ack for a rule listed in
  `skipped` (inactive profile, closed gate, a missing or failed input, no
  repository) is kept silently, because the warning could not have been
  raised. A rule that ran and did not fire still gives `ack-unused`: a
  `profile-default` ack while `--profile` is given is unused.
- An `acks.yaml` that does not parse is a `format` error; the other rules still
  run, without acks. An empty or comment-only file holds zero acks and is not
  an error.

`spec-gate lint-ack <spec-dir> <rule> <id> --reason <text>` appends one entry,
and creates the file when it is absent. It accepts only a registered warning
that can be acknowledged, refuses a duplicate `(rule, id)`, and refuses a
reason or id that is empty, has a line break or has a control character. It
does not need the warning to be present now. The existing text is kept byte for
byte (a leading byte-order mark is the one exception: the reader decodes it
away, so it is dropped) and the entry is added after it, with a line feed first when the file did
not end in one. The result is parsed again. A file that cannot take an item
that way, such as a list written in flow style (`[]`) or a document closed by
an end marker, is rewritten as a block list, which drops its comments, and
the verb then prints one line on stderr saying so; that result is parsed again
too, and nothing is written when it does not hold exactly the old entries plus
the new one. An empty or comment-only file takes the entry after its text.

The write is atomic: a temporary file next to `acks.yaml`, created exclusively
and renamed over it, so a reader sees the old or the new file whole. The
permission bits of an existing file carry over, never a setuid, setgid or
sticky bit. A symlink at `acks.yaml`, or at the spec directory itself, is
refused; so is an existing `acks.yaml` that is not valid. Any refusal is a
message on stderr and exit 2, and nothing is written.

`lint-ack` does not lock the file: do not run it in parallel on one spec
directory, or one of two concurrent entries can be lost.

## Writing a rule

A rule is a registry entry with a `check` that returns `RuleFinding`s; the
engine adds `rule` and `level` from the registry, last, so a rule cannot
change either. A finding of an ackable rule must carry an `id`, because an ack
matches on it; the engine throws an internal error (exit 2) when it is missing.

Declare the inputs the check reads:

- `needs`: inputs that must have parsed. The rule is skipped when one is
  absent (`input-absent`) or failed (`input-failed`), so a broken file gives
  its own `file` or `format` errors and no follow-up findings.
- `uses`: inputs the check reads when they are there. The rule runs when one
  is absent and is skipped only when one failed.

A skip is not a pass and not a finding: the rule did not look (under
`--final` an error rule skipped for `no-git` or `input-absent` becomes a
`rule-skipped` error). It shows in `skipped` with its reason, and acks for it
stay quiet. A rule that reads the repository sets `needsGit` and is skipped
with `no-git` when the run has no git inputs; it reads them from `ctx.git`
(resolved full commit ids, see "Git inputs") and calls the primitives in
`src/lint/git/`, never `git` itself. A rule that needs git has no static
fixture directory: its passing and failing cases are built from temporary
repositories in `test/lint/git-rules.test.ts`, which has a guard that every
such rule has both.
