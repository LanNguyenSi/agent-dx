# spec-gate

`spec-gate` turns a ticket or intent into a checked, reviewable spec and
test plan before implementation starts. The package is young: the CLI
answers `--help` and `--version` and runs the `triage` verb described
below, and further capabilities land as subcommands on top of this entry
point as they are built.

## Commands

`spec-gate triage <spec-dir>` derives the triage class from
`<spec-dir>/triage.json`, writes `class` and `rule_version` back through a
temporary file renamed into place, and prints the derivation; a
`triage.json` that is a symlink, or a file or directory that cannot be
written, is refused with a named error. The rule is documented in
[docs/triage.md](docs/triage.md).

## Formats

The files `spec-gate` reads and writes, their grammars, the field-to-layer
table and the revision each step reads each input at are described in
[docs/formats.md](docs/formats.md). The parsers live in `src/formats/`.

## Digest

`spec-gate digest <spec-dir> [--repo <path>]` prints the digest of the
normative layer of a spec directory. What goes in, what stays out, the
canonical form and the errors are described in [docs/digest.md](docs/digest.md).
The code lives in `src/canonical/`.
