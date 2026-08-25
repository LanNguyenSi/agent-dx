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
  `short-form-unbound` (notice), not silently skipped. Only a range form
  is recognised (`(373-375)`, `:580-588`); a bare single number (`(1)`,
  `:5`) is not, since it is too easily an unrelated enumeration marker
  (e.g. a numbered list) rather than a citation. A candidate match is only
  collected when it passes a plausibility gate (inverted or implausibly
  wide range rejected; a pair that both look like a year, or, colon-form
  only, a well-known port pair, is never a citation), and is never
  collected at all inside a fenced/indented code block, an inline code
  span, or a Markdown table row. Reserved files (`index.md`, `log.md`) are
  excluded from short-form matching: they are append-only narrative
  journals that routinely describe historical "old N-M -> new X-Y"
  line-number deltas as prose, not live citations against current content,
  which bare-range matching cannot tell apart from a real short-form
  citation; full/continuation citations in reserved files are unaffected.
  See "Short-form citations" in the README for the full shape/exclusion
  rules and their known limitations.
- `citations-resolve` now additionally checks, for a short-form citation's
  range into a test file (`.test.ts`/`.spec.ts`, and the `.js`/`.mjs`
  equivalents), that the range starts on a `describe(`/`it(` head line
  (`test-range-start-not-head`, a **warning**) and ends on a matching
  closing `});` line (`test-range-end-not-closing`, a **notice**: a
  correct start with a short end is also consistent with a deliberate
  partial citation, not necessarily drift). Applied to both short-form
  syntaxes alike.
- `citations-resolve` now additionally checks, for any short-form
  citation's range into a Markdown target, whether its start or end line
  is a bare bracket (`)`, `]`, `}`, `(`, `[`, `{`, optionally with a
  trailing `,`/`;`) or a bare code-fence delimiter -- a common signature of
  a boundary that drifted onto structural punctuation rather than real
  content. This is a **notice**, not a warning (`markdown-range-boundary-bracket-or-fence`):
  mechanical verification of "is this still the same block" is far less
  reliable for prose than for code brace structure, and is applied to both
  short-form syntaxes since a false positive here is only advisory. A
  range starting on a genuine *opening* fence line is exempted from the
  fence-as-drift-signal part of this check: citing a fenced block starting
  at its own opening delimiter is the natural, correct way to cite it.

### Fixed (review round 2)

- The test-file block-boundary check above previously applied only to
  paren-form short forms, on the documented theory that a colon-form short
  form inside a compound `path:N-M, :X-Y, :Z-W`-style list marked an
  approximate detail location rather than a block citation. Reviewing that
  claim by sampling this rule's own dogfood bundle -- replacing the
  paren-only gate with an unconditional check locally raised the dogfood
  finding count from 1 to 14, and reading a sample of the new findings
  against both the citing prose and the cited file showed every one was a
  whole cited block shifted by the same constant line offset, i.e. real
  drift the carve-out was hiding for the dominant colon-form syntax, not a
  granularity convention. The carve-out is removed; see the new
  warning/notice severity split above for how a wrong start (strong drift
  evidence) and a wrong end (also consistent with a deliberate partial
  citation) are now told apart instead of one gating the whole check by
  syntax form.
- `short-form-unbound` previously fired at warning severity, so an
  unrecognised bare `N-M` range anywhere in ordinary prose (a year range,
  a port range, a small plain-English number range) could fail a
  consumer's `--strict` run. It is now a notice. A plausibility gate was
  also added before a bare range is even collected as a short-form
  candidate at all (see "Added" above), closing the sharper half of the
  same bug: an unrelated numeric range in prose silently binding to a real
  citation target and being checked (and, for a year or well-known-port
  shaped range, sometimes producing a false `range-exceeds-file`) rather
  than merely being reported unbound.
- Short-form matching previously scanned fenced code blocks, indented code
  blocks, Markdown table rows, and (partially -- only a match directly
  touching a backtick was excluded) inline code spans for bare ranges. All
  four are now excluded from short-form matching entirely.
- The README stated the test-file block-boundary check applied "for a
  paren-form short form only", including for the Markdown notice; the
  Markdown notice was never actually gated that way in code (the CHANGELOG
  already said so correctly). Both are now stated accurately and
  consistently (moot for the test-file check specifically, now that its
  paren-only gate is removed).
- The `short-form-unbound` message ("no target document named earlier in
  this paragraph") was inaccurate for a paragraph that does name a target
  document but without a `:N` line number (e.g. this rule's own dogfood
  target, `log.md`, narrating historical deltas): the target document was
  named, `CITATION_RE` just never matched it as a full citation. Reworded
  to "no full `path:N` citation earlier in this paragraph to bind to".

### Known finding

Dogfooding this change against `packages/orchestrator-workflow/docs/okf`
surfaces citation drift beyond the single pre-existing one already known
(`install-fence-mechanics.md`'s `init.ts:538-569`, a short-form landing on
a lone closing brace): applying the block-boundary fix above to
colon-form short forms surfaces 13 further findings (12 warnings, 1
notice) in the same doc, all within one compound colon-form list citing
`test/init.test.ts`'s `describe("tier variants (\`--tiers\`)")` block.
Reading the citing prose against the real file shows a consistent pattern:
every cited range's length exactly matches the length of the real
`describe`/`it` block its prose describes, shifted by a constant offset
(+33 lines for the first four citations in the list, +116 for the rest --
consistent with roughly two rounds of content having been inserted earlier
in the same block without the rest of the list being re-numbered). One
further citation in the same list, `:1614-1626`, is drifted by the same
+116 pattern but produces no finding at all: its cited start line
coincidentally lands on a real (but different) `describe`/`it` head, and
its cited end line coincidentally lands on a real (but unrelated, nested)
closing `});`, so the mechanical check cannot distinguish it from a
correct citation. This is a known, inherent blind spot of a mechanical,
non-semantic checker, not a regression from this change. Fixing any of
these citations is out of scope for this change (no content fixes to
consumer-bundle citations); the full classified list, with cited vs. real
ranges, is recorded against the citation-audit follow-up task.

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
