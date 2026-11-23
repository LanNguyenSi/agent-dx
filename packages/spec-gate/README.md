# spec-gate

`spec-gate` turns a ticket or intent into a checked, reviewable spec and
test plan before implementation starts. The package is currently a
scaffold: the CLI answers `--help` and `--version`, and later capabilities
(spec drafting, test-plan checking, review gates) land as subcommands on
top of this entry point.

## Formats

The files `spec-gate` reads and writes, their grammars, the field-to-layer
table and the revision each step reads each input at are described in
[docs/formats.md](docs/formats.md). The parsers live in `src/formats/`.

## Commands

- `spec-gate intake file <path> --id <spec-id>` creates `specs/<id>/source/`
  in the target repository from a local file, with `base_commit` and
  `commands_ref` set to the head of the remote default branch.
