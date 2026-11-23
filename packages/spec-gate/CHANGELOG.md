# Changelog

All notable changes to `spec-gate` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial package scaffold: CLI with --help and --version.
- Format schemas and pure parsers for `spec.md`, `testplan.yaml`, `bindings.yaml`, `triage.json`, `questions.json`, `.spec-gate/config.yaml`, `.spec-gate/commands.yaml` and evidence envelopes, with the field-to-layer table, the per-kind required fields, ID and source-line ID handling, the reference-state table and the evidence phase rules, documented in `docs/formats.md`.
- `triage` verb: derives the triage class from `triage.json` with a versioned truth table in `src/triage/`, writes `class` and `rule_version` back, and reports the class, row, unknown fields and spec profile; the rule is documented in `docs/triage.md`.
