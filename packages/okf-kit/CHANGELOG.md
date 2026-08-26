# Changelog

All notable changes to `okf-kit` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `citations-resolve`: a new backtick-delimited `` `path:#heading` `` citation
  form (`.md` targets only) resolves to a whole Markdown section instead of
  a line range, so it is immune to a line-number shift caused by an edit
  anywhere above the cited section -- unlike even a heading-anchored
  `path:N-M#anchor` citation, whose line range still drifts on every such
  edit even though the anchor catches it landing in the wrong section. The
  heading text must match exactly one level 1 or 2 heading in the target
  (`heading-section-not-found` / `heading-section-ambiguous`), and the
  resolved section must have at least one non-blank line before the next
  heading of the same or shallower level (`heading-section-empty`). An
  optional content anchor, `` `path:#heading#"text"` ``, must occur on
  exactly one line inside the resolved section
  (`heading-section-content-anchor-not-found` /
  `-content-anchor-ambiguous`); a malformed attempt is reported rather than
  silently dropped (`heading-section-malformed`). See the doc comment above
  `HEADING_SECTION_CITATION_RE` in `src/rules/citations-resolve.ts` for the
  full rationale, including why the grammar requires the `:#` colon-hash
  rather than a bare `#`. Existing bundles that already use the older
  `` `path#heading` `` shape in ordinary prose (a Markdown link's target
  written in backticks) are unaffected: they no longer parse as a citation
  at all, producing the same findings as before this form existed.

## [0.7.0] - 2026-08-26

### Added

- `citations-resolve`: a new `anchor-malformed` notice fires when a `#`
  immediately follows a full citation's range but the text after it does
  not parse as either anchor form (unbalanced quotes, a backtick inside a
  quoted anchor, or nothing at all after the `#`, e.g. `path:N-M#` at end
  of a line). The citation is still checked exactly as an ordinary
  anchorless citation would be (backward compatible, no new error); without
  this, a typo in an anchor silently disabled the very drift check it was
  written for. A valid anchor, or a `#` in prose not immediately following
  a citation's range, produces nothing. Zero new findings on the
  orchestrator-workflow bundle (still 35 findings / 13 warnings / 22
  notices, 0 anchor findings).

### Changed

- `citations-resolve`: an anchored full citation's finding label now
  carries the anchor (`path:N-M#anchor`, or `path:N-M#"text"` for a string
  anchor), and the `anchor-heading-does-not-enclose` /
  `anchor-heading-not-found` messages now name the anchor text, matching
  `anchor-heading-mismatch` and `anchor-not-found-in-range`, which already
  did. Previously, two citations to the identical range with different
  anchors were indistinguishable in the output.

### Internal

- `citations-resolve`: the three independent fence-state scanners
  (`computeFencedSpans` for the citing doc, `computeFencedLineIndices` for
  the target, `isFenceOpeningLine`) now all derive from one shared
  `scanFenceLines` state machine instead of each replaying the same
  open/close fence logic on its own; behavior is unchanged (existing fence
  tests, including the citing-side tilde-fence and fence-opening-exception
  cases, stay green), plus two new target-side tests (a tilde fence and an
  unterminated fence reaching end of file) added as a regression net for
  the derivation itself.
- Review-round follow-up on the anchor heading form's known limitations
  (substring rather than token-boundary matching, and running the heading
  search against non-Markdown targets too): both revisited and kept as
  documented known limitations rather than implemented, given this round's
  deliberately small, non-speculative scope; see the README's "Known
  limitations" note.

## [0.6.0] - 2026-08-25

### Added

