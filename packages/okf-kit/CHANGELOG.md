# Changelog

All notable changes to `okf-kit` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A new opt-in rule, `prose-line-references` (`--prose-line-references`,
  strict sub-flag `--prose-line-references-strict`), closes a gap
  `citations-resolve` leaves open: a prose-embedded line reference written
  outside its backtick grammar ("lines 496-498",
  "generate-codex-config.ts lines 129-132") is structurally invisible to
  `citations-resolve`'s `CITATION_RE`, which requires a literal `:` between
  the path and the digits. A doc can be re-verified, re-stamped, and pass
  `check` with 0 findings while its prose line numbers are drifted, because
  nothing ever looked at them -- exactly what happened in harness task
  ad66c43f (2026-08-30/31): review round 1 of that OKF sweep found 9 wrong
  prose references behind a fresh `citations-resolve`-clean stamp, the fix
  round's own sweep found more (including one citing the wrong file
  entirely), and the verification round a third residue; both reviewers
  named the missing mechanical guard as the structural cause. Extracts
  `line N`/`lines N-M`/`lines N to M` (deliberately not `L N`, a
  comma-separated list of several numbers, or a second unlabelled range
  chained by "vs"; see the README for the full, deliberately conservative
  grammar), binds each to the nearest named file (same sentence first,
  then same paragraph, reusing `citations-resolve`'s own path-resolution
  rules verbatim rather than a second, drift-prone copy), and reports
  `out-of-bounds`, `blank-start-line`, `unresolvable`, or `ambiguous`.
  `--prose-line-references-strict` additionally flags EVERY extracted
  reference (resolved or not) with the remedy: lift it into a backtick
  anchored citation, or de-precise it to a symbol name. Off by default;
  see "Prose line references (opt-in, `--prose-line-references`)" in the
  README for the full grammar, binding rule, and finding table.

- `prose-line-references` review-round fixes, found by a reviewer pass on
  the rule above before it shipped: a start line of `0` no longer indexes
  `lines[-1]` and is now its own `out-of-bounds` finding rather than a
  misclassified `blank-start-line`; `LINE_REF_RE`'s leading `\b` no longer
  matches right after a hyphen, so "in-line 999", "multi-line 999", and
  "command-line 999" are no longer mis-extracted as citations to line 999;
  a reference inside an HTML comment (`` <!-- see line 5 above --> ``) or
  on a line that is itself a Markdown ATX heading (`## Line 3 semantics`)
  is now excluded from extraction, the same way a fenced code block's
  example already was; and a finding now quotes the doc's own matched text
  verbatim (an en-dash range stays an en-dash range) instead of a
  re-rendered, always-hyphenated approximation, with the normalised
  hyphen-ranged form folded into the message body only when it actually
  differs from what the doc wrote. Also closes a coverage gap the
  reviewer found: the binding rule's paragraph-level fallback
  (`nearestPrecedingMentionInParagraph`) and its same-sentence
  "following mention" branch had no test that could tell them apart from
  a hypothetical "always bind to the first mention in the paragraph"
  mutant; see "Verification" below for the fixture and the mutation
  check.

- `citations-resolve`: a fifth `--require-anchors` check,
  `anchor-required-continuation` (warning), closes a gap the four checks
  added in 0.8.0 left open: they all fire only for a "full" citation, so a
  continuation (`` `:N` ``/`` `:N-M` ``, `` -`M` ``/`` –`M` ``, `` (`N`) ``)
  or a bound paragraph-bound short-form `:N-M` chained off an
  ALREADY-anchored full citation was invisible to `--require-anchors`
  entirely: it carries no path of its own to hang an anchor on (see
  "Anchored citations" in the README), so it was never itself an in-repo
  full citation `anchor-required` could reach, and the anchor on its
  governing citation does not (and structurally cannot) extend to a later
  continuation of it. A line-shift that lands the continuation on still
  non-blank, in-bounds, unrelated content -- exactly the drift class this
  rule exists to catch -- was previously silent for a continuation the
  same way it was for an unanchored full citation before 0.8.0. Fires once
  the continuation's governing citation resolves in-repo, mirroring
  `anchor-required`'s own exemptions (a reserved citing doc; a
  `requireAnchors.allow` pattern, matched against the GOVERNING citation's
  raw citedPath, since a continuation has no path of its own to match).
  The paragraph-bound short form is included under the identical
  reasoning. See "Anchor strictness (opt-in, `--require-anchors`)" in the
  README for the full rationale.

### Verification

- `prose-line-references`: default mode (no `--prose-line-references`) is
  byte-identical before and after this change: verified by building the
  CLI at both the pre-change commit and this change, then running `check
  --json` in default mode against the same three real bundles as below
  (each repo's full real tree as `--repo-root`, not a narrow `docs/okf`-
  only extraction, since this rule's own file-mention resolution needs the
  rest of the repo present) and diffing the JSON output byte for byte --
  0 bytes of diff on all three.
- `prose-line-references` migration backlog, run with
  `--prose-line-references` after this change against the same three
  bundles, full real repo tree as `--repo-root`: agent-dx's own
  orchestrator-workflow bundle 3 findings (2 `out-of-bounds`, 1
  `blank-start-line`), harness 5 (2 `ambiguous`, 1 `blank-start-line`, 2
  `unresolvable`), agent-grounding 0. Spot-checked, not exhaustively
  audited: the harness `ambiguous` pair is a real collision (`intercept.ts`
  resolves to both `src/cli/policy/intercept.ts` and
  `src/runtime/intercept.ts`); the agent-dx `out-of-bounds`/
  `blank-start-line` trio is a real false positive of the binding rule's
  own stated limitation (a "test lines N-M" phrase bound to a file named
  elsewhere in the same sentence for an unrelated reason, not the file the
  line numbers actually belong to -- once before the reference, once
  after) -- see the README's closing paragraph on "Prose line references"
  for that known category. No
  consumer CI currently selects on `[prose-line-references]` findings by
  rule id, so no consumer pin bump is required before this rule starts
  reporting; enabling `--prose-line-references` anywhere is itself the
  opt-in.
