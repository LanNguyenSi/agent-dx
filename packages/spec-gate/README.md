# spec-gate

`spec-gate` turns a ticket or intent into a checked, reviewable spec and
test plan before implementation starts. The package is young: the CLI
answers `--help` and `--version` and runs the `intake file`, `triage`,
`digest`, `lint`, `lint-ack`, `propose` and `bind` verbs described below, and further
capabilities land as subcommands on top of this entry point as they are
built.

## Commands

`spec-gate intake file <path> --id <spec-id>` creates `specs/<id>/source/`
in the target repository from a local file, with `base_commit` and
`commands_ref` set to the head of the remote default branch. The file
format is described in [docs/formats.md](docs/formats.md).

`spec-gate triage <spec-dir>` derives the triage class from
`<spec-dir>/triage.json`, writes `class` and `rule_version` back through a
temporary file renamed into place, and prints the derivation; a
`triage.json` that is a symlink, or a file or directory that cannot be
written, is refused with a named error. The rule is documented in
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