- `citations-resolve` now also resolves **short-form** citations: a bare
  (no backtick, no file name) `:N-M` colon-range, collected only when the
  nearest preceding non-whitespace text is a serial connective (`,`, `;`,
  `(`, or the word `and`/`or`) and bound to the last full `path:N-M`
  citation named earlier in the same paragraph (a paragraph boundary is a
  blank line), with no further check on the two ranges' relationship. A
  gate-cleared candidate with no full citation earlier in its own
  paragraph is reported `short-form-unbound` (notice), not silently
  skipped; a candidate the gate rejects is dropped before binding is ever
  attempted and produces no finding of any kind. Only a range form is
  recognised (`:580-588`); a bare single number (`:5`) is not, since it is
  too easily an unrelated enumeration marker (e.g. a numbered list) rather
  than a citation. Never collected at all inside a fenced/indented code
  block, an inline code span, or a Markdown table row. Reserved files
  (`index.md`, `log.md`) are excluded from short-form matching: they are
  append-only narrative journals that routinely describe historical "old
  :N-M -> new :X-Y" line-number deltas as prose, not live citations
  against current content; full/continuation citations in reserved files
  are unaffected. A bare parenthesized range `(N-M)` is deliberately NOT
  collected as a short-form citation at all -- see "Fixed" below for why.
  See "Short-form citations" in the README for the full shape/exclusion
  rules and their known limitations.
- `citations-resolve` now additionally checks, for a short-form citation's
  range into a test file (`.test.ts`/`.spec.ts`, and the `.js`/`.mjs`
  equivalents), that the range starts on a `describe(`/`it(` head line
  (`test-range-start-not-head`, a **warning**) and ends on a matching
  closing `});` line (`test-range-end-not-closing`, a **notice**: a
  correct start with a short end is also consistent with a deliberate
  partial citation, not necessarily drift).
- `citations-resolve` now additionally checks, for any short-form
  citation's range into a Markdown target, whether its start or end line
  is a bare bracket (`)`, `]`, `}`, `(`, `[`, `{`, optionally with a
  trailing `,`/`;`) or a bare code-fence delimiter -- a common signature of
  a boundary that drifted onto structural punctuation rather than real
  content. This is a **notice**, not a warning (`markdown-range-boundary-bracket-or-fence`):
  mechanical verification of "is this still the same block" is far less
  reliable for prose than for code brace structure. A range starting on a
  genuine *opening* fence line is exempted from the fence-as-drift-signal
  part of this check: citing a fenced block starting at its own opening
  delimiter is the natural, correct way to cite it.
