# Changelog

All notable changes to `okf-kit` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `citations-resolve` now also resolves **short-form** citations: a bare
  (no backtick, no file name) `:N-M` colon-range or `(N-M)` parenthesized
  range, bound to the last full `path:N-M` citation named earlier in the
  same paragraph (a paragraph boundary is a blank line). A short-form
  citation with no full citation earlier in its own paragraph is reported
  `short-form-unbound` (warning), not silently skipped. Only a range form
  is recognised (`(373-375)`, `:580-588`); a bare single number (`(1)`,
  `:5`) is not, since it is too easily an unrelated enumeration marker
  (e.g. a numbered list) rather than a citation. Reserved files
  (`index.md`, `log.md`) are excluded from short-form matching: they are
  append-only narrative journals that routinely describe historical
  "old N-M -> new X-Y" line-number deltas as prose, not live citations
  against current content, which bare-range matching cannot tell apart
  from a real short-form citation; full/continuation citations in reserved
  files are unaffected.
- `citations-resolve` now additionally checks, for a **paren-form**
  short-form citation's range into a test file (`.test.ts`/`.spec.ts`, and
  the `.js`/`.mjs` equivalents), that the range starts on a `describe(`/
  `it(` head line and ends on a matching closing `});` line
  (`test-range-start-not-head` / `test-range-end-not-closing`, both
  warnings). This is deliberately NOT applied to colon-form short forms or
  to full/continuation citations: see the scope note below.
- `citations-resolve` now additionally checks, for any short-form
  citation's range into a Markdown target, whether its start or end line
  is a bare bracket (`)`, `]`, `}`, `(`, `[`, `{`, optionally with a
  trailing `,`/`;`) or a bare code-fence delimiter -- a common signature of
  a boundary that drifted onto structural punctuation rather than real
  content. This is a **notice**, not a warning (`markdown-range-boundary-bracket-or-fence`):
  mechanical verification of "is this still the same block" is far less
  reliable for prose than for code brace structure, and is applied to both
  short-form syntaxes since a false positive here is only advisory.

### Scope note

The test-file block-boundary check above is scoped to short-form,
paren-form citations only, not applied to colon-form short forms nor to
full/continuation citations. Two reasons, found while dogfooding this
change against `packages/orchestrator-workflow/docs/okf`: (1) at least one
existing full citation in that bundle intentionally cites a couple of
arbitrary lines of a shared regex definition, not a describe/it block --
applying the check there would flag a correct, non-drifted citation; (2) a
colon-form short form inside a `path:N-M, :X-Y, :Z-W`-style compound list
conventionally marks an approximate detail location *within* an
already-cited, much larger range (that bundle's own prose calls these
"sub-citations not individually re-derived"), not a block citation, so most
of them do not start on a describe/it head or end on a matching `});` --
not drift, just a different citation granularity this mechanical checker
cannot distinguish from real drift without author intent. Every paren-form
short form found in that same bundle, by contrast, does cite one precise
describe/it block per clause.

### Known finding

Dogfooding this change against `packages/orchestrator-workflow/docs/okf`
surfaces one pre-existing, previously-invisible citation drift:
`install-fence-mechanics.md`'s short-form `init.ts:538-569` now resolves
and lands on a lone closing brace rather than real content (its start line
looks like it should be a few lines earlier). This is exactly the kind of
gap short-form resolution closes; fixing the citation itself is out of
scope for this change (no content fixes to consumer-bundle citations).

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
