# spec-gate

`spec-gate` turns a ticket or intent into a checked, reviewable spec and
test plan before implementation starts. The package is young: the CLI
answers `--help` and `--version` and runs the `intake file`, `triage`,
`digest`, `lint`, `lint-ack`, `propose`, `bind`, `repo-check`, `export`,
`questions`, `answer`, `status` and `approve-check` verbs described below,
and further capabilities land as subcommands on top of this entry point as
they are built.

## Commands

`spec-gate intake file <path> --id <spec-id>` creates `specs/<id>/source/`
in the target repository from a local file, with `base_commit` and
`commands_ref` set to the head of the remote default branch. The file
format is described in [docs/formats.md](docs/formats.md). Each git call
times out after 15 seconds; `--git-timeout <seconds>` or
`SPEC_GATE_GIT_TIMEOUT` changes that.

`spec-gate triage <spec-dir>` derives the triage class from
`<spec-dir>/triage.json`, writes `class` and `rule_version` back through a
temporary file renamed into place, and prints the derivation; a
`triage.json` or a `<spec-dir>` that is a symlink, or a file or directory that
cannot be written, is refused with a named error. The rule is documented in
[docs/triage.md](docs/triage.md).

`spec-gate lint <spec-dir> [--strict] [--final] [--profile <light|full>] [--config <path>] [--repo <dir>] [--default-ref <ref>] [--base <commit>]`
checks a spec directory and prints one JSON report line (`spec-gate-lint/1`);
it exits 0 without errors, 1 with findings (with `--strict`, also for
unacknowledged warnings) and 2 on a usage error (including `--config` with an
empty path or together with `--default-ref` or `--base`, and a git input that
does not resolve). With `--default-ref <full ref name>` or `--base <full commit
id>` it also checks the reference states of the spec against git, offline and
read-only (it never fetches), in the repository `--repo <dir>` names, which is
required with either flag and never discovered from `<spec-dir>`; without
them those rules are skipped, and under `--final` a skipped error rule fails
the run. `spec-gate lint-ack <spec-dir>
<rule> <id> --reason <text>` acknowledges one warning in `acks.yaml`. The
rules, the report, profiles and exit codes are described in
[docs/lint.md](docs/lint.md); the code lives in `src/lint/`.

`spec-gate propose <spec-dir> --repo <dir> (--default-ref <ref> | --base
<commit>)` runs the final lint with those git inputs and, when it is clean,
sets the frontmatter `status` to `proposed` and creates `bindings.log` with the
commit it ran at; it exits 0 when written, 1 when the final lint has findings
and 2 on any refusal. `spec-gate bind <spec-dir> <tp-id> --status
<new|existing> [--selector <s>] [--file <path>] [--fixtures <path>]...
[--notes <text>]` changes one binding of a proposed spec, appending the full
new binding to `bindings.log` and rewriting `bindings.yaml`; it exits 0 when
written and 2 on any refusal. Both are described in
[docs/lint.md](docs/lint.md), the log format in
[docs/formats.md](docs/formats.md); the code lives in `src/state/`.

`spec-gate repo-check --repo <dir> (--default-ref <ref> | --base <commit>)`
checks the whole repository rather than one spec directory: every `spec.md`
at the diff base that is not a draft or has a `bindings.log` must still be
at its path at `HEAD`, parse, keep its id, not go back to `draft` and keep
its log. It prints one JSON report line (`spec-gate-repo-check/1`) and exits
0 without findings, 1 with findings and 2 on a usage error. CI runs it on
every pull request, not only on spec pull requests; it is described in
[docs/lint.md](docs/lint.md) ("Repository check"), the code lives in
`src/repo/`.

`spec-gate export <spec-dir> --format ow --repo <dir> --default-ref <ref>`
prints the deterministic `ow` slicer briefing of a proposed spec whose
`spec.md`, `testplan.yaml` and `bindings.yaml` are merged unchanged on the
default branch (the work-tree copies must be byte-equal to the copies at
the `--default-ref` commit, read offline through the same hardened git
layer as `lint`; otherwise a named error exits 2), and
`spec-gate export <spec-dir> --check <slicer-return.yaml>` exits 0 when
every qualified AC and TP id of the spec appears as a whole token in a
string field of at least one task of the slicer return, 1 with the missing
ids listed, 2 on a usage or parse error; the briefing keys, the path
conventions and the token rule are described in
[docs/export.md](docs/export.md); the code lives in `src/exporters/`.

