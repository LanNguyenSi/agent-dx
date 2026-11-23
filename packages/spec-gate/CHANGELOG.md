# Changelog

All notable changes to `spec-gate` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial package scaffold: CLI with --help and --version.
- Format schemas and pure parsers for `spec.md`, `testplan.yaml`, `bindings.yaml`, `triage.json`, `questions.json`, `.spec-gate/config.yaml`, `.spec-gate/commands.yaml` and evidence envelopes, with the field-to-layer table, the per-kind required fields, ID and source-line ID handling, the reference-state table and the evidence phase rules, documented in `docs/formats.md`.
- `spec-gate digest <spec-dir> [--repo <path>]`: a deterministic `sha256:` digest of the normative layer of a spec, frontmatter `id` included (canonical JSON per RFC 8785, whitespace normalised in prose fields only, `commands_ref` a full commit ID and the referenced argv lists read from git at that commit, from a regular file only), with golden fixtures and the rules in `docs/digest.md`.
