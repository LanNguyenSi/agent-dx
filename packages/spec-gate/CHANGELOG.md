# Changelog

All notable changes to `spec-gate` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial package scaffold: CLI with --help and --version.
- Format schemas and pure parsers for `spec.md`, `testplan.yaml`, `bindings.yaml`, `triage.json`, `questions.json`, `.spec-gate/config.yaml`, `.spec-gate/commands.yaml` and evidence envelopes, with the field-to-layer table, the per-kind required fields, ID and source-line ID handling, the reference-state table and the evidence phase rules, documented in `docs/formats.md`.
- `intake file` CLI verb: create `specs/<id>/source/` in the target repository from a local file with `base_commit` and `commands_ref` read from the remote default branch, a secret scan before anything is written, optional attachments and `--no-raw`, and a `--check` drift mode.