`spec-gate questions <spec-dir>` prints one JSON line
(`spec-gate-questions/1`) with a spec's unanswered questions in numeric ID
order and their counts, exiting 0 with none unanswered and 1 with at least one
listed. `spec-gate answer <spec-dir> <question-id> (--answer <text> [--option
<label>] | --accept-recommended) --channel <file|chat|comment> --author <login>
[--comment-url <url>]` appends one answer to a draft spec's `questions.json`,
with the time taken from the clock and the channel, author and optional
comment URL recorded as provenance; it exits 0 when written and 2 on any
refusal. `spec-gate status <spec-dir>` prints one offline JSON line
(`spec-gate-status/1`) with the spec's status, triage class stored and derived,
question counts, open residuals, bindings by status, `bindings.log` entry count
and propose commit, and ack count, exiting 0 for a report. The frontier rule,
the provenance and the exit codes are described in
[docs/questions.md](docs/questions.md); the code lives in `src/state/`.

`spec-gate approve-check <spec-dir> --repo <dir> --default-ref <ref> [--base
<commit>] --github-repo <owner/name> --pr <number> [--api-url <url>]` checks
whether the proposed spec of an open GitHub pull request is approved and
prints one JSON report line (`spec-gate-approve/1`) with the eight conditions,
the repository check among them, and the commands the spec refers to. It
exits 0 when approved, 1 when not and 2 on a usage error or refusal; only 0
means approved. The token is read from the environment variable
`GITHUB_TOKEN` only: no command line option takes it, and spec-gate never
prints the value of an option in its error output (the option's name stays).
A bare argument before the verb name is printed as an unknown command, so the
token belongs in the environment only. The checkout
must be at the head commit of the pull request, not at a merge of it. It is
described in [docs/approve.md](docs/approve.md) ("CLI"); the code lives in
`src/approve/` and `src/host/`.

`spec-gate closure <spec-dir> --repo <dir> --default-ref <ref> --start
<commit> [--head <commit>]` prints one JSON report line
(`spec-gate-closure/1`) that says for every row of the test plan, as the
merged spec commit holds it, whether the evidence files in the spec directory
prove it at or after the start commit: `proven`, `failed`, `unproven`,
`not-decidable` (measurement, manual and runtime rows, which are for review)
or `pending-post-deploy`, with the reason and every envelope that does not
count. `spec.md` and `testplan.yaml` are read at the merged spec commit, never
from the work tree; `bindings.yaml` and `evidence/` are read from the spec
directory. An envelope counts only when its phase is `closure`, its commit
lies on `start..head`, its work tree was clean and its digest and selector
match the row's command and binding. It exits 0 when no row is `failed` or
`unproven`, 1 when one is, and 2 on a usage error or a refusal (a start commit
that is not after the merged spec commit or not on the default branch, a head
that is not after the start, a merged spec that is not proposed, a command set
that cannot be read, an evidence or bindings file that does not load). It is
read-only and offline; CI runs are not verified with the host yet and the
squash rule is not applied. It is described in
[docs/closure.md](docs/closure.md); the code lives in `src/closure/`.

## Formats

The files `spec-gate` reads and writes, their grammars, the field-to-layer
table and the revision each step reads each input at are described in
[docs/formats.md](docs/formats.md). The parsers live in `src/formats/`.

## Digest

`spec-gate digest <spec-dir> [--repo <path>]` prints the digest of the
normative layer of a spec directory, reading the commands from a git work
tree whose git directory is the one a checkout has (a pull request cannot
commit one of its own). What goes in, what stays out, the
canonical form and the errors are described in [docs/digest.md](docs/digest.md).
The code lives in `src/canonical/`.

## Approval

Whether a proposed spec counts as approved is derived by `checkApproval` in `src/approve/` from the facts a host adapter (`src/host/`) supplies and from git; `spec-gate approve-check` runs it for a pull request on GitHub. After the merge, `spec-gate approve-check --merged` checks from the tip of the default branch whether what the merged pull request left there is the spec that was approved. The conditions, the report and the limits are described in [docs/approve.md](docs/approve.md).
