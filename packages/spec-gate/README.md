# spec-gate

`spec-gate` turns a ticket or intent into a checked, reviewable spec and
test plan before implementation starts. The package is young: the CLI
answers `--help` and `--version` and runs the `intake file`, `triage`,
`digest`, `lint` and `lint-ack` verbs described below, and further
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

`spec-gate lint <spec-dir> [--strict] [--final] [--profile <light|full>]`
checks a spec directory and prints one JSON report line (`spec-gate-lint/1`);
it exits 0 without errors, 1 with findings (with `--strict`, also for
unacknowledged warnings) and 2 on a usage error. `spec-gate lint-ack <spec-dir>
<rule> <id> --reason <text>` acknowledges one warning in `acks.yaml`. The
rules, the report, profiles and exit codes are described in
[docs/lint.md](docs/lint.md); the code lives in `src/lint/`.

## Formats

The files `spec-gate` reads and writes, their grammars, the field-to-layer
table and the revision each step reads each input at are described in
[docs/formats.md](docs/formats.md). The parsers live in `src/formats/`.

## Digest

`spec-gate digest <spec-dir> [--repo <path>]` prints the digest of the
normative layer of a spec directory. What goes in, what stays out, the
canonical form and the errors are described in [docs/digest.md](docs/digest.md).
The code lives in `src/canonical/`.
