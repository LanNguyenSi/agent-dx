# Changelog

All notable changes to `okf-kit` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-22

### Added

- New rule `citations-resolve`: for docs with a repo root, flags a
  `` `path:N`/`path:N-M` `` citation (and its `` `:N` ``/`` -`M` ``/`` (`N`) ``
  continuations) whose target file is missing, whose range is inverted or
  exceeds the file, or whose start line is blank or (for a non-markdown
  target) only a closing brace. Ported from agent-grounding's
  `scripts/okf-citations-resolve.mjs` (agent-grounding PR #185), a
  repo-local spike that closed a gap `sources-fresh` cannot: `sources-fresh`
  only compares a doc's `sources` list against file mtimes, so it is
  structurally blind to an edit that shifts line numbers inside a still-fresh
  source file. `citations-resolve` gives every repo consuming okf-kit this
  check without copying the script. See "Citation resolution
  (citations-resolve)" in the README. Not ported: the original's
  `docs/testing`-file expansion (an agent-grounding-specific convention, not
  part of the OKF spec, and not exercised by the ported tests) -- this rule
  only scans the docs already loaded for the bundle being checked.
  `citations-resolve` findings are warn-level: an existing `okf-kit check
  --strict` run that was previously green can now fail once this version is
  picked up, purely from this rule's new warnings, with no other change to
  the bundle. Two path-resolution refinements differ from the
  agent-grounding original: (1) a bare filename with no `/` (e.g.
  `README.md`) now tries the citing doc's own directory and each ancestor
  directory up to the repo root, nearest first, before falling back to a
  plain repo-root-relative lookup, so a package-level file is not shadowed
  by a same-named file that happens to also sit at the repo root; (2) a
  `` `path:N` `` match that starts at column 0 of its line, right after a
  previous line ending in `-`/`–`, is treated as the phantom tail of a
  filename hard-wrapped across the line break and skipped, instead of being
  checked (and typically flagged `missing-file`) as its own citation.

## [0.4.0] - 2026-08-13

### Changed

- `sources-fresh` no longer reports STALE when the doc file's own last-commit
  time is at or after the source's last-commit time, in particular when doc
  and sources landed in the same commit. Squash-merge PRs that ship a doc
  re-stamp together with its changed sources previously made every such doc
  stale-on-arrival: the merge gave all sources a commit time later than any
  frontmatter timestamp set before the merge. The frontmatter timestamp
  remains authoritative when a source changed after the doc's last commit,
  and for docs without git history (e.g. uncommitted) the behavior is
  unchanged. Accepted limitation (documented in the README): any commit
  touching the doc suppresses staleness for all sources changed before it,
  not only for same-commit sources.