- `prose-line-references` review-round fixes above: default mode is still
  byte-identical, re-verified the same way as above (build both commits,
  `check --json` on the same three real bundles, diff byte for byte -- 0
  bytes of diff on all three). The migration backlog counts are unchanged
  by these fixes: agent-dx 3, harness 5, agent-grounding 0, identical
  reasons to the counts above -- none of the three real bundles contained
  a `line 0`, a hyphen-joined "-line N" word, an ATX heading naming a
  line, or an HTML comment naming one. Four mutation probes verified
  by hand against the new tests: replacing nearest-in-sentence binding
  with first-in-paragraph binding, deleting the en-dash/em-dash/"to"
  alternation from `LINE_REF_RE`, deleting the inverted-range branch in
  `checkTarget`, and disabling the reserved-doc skip each fail a
  dedicated new test, and pass again once reverted.
- Regression test added for a latent `FILE_MENTION_RE` extension-matching
  bug found while measuring the migration backlog above: the extension
  alternation lists `js` before `json`, and `js` is a strict prefix of
  `json`; without forcing the regex to reject a truncated match, a real
  `config.json` mention resolved (or failed to resolve) as `config.js`
  instead. Fixed with a trailing `(?!\w)` on the match; `citations-resolve`'s
  own `CITATION_RE` does not have this problem, since its mandatory
  trailing `:` already forces the same backtracking.
- Default mode (no `--require-anchors`) is byte-identical before and
  after this change: verified by building the CLI at both the pre-change
  commit and this change, then running `check --json` in default mode
  against three real bundles (this repo's own
  `packages/orchestrator-workflow/docs/okf`, harness's `docs/okf`, and
  agent-grounding's `docs/okf`, each extracted read-only at a pinned
  commit) and diffing the sorted finding lists -- 0 lines of diff on all
  three, both against a narrow `docs/okf`-only extraction and against the
  full real repo tree as `--repo-root`.
- Migration backlog, run with `--require-anchors` after this change
  against the same three bundles with their full real repo tree as
  `--repo-root` (a narrow `docs/okf`-only extraction under-counts this,
  since most citations fail to resolve without the rest of the repo
  present): agent-dx's own orchestrator-workflow bundle 70
  `anchor-required-continuation` findings, harness 24, agent-grounding
  24. Consumer CI pins (agent-dx's and agent-grounding's own
  `okf-anchor-guard` jobs, which select findings by the trailing
  `[rule-id]` bracket) must be bumped to this version before
  `anchor-required-continuation` starts gating; that bump is out of scope
  here.

## [0.8.0] - 2026-08-27

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
- `citations-resolve`: a new `--require-anchors` opt-in (and
  `--require-anchors-allow <patterns...>` for exempting specific citedPath
  globs/exact matches) adds four stricter, `warning`-severity checks, off
  by default so an existing bundle's plain `check` findings are unaffected:
  `anchor-required` (an in-repo full citation carries no `#anchor` at all,
  except a reserved citing doc or an allowlisted target),
  `anchor-not-on-last-line` (a string anchor was found in its cited range,
  but not on the range's own last content line -- an anchor on the first
  line survives a small insertion above the range, since the shifted
  window still contains its original content just at a different offset;
  the last content line falls out of the window on any insertion at all),
  `anchor-not-unique-in-range` (a string anchor occurs on more than one
  line of its cited range; a count of zero stays
  `anchor-not-found-in-range` as before, unconditionally), and
  `test-range-straddles-block` (a FULL citation's own range into a
  `.test.`/`.spec.` target (`.ts`, `.js`, `.mjs`) contains a
  `describe`/`it`/`test` block-head line, at the same or a shallower
  indent than the range's own first line, on any line other than that
  first line -- its own new rule, not a reuse of the existing
  `test-range-start-not-head`/`test-range-end-not-closing` pair, which
  stay short-form-only). See "Anchor strictness (opt-in,
  `--require-anchors`)" in the README for the full rationale; verified
  byte-identical findings on existing bundles before and after this
  change, off by default and additive only.
- `citations-resolve`: four details of the `--require-anchors` checks
  added above, worth knowing when adopting them:
  `test-range-straddles-block` no longer flags a block-head line nested
  strictly deeper than the range's own start line, so citing a whole
  `describe` in full (including every `it(` nested inside it) is no
  longer misreported as straddling into another block; only a sibling or
  outer block-head line still counts. `anchor-not-on-last-line` now
  anchors against a range's last CONTENT line rather than its literal
  last line, so a range that (correctly) ends on bare closing boilerplate
  (`});`, `]);`, `}),`, and similar) can anchor on the real content line
  before it instead of being forced onto the boilerplate itself. Both of
  the opt-in's per-atom checks (`test-range-straddles-block` and the
  string-anchor checks) are now also exempt for a reserved citing doc
  (`index.md`/`log.md`), matching `anchor-required`'s existing exemption
  rather than only that one check having it; and a citation that both
  straddles a block boundary and carries a missing/misplaced anchor now
  gets both findings instead of the anchor problem silently vanishing
  behind the straddle one.

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