- `citations-resolve` now supports an optional **anchor** on a full
  citation: `` `path:N-M#anchor` `` (e.g. `` `CHANGELOG.md:50-144#0.24.0` ``),
  closing a gap the range/blank/closing-brace checks above cannot: a
  CHANGELOG.md that grows by insertion at the top shifts every later
  entry's absolute line numbers on every release, so a citation that lands
  15 lines off in the wrong release section is exactly as green as before
  the shift (the motivating case: 16 `docs/okf/*.md` -> `CHANGELOG.md`
  citations in this repo's own `orchestrator-workflow` bundle, migrated to
  this form as part of the same change -- see that package's CHANGELOG).
  Two forms, told apart by the anchor text itself:
  - **Heading form** (bare/unquoted, e.g. `#0.24.0` or `#[0.24.0]`): the
    citation's nearest *enclosing* Markdown heading must contain the
    anchor text, and no heading of the same or shallower level may start
    before the range's end line -- i.e. the heading must enclose the
    *whole* range, not merely precede its start. Deliberately capped at
    heading level 2: a Keep-a-Changelog `CHANGELOG.md` nests `## [x.y.z]`
    release headings around identically-named `### Added`/`### Changed`/
    `### Fixed` subsections repeated in every release, so "nearest heading
    of any level" would make this check nearly useless (it would match the
    wrong release's own `### Changed` just as readily as the right one's);
    deeper subsection headings are transparent to the search instead. The
    anchor text itself matches word characters, `.`, and `-`, but never
    starts or ends on a `.`/`-`, so a trailing sentence period or a
    following `,`/`)` is never captured as part of it, and a hyphenated
    token (`0.24.0-rc1`) is captured whole rather than truncated at the
    first hyphen. A `#`-led comment line inside a fenced code block in the
    *target* is excluded from the heading search on both ends of the
    enclosure check, the same way a citing doc's own fences are already
    excluded from short-form matching. Mismatch is reported as
    `anchor-heading-mismatch` (wrong section) or
    `anchor-heading-does-not-enclose` (right section, but the range runs
    past its end); no heading at all precedes the citation is
    `anchor-heading-not-found`. All three are **warnings**.
  - **String form** (double-quoted, e.g. `#"reproduction requirement"`):
    the anchor text must occur, verbatim, on at least one line of the
    cited range itself -- "occurs inside it" rather than "encloses it", so
    this form also works against a non-Markdown target where "enclosing
    heading" has no meaning. The quoted text cannot cross a line break or
    a backtick, so an unterminated opening quote fails to parse as an
    anchor at all instead of greedily consuming everything up to some
    unrelated later quote character in the document -- which would
    otherwise silently hide every citation in between from this rule
    entirely. Mismatch is `anchor-not-found-in-range`, a **warning**.
  Anchors are full-citation-only (a continuation or short-form citation
  never carries its own path to hang one on) and strictly additive: the
  `#anchor` suffix is optional, so an existing anchorless citation matches
  and is checked exactly as before. Three rejected alternatives: embedding
  the literal heading markup (`` #"## [0.24.0]" ``) was rejected as reading
  worse in prose for no additional precision over the shorter heading-form
  token; a detached anchor elsewhere in the sentence was rejected as
  needing a second, unparseable-without-a-new-grammar citation site that
  is easy to leave behind when a sentence is edited later; a named-capture
  slug matching `sources-fresh`'s YAML shape was rejected because it would
  require a second citation site (frontmatter plus prose) to stay in sync,
  the exact class of drift this rule exists to catch.
  **Known limitations:** the heading form's containment check is a plain
  substring match against the heading's raw text, not a token-boundary
  match (an anchor `0.1` matches a heading containing `[0.10.0]`); this is
  a deliberate mechanical simplification, not a semantic guarantee. The
  heading form also runs against a target's raw lines regardless of file
  type, so a `# comment` line in a `.yml`/`.json` target is matched as a
  heading; restricting the heading form to `.md` targets is left as a
  known limitation rather than implemented in this change.
  **Measured** (this change; see the PR for the full mutation-probe log):
  the migrated `orchestrator-workflow` bundle (3 docs, 16 anchored
  citations) reports the same 0 errors / 13 warnings / 22 notices with the
  anchors present as without them (0 true findings, since all 16 were
  already correct; 0 false positives from the new check, in this corpus).
  A read-only sample against `agent-grounding/docs/okf` (not migrated to
  this form, out of scope for this change, and carrying no anchors at all)
  serves as a backward-compatibility check rather than a false-positive
  measurement of the anchor check itself: it reports 0 anchor findings,
  confirming an anchorless corpus is unaffected, as expected from the
  backward-compatible design. Two mutation probes against the
  `orchestrator-workflow` bundle: shifting one migrated citation's range
  into its neighbouring release section raised the warning count from 13
  to 14 (`anchor-heading-mismatch`), reverted to 13 clean; inserting an
  8-line dummy entry at the top of that package's `CHANGELOG.md`
  (simulating a normal release-note insertion) raised the warning count
  from 13 to 29, flagging all 16 migrated citations as
  `anchor-heading-mismatch` (the historical failure mode this change
  targets), reverted to 13 clean.

### Fixed

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
  consumer's `--strict` run. It is now a notice.
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
- Three successive rounds tried to separate a real short-form citation
  from ordinary prose that merely contains an N-M-shaped number pair by
  deciding from the range's *values*: an inverted-pair/span-cap check,
  then a year/well-known-port plausibility gate, then a
  containment-or-adjacency check against the paragraph's last full
  citation (`isContainedOrAdjacent`, now removed -- there is no longer a
  second value-shape filter layered behind the gate). All three were
  defeated by the same class of false positive: a doc with
  `src/t.test.ts:3-7` followed by "covers phases (1-2), (2-4), and (5-6)"
  produced two false `test-range-start-not-head` warnings under the
  containment/adjacency version, because every real paren-form citation
  this rule was ever built against has the identical shape
  `<English word> (N-M)` as ordinary prose -- there is no lexical signal
  that tells them apart. The bare parenthesized form `(N-M)` is therefore
  no longer collected as a short-form citation candidate at all. Measured
  against this rule's own dogfood bundle
  (`packages/orchestrator-workflow/docs/okf`), a compiled copy with paren
  collection disabled produced an identical finding count to one with it
  enabled (39 findings / 17 warnings / 22 notices either way) -- dropping
  it cost nothing.
- The colon form does not have the paren form's problem, but still needs
  a gate to avoid the same false-positive class: a candidate `:N-M` is
  now collected only when the nearest preceding non-whitespace text is a
  serial connective -- `,`, `;`, `(`, or the word `and`/`or` -- and, once
  collected, binds unconditionally to the paragraph's last full citation
  (the containment-or-adjacency check above is gone; a bound candidate is
  simply checked, with no further gate on the two ranges' relationship).
  Measured over the 137 markdown files in this repo: 37 bare `:N-M`
  occurrences preceded by whitespace or punctuation, 29 of them
  serial-connective-preceded, and all 29 are genuine citations (13
  preceded by `(`, 12 by a comma, 4 by `and`) -- the comma is
  load-bearing at 12 of 29, so the gate is not narrowed to `(` and `and`
  only. The 8 non-serial occurrences the gate correctly excludes are this
  package's own README quoting false-positive examples (now removed from
  the README along with the plausibility-gate description they
  illustrated), this rule's own test fixture, and `docs/okf/log.md`'s
  "old :N-M -> new :X-Y" delta narration (a reserved file, already
  skipped regardless of the gate). Documented residual, not fixed: a
  prose shape where the serial connective happens to precede a bare range
  that is still not a real citation (e.g. "the exposed ports, :80-443,
  stayed open") still binds and can produce a false warning; not observed
  anywhere in the 137-file corpus.
- Net effect on this rule's own dogfood bundle
  (`packages/orchestrator-workflow/docs/okf`): 49 findings / 16 warnings /
  33 notices (previous round, containment-or-adjacency) -> 39 findings /
  17 warnings / 22 notices (this round). The delta is exactly the 11 false
  `short-form-unbound` notices the containment/adjacency gate was
  producing disappearing, plus exactly one warning appearing:
  `init.ts:538-569 (short-form)`, `closing-brace-start-line` -- see "Known
  finding" below, this is a real, previously-suppressed finding, not a
  new false positive. All findings present before this round's gate
  change are unaffected.

### Known finding

Dogfooding this change against `packages/orchestrator-workflow/docs/okf`
surfaces citation drift beyond the single pre-existing one already known
(`install-fence-mechanics.md`'s `init.ts:538-569`, a short-form landing on
a lone closing brace, restored to a warning by this round's gate change --
see "Fixed" above): a compound colon-form list in the same doc, citing
`test/init.test.ts`'s `describe("tier variants (\`--tiers\`)")` block,
names 15 short-form sub-ranges. 13 of them produce a citations-resolve
finding (12 `test-range-start-not-head` warnings, 1
`test-range-end-not-closing` notice on `:1229-1265`); 11 of those 13 are
exact-length blocks shifted by a constant offset from their real
`describe`/`it` block (+33 lines for three of them, +116 for the other
eight -- consistent with roughly two rounds of content having been
inserted earlier in the same block without the rest of the list being
re-numbered). The other 2 of the 13 do not fit that pattern: `:1229-1265`
is at offset 0 (its start line is the real block head) but cites a
37-line span against a real 70-line block that grew; `:1636-1725` cites a
90-line span against a real 91-line block. Of the 2 remaining
citations that produce no finding at all: `:1170-1227` is genuinely
correct (not drifted); `:1614-1626` is drifted by the same +116 pattern
as the 8 above but produces no finding -- a known, inherent blind spot of
this mechanical, non-semantic checker: its cited start line coincidentally
lands on a real (but different) `describe`/`it` head, and its cited end
line coincidentally lands on a real (but unrelated, nested) closing
`});`, so the check cannot distinguish it from a correct citation. Fixing
any of these citations is out of scope for this change (no content fixes
to consumer-bundle citations).

Separately, the reserved-file carve-out (see "Fixed" above) leaves
genuine short-form citations in `index.md`/`log.md` completely unchecked.
The current dogfood bundle has four such citations, around
`log.md:362-370`.

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
