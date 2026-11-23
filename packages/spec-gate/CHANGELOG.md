# Changelog

All notable changes to `spec-gate` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial package scaffold: CLI with --help and --version.
- Format schemas and pure parsers for `spec.md`, `testplan.yaml`, `bindings.yaml`, `triage.json`, `questions.json`, `.spec-gate/config.yaml`, `.spec-gate/commands.yaml` and evidence envelopes, with the field-to-layer table, the per-kind required fields, ID and source-line ID handling, the reference-state table and the evidence phase rules, documented in `docs/formats.md`.
- `spec-gate digest <spec-dir> [--repo <path>]`: a deterministic `sha256:` digest of the normative layer of a spec, frontmatter `id` included (canonical JSON per RFC 8785, whitespace normalised in prose fields only, `commands_ref` a full commit ID and the referenced argv lists read from git at that commit, from a regular file at the repository root only; `input`, `steps`, `environment` and `verifier` are kept exactly), with golden fixtures and the rules in `docs/digest.md`.
- `triage` verb: derives the triage class from `triage.json` with a versioned truth table in `src/triage/`, writes `class` and `rule_version` back through a temporary file renamed into place, keeping the file's permission bits and never removing a path it did not create (a symlink, or a file or directory that cannot be written, is refused with a named error), and reports the class, the deciding row, every unknown field of the precedence rows when an unknown forces `clarify`, and the spec profile; the rule is documented in `docs/triage.md`.
- `intake file` CLI verb: create `specs/<id>/source/` in the target repository from a local file with `base_commit` and `commands_ref` read from the remote default branch, a secret scan before anything is written, optional attachments and `--no-raw`, and a `--check` drift mode.
- `spec-gate lint <spec-dir> [--strict] [--final] [--profile <light|full>]` and `lint-ack`: a deterministic JSON report (`spec-gate-lint/1`, findings sorted, nothing machine-local) over a rule registry with profiles and status gating, a git-free loader that refuses links, non-regular files, files over 4 MiB and non-UTF-8 text and turns every format error into a finding, the profile taken from `triage.json` (in-memory derivation, `--profile` only as a fallback), `acks.yaml` for acknowledged warnings with an atomic append writer, and the form rules for one GOAL, AC coverage by a test-plan row and non-empty Non-goals; documented in `docs/lint.md`.

### Security

- `intake file` hardening: the remote default branch is validated and fetched by its full `refs/heads/` name only (a tag of the same name, or a branch named like a git option, can no longer change `base_commit` or the local repository), git runs with a scrubbed environment in its own process group, `--remote` must be a configured remote and no error echoes a URL, the secret scan covers keywords inside identifiers, quoted keys, PGP key blocks and `ghr_` tokens and refuses UTF-16 and NUL input, writes are atomic and rolled back, and `--check` exits 2 on an error.
- `intake file` exits 2 on its own usage errors and unexpected exceptions (exit 1 belongs to `--check` drift alone), refuses a `specs` or `specs/<id>` that is already a symlink with `source-not-in-repo` before anything is written, and the fetch passes `--write-fetch-head` so a repo-local `fetch.writeFetchHEAD=false` cannot leave a stale FETCH_HEAD; the remote is trusted as configured (local-path URLs and `url.<base>.insteadOf` rewrites included), with integrity against the shared upstream deferred to lint.
