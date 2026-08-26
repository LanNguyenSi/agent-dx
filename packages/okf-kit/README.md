# okf-kit

`okf-kit` validates knowledge bundles against the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), a shape for markdown-plus-frontmatter knowledge bundles meant to be readable by both humans and agents. The check catalog here was shaped by the Phase-0 OKF pilot in agent-tasks ([PR #385](https://github.com/LanNguyenSi/agent-tasks/pull/385)), where a few structural mistakes (bad links, absolute paths) turned out to be easy to make and easy to catch mechanically.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Install

```bash
# one-off, no install
npx okf-kit check path/to/bundle

# or install it
npm install -g okf-kit
```

Requires Node >= 20.

## Quick start

```bash
okf-kit check path/to/bundle

# explicit repo root, used for both sources-shape existence checks and
# sources-fresh staleness checks (see "repo-root auto-detection" below for
# what happens when you omit this)
okf-kit check path/to/bundle --repo-root /path/to/repo

# JSON output for tooling
okf-kit check path/to/bundle --json

# fail on warnings too, not just errors (STALE findings are warnings)
okf-kit check path/to/bundle --strict
```

## Scaffold a bundle (`init`)

```bash
# scaffold docs/okf (the default target, relative to the current directory)
okf-kit init

# scaffold a specific directory instead
okf-kit init path/to/bundle

# an existing, non-empty target directory is refused (exit 2) unless forced;
# --force overwrites only the files init owns, nothing else in the directory
okf-kit init path/to/bundle --force
```

`init` writes `index.md`, `log.md`, and one template doc per concept type: `overview-template.md`, `module-template.md`, `invariant-template.md`, `runbook-template.md`, plus `benchmark-template.md` for measuring whether the bundle helps. `index.md` and `log.md` carry no frontmatter (`reserved-files-bare`); every template doc carries full frontmatter (`type`, `title`, `description`, `tags`, `timestamp`, and, except for the benchmark template, `sources`) plus inline HTML-comment guidance on writing dense, source-verified, pointer-carrying docs instead of filler. All generated links are same-directory relative (`name.md`), never a leading-slash form.

### Placeholder sources are intentional

Every template doc except `benchmark-template.md` ships with `sources: [path/to/covered/source]`, a placeholder, not a real path. Running `okf-kit check` against the freshly scaffolded bundle (with a repo root available, explicit or auto-detected) will report that placeholder as a `sources-shape` "does not exist" error on every template doc. That is intentional: it is the tool telling you which docs still need a real source path, not a bug in the scaffold. The `init` completion message repeats this so it isn't missed. Replace each placeholder with the real repo-root-relative path(s) the doc describes as you write it, and the error clears doc by doc.

### Authoring guidance

- **`timestamp` means "last verified against sources," not "created on."** Bump it, and add a line to `log.md`, every time you re-verify a doc against its sources. Always use the real instant of verification (`new Date().toISOString()` or equivalent); never hand-write an artificial midnight datetime, `sources-fresh` staleness comparisons depend on it being real.
- **Never list the bundle's own directory in `sources`.** A bundle directory changes on every doc edit inside it, so a self-referential `sources` entry goes permanently stale. This happened to the OKF pilot's own `BENCHMARK.md` (`agent-tasks` `docs/okf/BENCHMARK.md`, `sources: [docs/okf/]`); `benchmark-template.md` here omits `sources` entirely for the same reason, since a benchmark record measures the bundle rather than describing a piece of the codebase.
- **Keep all links same-directory relative.** Use `name.md`, not `/name.md`; see `no-absolute-links` above for why a leading slash breaks once the bundle is viewed outside its own repository.
- **Write a sibling short-form citation as a connective-led `:N-M`, not `(N-M)`.** When a paragraph cites several sub-ranges of a source already named by a full `path:N-M` citation earlier in the same paragraph, write each later one as a `:N-M` led by one of the serial connectives the gate accepts -- `,`, `;`, `(`, or a trailing `and`/`or` -- right after the phrase it points at (e.g. `review finding L1 (:1170-1227, ...)`). `citations-resolve` only recognises the colon form; a parenthesized `(N-M)` is never checked, so it can drift silently. This convention is not demonstrated by any scaffolded template; it is a `citations-resolve` authoring rule. See "Citation resolution (citations-resolve)" below.

## Check catalog

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. A relative target that climbs out of the bundle directory (`../outside.md`) and still resolves on disk is accepted; the rule checks resolution, not containment. |
| `no-absolute-links` | warning | Link targets should not start with `/`. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources`, when present, must be a non-empty array of non-empty strings. With a repo root (explicit or auto-detected), each listed path (file or directory) must also exist under it. |
| `sources-fresh` | warning / notice | For docs with a `sources` list and a repo root, flags a source path whose last git commit is newer than both the doc's `timestamp` and the doc file's own last commit. See "Staleness (sources-fresh)" below. |
| `citations-resolve` | warning / notice | For docs with a repo root, flags a `` `path:N`/`path:N-M` `` citation (and its `` `:N` ``/`` -`M` ``/`` (`N`) `` continuations, and bare paragraph-bound short forms `:N-M`/`(N-M)`) whose target file is missing, whose range is inverted or exceeds the file, or whose start line is blank or (for a non-markdown target) only a closing brace. A full citation may also carry an optional `#anchor` (e.g. `` `CHANGELOG.md:50-144#0.24.0` ``), checked against the target's own structure/content instead of just its line numbers. A backtick-delimited `` `path:#heading` `` citation (`.md` targets only) resolves to a whole Markdown section instead of a line range, immune to every line-number shift above it; see "Heading-section citations" below. A short-form citation's range into a test file is also checked for a describe/it block boundary. `--require-anchors` opts into four additional checks; see "Anchor strictness (opt-in, `--require-anchors`)" below. See "Citation resolution (citations-resolve)" below. |

## repo-root auto-detection

**Behavior change:** when `--repo-root` is omitted, okf-kit runs `git rev-parse --show-toplevel` from the bundle directory and uses the result if it succeeds. A bundle that lives inside a git work tree therefore gets `sources-shape` existence checks and `sources-fresh` staleness checks by default now, not just when you pass `--repo-root` explicitly.

If the bundle is not inside a git work tree (or `git` is unavailable), repo-root stays unset: `sources-shape` skips existence checks exactly as before, and `sources-fresh` emits a single notice (`staleness skipped: not inside a git work tree`) rather than silently reporting nothing, so a "clean" run is never a fake pass.

Pass `--repo-root` explicitly to pin a specific root (useful in CI when the bundle and the code it documents live in different checkouts) or to opt out of the ambient repo (point it at the bundle directory itself to disable both checks' access to the rest of the repo).

## Staleness (sources-fresh)

`sources-fresh` compares each frontmatter `sources` entry's last git commit time against the doc's `timestamp`, and additionally against the doc file's own last commit time: a source committed at or before the doc file's last commit is treated as fresh even when the frontmatter `timestamp` is older. That keeps squash-merge PRs honest: when a doc re-stamp lands in the same commit as its changed sources, the merge gives every source a commit time later than any pre-merge `timestamp`, which used to make such docs stale-on-arrival. The rule never blocks a doc that has no `sources`, and it never invents an error where git can't give a real answer:

| Situation | Severity | Message |
|-----------|----------|---------|
| A source path's last commit is newer than the doc's `timestamp` and the doc file's last commit | warning | `STALE: <path> changed <iso> after doc timestamp <iso>` |
| A source path's last commit is newer than the doc's `timestamp` but at/before the doc file's last commit | (nothing) | fresh: doc and source landed together (or the doc was committed later) |
| A source path exists but has no git history (untracked) | notice | `untracked by git, staleness unknown: <path>` |
| The doc's `timestamp` is missing or not a parseable date, while `sources` is present | notice | `staleness not assessable: no valid timestamp` |
| No repo root available (see auto-detection above) | notice | `staleness skipped: not inside a git work tree` |
| A source path does not exist on disk | (nothing) | left to `sources-shape`, not duplicated here |

STALE findings are warnings, so they are advisory by default; run with `--strict` to fail the build on them.

Known limitation: a `git log` call that fails for a reason other than "no history for this path" (for example a corrupt object or a transient git error) is reported the same way as a genuinely untracked path, the `untracked by git, staleness unknown` notice; okf-kit does not currently distinguish a real git failure from "no commits touch this path".

Known limitation: the doc-commit comparison suppresses staleness for every source older than the doc file's last commit, not only for sources from the same commit. For a multi-source doc that means any commit touching the doc (a typo fix, a repo-wide formatter run, a rename, which resets the doc's last-commit time because `git log` runs without `--follow`) silences drift on all sources changed before it, even ones nobody re-verified. The frontmatter `timestamp` still governs sources changed after the doc's last commit.

**Authoring guidance:** when you re-verify a doc against its sources, bump its frontmatter `timestamp` (and add a line to the bundle's `log.md`) so `sources-fresh` reflects that the doc is current again.

## Citation resolution (citations-resolve)

`sources-fresh` catches a source file changing after a doc's `timestamp`, but it is structurally blind to an edit that shifts *line numbers* inside a still-fresh file: a doc citing `path:42` keeps citing line 42 even after an edit moves the referenced content to line 50. `citations-resolve` finds every `` `path:N` ``/`` `path:N-M` `` citation in a doc, resolves `path` to a real file, and flags a citation that clearly cannot be pointing at real content any more. It is mechanical only (no symbol/AST resolution): it does not verify the cited line is *semantically* the right one, only that the target exists, the range is sound, and the start line is not blank or (for a non-markdown target) a lone closing brace/bracket.

| Rule id | Meaning |
|---------|---------|
| `missing-file` | The cited path could not be resolved to a real file (see path resolution below). |
| `path-traversal-rejected` | The cited path contains a `..` segment; rejected without ever being resolved. |
| `inverted-range` | A range's end line is before its start line. |
| `range-exceeds-file` | The cited line (or the end of a range) is past the end of the resolved file. |
| `blank-start-line` | The start line resolves to a blank line. A citation whose start line is blank is flagged; cite the first content line instead. Consumers enabling this rule on an existing bundle should expect to fix citations like this once, the first time they turn it on. |
| `closing-brace-start-line` | For a non-markdown target, the start line is only a closing brace/bracket/paren (`}`, `)`, `]`, optionally with a trailing `,`/`;`) -- a common signature of a cited block having moved. |
| `unresolved-ambiguous` | More than one file in the repo matches the cited path; reported as a `notice` (never counted toward `--strict`), not guessed at. |
| `unreadable-target` | The resolved target file exists but could not be read (e.g. permission denied); reported as a `notice` (never counted toward `--strict`) with the OS error code in `detail`, since an unreadable file is not evidence the citation itself is wrong. |
| `short-form-unbound` | A short-form citation (see below) has no full citation earlier in its own paragraph to bind to; reported as a `notice` (never counted toward `--strict`). |
| `test-range-start-not-head` | A short-form citation's range into a test file does not start on a `describe(`/`it(` head line. A wrong start is strong drift evidence, so this is a **warning**. |
| `test-range-end-not-closing` | A short-form citation's range into a test file has a correct start (a real `describe(`/`it(` head) but does not end on a matching closing `});` line; reported as a `notice` (never counted toward `--strict`), since a correct start with a short end is also consistent with a deliberate partial citation. |
| `markdown-range-boundary-bracket-or-fence` | A short-form citation's range into a Markdown target starts or ends on a bare bracket, or (except see the fence-opening exception below) a bare code-fence line; reported as a `notice` (never counted toward `--strict`). |
| `anchor-heading-mismatch` | A heading-anchored citation's (see below) nearest enclosing heading does not contain the anchor text -- the range now lands in the wrong section. **Warning**. |
| `anchor-heading-does-not-enclose` | A heading-anchored citation's anchor text matches its nearest enclosing heading, but the range runs past that heading's own section (a heading of the same or shallower level starts before the range ends). **Warning**. |
| `anchor-heading-not-found` | A heading-anchored citation has no heading (level 1 or 2) anywhere before its start line to anchor against; use a string anchor (`#"..."`) instead against a target with no heading structure. **Warning**. |
| `anchor-not-found-in-range` | A string-anchored citation's (see below) anchor text does not occur, verbatim, on any line of the cited range. **Warning**. |
| `anchor-malformed` | A `#` immediately follows a citation's range, but the text after it does not parse as either anchor form (unbalanced quotes, a backtick inside a quoted anchor, or nothing at all after the `#`). The citation is still checked as an ordinary anchorless citation; reported as a `notice` (never counted toward `--strict`) so a typo in an anchor does not silently turn off the very check it was written for. |
| `heading-section-not-found` | A heading-section citation's (see below) heading text does not match any level 1 or 2 heading in the target. **Warning**. |
| `heading-section-ambiguous` | A heading-section citation's heading text matches more than one level 1 or 2 heading in the target; reported rather than silently resolved to the first match. **Warning**. |
| `heading-section-empty` | A heading-section citation resolved to a single heading, but that heading's section has no non-blank content before the next heading of the same or shallower level. **Warning**. |
| `heading-section-content-anchor-not-found` | A heading-section citation's optional content anchor (`` `path:#heading#"text"` ``) does not occur on any line of the resolved section. **Warning**. |
| `heading-section-content-anchor-ambiguous` | A heading-section citation's content anchor occurs on more than one line of the resolved section; expected exactly one. **Warning**. |
| `heading-section-malformed` | A backtick-delimited `` `path:#...` `` opener does not parse as a well-formed heading-section citation (an unterminated or empty content-anchor quote, an unquoted third segment, or a non-`.md` target, including a non-lowercase `.MD` extension); reported as a `notice` (never counted toward `--strict`) so a typo does not silently vanish. |
| `anchor-required` | (opt-in, `--require-anchors`) An in-repo full citation carries no `#anchor` at all. **Warning**. |
| `anchor-not-on-last-line` | (opt-in, `--require-anchors`) A string-anchored citation's anchor text was found in the cited range, but not on the range's own last CONTENT line (see below). **Warning**. |
| `anchor-not-unique-in-range` | (opt-in, `--require-anchors`) A string-anchored citation's anchor text occurs on more than one line of the cited range. **Warning**. |
| `test-range-straddles-block` | (opt-in, `--require-anchors`) A full citation's own range into a `.test.`/`.spec.` target (`.ts`, `.js`, `.mjs`) contains a `describe`/`it`/`test` block-head line, at the same or a shallower indent than the range's own first line, on any line other than that first line. **Warning**. |

**Anchored citations.** A full citation may carry an anchor directly after its range: `` `path:N-M#anchor` ``, e.g. `` `CHANGELOG.md:50-144#0.24.0` ``. This closes a gap the checks above cannot: a CHANGELOG.md that grows by inserting each new release at the top shifts every later entry's absolute line numbers, so a citation that lands 15 lines off in the *wrong* release section is exactly as green as before the shift -- none of `missing-file`/`inverted-range`/`range-exceeds-file`/`blank-start-line`/`closing-brace-start-line` can tell the difference. An anchor pins the citation to a piece of the target's own structure or content that a pure line-shift does not preserve. Two forms, told apart by the anchor text itself:

- **Heading form** (bare/unquoted, e.g. `#0.24.0` or `#[0.24.0]`): the citation's nearest *enclosing* Markdown heading (level 1 or 2 only -- see below) must contain the anchor text, and the range must not run past that heading's own section (no heading of the same or shallower level may start before the range's end line). Capped at heading level 2 deliberately: a Keep-a-Changelog `CHANGELOG.md` nests `## [x.y.z]` release headings around identically-named `### Added`/`### Changed`/`### Fixed` subsections repeated in every release, so matching "the nearest heading of any level" would make this check nearly useless there (it would match the wrong release's own `### Changed` just as readily as the right one's); deeper subsection headings are transparent to the search instead. The anchor text itself may contain word characters, `.`, and `-`, but never starts or ends on a `.` or `-`, so a trailing sentence period or a following `,`/`)` never becomes part of it (e.g. `` `path:7-8#0.24.0.` `` at the end of a sentence captures `0.24.0`, not `0.24.0.`); a hyphenated token like `0.24.0-rc1` is captured whole. A fenced code block inside the *target* (e.g. a `` ```bash `` example containing a `#`-led comment) is excluded from the heading search the same way a citing doc's own fences are already excluded from short-form matching (see below): a comment line inside an example is never mistaken for a real heading, on either end of the enclosure check.
- **String form** (double-quoted, e.g. `#"reproduction requirement"`): the anchor text must occur, verbatim, on at least one line of the cited range itself -- "occurs inside it" rather than "encloses it", so this form also works against a non-Markdown target (`.ts`/`.js`/...) where "enclosing heading" has no meaning. The quoted text cannot cross a line break or a backtick: an unterminated opening quote (a typo) fails to parse as an anchor at all (the citation is then checked as if no anchor had been written, with no diagnostic) rather than greedily consuming the rest of the document up to some unrelated later quote character, which would otherwise silently hide every citation in between from this rule entirely.

Anchors are checked only once the base checks above (blank-start-line, closing-brace-start-line, inverted-range, range-exceeds-file) already came back clean for that citation. Anchors are full-citation-only: a continuation or a short-form citation never carries its own path, so there is nowhere natural to hang one on. The `#anchor` suffix is entirely optional and strictly additive: an existing anchorless citation matches and is checked exactly as it was before this feature existed.

**Anchor syntax note.** Any `#` immediately following a citation's range is read as the start of an anchor, with no other signal required -- there is no way to write a bare range immediately followed by an unrelated `#` and have it ignored. This means a Markdown link like `` [note](path:1-2#x) `` or an editor-style fragment such as `path:1-2#L7` is interpreted as an anchored citation (`x` and `L7` respectively), whether that was intended or not. The recommended, unambiguous form is the one used throughout this doc: the whole citation, range and anchor together, inside a single pair of backticks, e.g. `` `path:1-2#L7` ``.

**Known limitations.** The heading form's `heading.text.includes(anchor.text)` check is a plain substring match against the heading's raw text, not a token-boundary match: an anchor `0.1` matches a heading containing `[0.10.0]` (and, by the same construction, `[0.24.0]` "contains" `24.0`). This is a deliberate simplification, not implemented as token-boundary matching in this round; treat a heading-anchored citation as a strong drift signal, not a semantic guarantee, the same way the rest of this rule's checks are mechanical rather than semantic. Separately, the heading form runs `MD_HEADING_RE` (a bare `` `#{1,6}\s+...` `` match) against the target's raw lines regardless of the target's own file type, so a `# comment` line in a `.yml` or `.json` target is matched as if it were a Markdown heading; restricting the heading form to `.md` targets is left as a known limitation rather than implemented here. Both limitations stand as documented rather than implemented; both remain easy to tighten later without touching anchor syntax or backward compatibility.

**Heading-section citations.** `` `path:#heading` `` resolves to a whole Markdown section instead of a line range, so an edit anywhere above the cited section (e.g. inserting a new release at the top of a CHANGELOG) changes nothing about the citation -- see the doc comment above `HEADING_SECTION_CITATION_RE` in `src/rules/citations-resolve.ts` for the full rationale, including why the grammar requires the `:#` colon-hash and is restricted to `.md` targets. Grammar: `` `path:#heading` `` or, with an optional content anchor, `` `path:#heading#"text"` `` (always the quoted form). The heading text must match exactly one level 1 or 2 heading in the target (same containment check and same level cap as the line-range anchor's heading form above); the resolved section must be non-empty; the content anchor, when given, must occur on exactly one line inside that section. A malformed attempt (an unterminated or empty content-anchor quote, an unquoted third segment, or a non-`.md` target) is reported rather than silently dropped -- see `heading-section-malformed` in the table above. An unbalanced bracket in the heading position (`` `path:#[unclosed` ``) is not malformed by this definition: it parses as a heading named `[unclosed` and is reported as `heading-section-not-found`, the same way the line-range anchor form treats it. A bare `` `path#heading` `` without the colon is never a citation (it is the shape of an ordinary Markdown link target written in prose). See the rule table above for the exact finding names.

**Continuation citations.** Once a sentence states a full `path:N` citation, prose commonly repeats just the line (or range) for a later reference in the same sentence: `` `:N` ``/`` `:N-M` `` (bare colon-prefixed), `` -`M` ``/`` –`M` `` (hyphen- or en-dash-led, the tail of a split range like `` `path:N`-`M` ``), or `` (`N`) `` (parenthesized). Each resolves against the nearest preceding citation in the same doc that resolved to a real file; a continuation right after an unresolved, ambiguous, or out-of-scope citation is silently skipped, not misattributed to an earlier, unrelated file. A heading-section citation (see above) carries no line number and is never a continuation's target: it never sets or clears which citation a later continuation resolves against.

**Short-form citations.** Distinct from a continuation above: a *bare* (no backtick, no file name at all) colon-range `:N-M`, e.g. `:580-588` in running prose. A short-form citation binds to **the last full `path:N-M` citation named earlier in the same paragraph** -- not the nearest preceding citation anywhere in the doc (that is what a continuation does); a paragraph boundary is a blank (empty or whitespace-only) line. A short-form citation with no full citation earlier in its own paragraph is reported `short-form-unbound`, not silently skipped. Only a range is recognised, never a bare single number (`:5`): a bare number is too easily an unrelated enumeration marker (e.g. a numbered list item) to detect mechanically without a large false-positive cost. A resolved short-form citation gets every check a full citation gets, plus the test-file/Markdown block-boundary check above (`test-range-*` / `markdown-range-boundary-bracket-or-fence`).

**Serial-connective gate, and why the paren form is not collected at all.** Three earlier rounds each tried to separate a real short-form citation from ordinary prose that merely contains an N-M-shaped number pair ("the window (2026-2027)", "follow steps (2-4)", "three engineers (1-3)") by deciding from the range's *values*: an inverted-pair check, a span cap plus a year/well-known-port plausibility gate, then a containment-or-adjacency check against the paragraph's last full citation. All three were eventually defeated by the same class of false positive, because every real paren-form citation this rule was ever built against has the identical shape `<English word> (N-M)` as ordinary prose -- there is no lexical signal that tells them apart. The bare parenthesized form `(N-M)` is therefore not collected as a short-form citation candidate at all; measured against this repo's own dogfood bundle, dropping it changed nothing (39 findings / 17 warnings / 22 notices, identical with and without it).

The colon form does not have this problem, but still needs a gate: a candidate `:N-M` is collected only when the nearest preceding non-whitespace text, after trimming whitespace, is one of `,`, `;`, `(`, or ends in the word `and`/`or` -- the shape a short-form citation takes in a serial list of sub-ranges ("the `TODO` cells, :72-74 (the ...), and :92-97 (the ...)", "review finding L1 (:1170-1227, ...)"). This is a measured, not a guessed, gate: see the CHANGELOG for the corpus sample it was calibrated against. The comma is load-bearing, not just `(` and `and`; do not narrow the gate to those two. A candidate the gate rejects is dropped before any paragraph-binding is attempted -- it is not a citation, and produces nothing at all, not even `short-form-unbound`.

**Documented residual (not fixed).** A prose shape where the serial connective happens to precede a bare range that is still not a real citation -- e.g. "the exposed ports, :80-443, stayed open" -- still binds to the paragraph's last full citation and can produce a false warning. This was not observed anywhere in the corpus this gate was calibrated against (see the CHANGELOG); it is a known, accepted limitation of a mechanical (non-semantic) gate rather than something this round attempted to close.

**Excluded from short-form matching entirely** (not collected, regardless of the serial-connective gate): a match inside a fenced code block, an indented code block, an inline code span (`` `like this` ``), or a Markdown table row -- a bare numeric range in any of these is virtually never a citation. Also excluded: reserved files (`index.md`, `log.md`), which are append-only narrative journals that routinely narrate historical "old :N-M -> new :X-Y" line-number deltas as prose about the past, not live citations against current content; full/continuation citations in reserved files are still checked as normal. This carve-out has a known cost: it also leaves genuine short-form citations in those files completely unchecked (see the CHANGELOG for the current dogfood bundle's gap).

**Markdown fence-opening exception.** A range boundary landing on a bare bracket line is always a drift signal. A bare code-fence delimiter (```` ``` ```` or `~~~`) at the range's END is also always a drift signal, but at the range's START it is exempted when that line is a genuine *opening* fence (determined by replaying the doc's own fence open/close state from the top, not by the line's text alone, since an untagged opening fence and a closing fence are lexically identical): citing a fenced code block starting at its own opening delimiter is the natural, correct way to cite it, not drift.

**Hard-wrapped prose.** A doc that hard-wraps prose at a fixed column can split a hyphenated filename across a line break right after its trailing `-` (e.g. `run-state-lifecycle-and-markers.md` wrapping to `run-state-lifecycle-and-\nmarkers.md`). A `` `path:N` `` match is skipped entirely (not checked, not counted as a citation) when it starts at column 0 of its line -- optionally after only whitespace or a list/quote marker (`-`, `*`, `>`, digits, `.`) -- and the previous line ends with `-`/`–`: the signature of a wrapped continuation rather than a genuine citation to a short bare filename.

**Path resolution**, tried in order: (1) the doc's own frontmatter `sources` list, matched by exact suffix, only when exactly one source matches; (2) for a citedPath with no `/` only, doc-relative and then each ancestor directory of the doc up to the repo root, nearest first (so a bare filename like `README.md` prefers the README *for the package the doc lives in* over a same-named file that merely happens to also sit at the repo root); (3) repo-root-relative; (4) doc-relative; (5) the nearest earlier citation in the same doc whose path contains a `/` and ends with the same suffix (the "full path was mentioned earlier" convention); (6) a repo-wide search by basename. A cited path starting with `/` is treated as an absolute or placeholder path (e.g. inside a fabricated example stack trace) and skipped without a finding.

Like `sources-fresh`, this rule requires a repo root (explicit `--repo-root` or auto-detected): without one, it emits a single bundle-level notice (`citation resolution skipped: not inside a git work tree`) rather than silently reporting nothing.

### Anchor strictness (opt-in, `--require-anchors`)

Everything above is on by default. `--require-anchors` opts into four additional, stricter checks against `citations-resolve`, all `warning`-severity, off unless the flag is passed -- an existing bundle's findings under a plain `check` are byte-for-byte unaffected by this section existing. `--require-anchors` (and its sibling `--require-anchors-allow`) is a CLI flag only; okf-kit has no bundle-level config file today (no `.okf.yml`, no `okf-kit.config`, no frontmatter field), so there is no other way to turn this on. All four checks are also exempt for a citing doc that is a reserved file (`index.md`, `log.md`), the same carve-out `citations-resolve` already gives reserved docs for short-form matching elsewhere in this doc -- a reserved doc's citations still get the unconditional base checks (`missing-file`, `inverted-range`, `anchor-not-found-in-range`, and so on), just none of the four opt-in ones:

- **`anchor-required`.** An in-repo full citation (resolved to a real target -- an unresolved one already gets its own `missing-file`/`unresolved-ambiguous` finding, not this one) carrying no `#anchor` at all is flagged. Also exempt (beyond the reserved-doc carve-out above): a citedPath matching one of `--require-anchors-allow`'s patterns (repeatable/space-separated, exact string or a `*`/`?` glob against the citation's raw, as-written path text), for a doc category not meant to be anchor-checked, e.g. `--require-anchors-allow README.md INSTALL-AGENT.md`. A target cited under several different spellings in the same bundle (`init.ts` in one paragraph, `src/init.ts` in another) needs one allow pattern per spelling, or a `*basename` glob that covers all of them -- the match is against the citation's own raw text, not the path it resolves to. `--require-anchors-allow` is commander-variadic: pass it either right after the bundle path or as the last flag on the command line; putting another flag directly after it without a `--` separator gets swallowed as another allow pattern instead of being parsed as that flag.
- **`anchor-not-on-last-line`.** A string-anchored citation (`` `path:N-M#"text"` ``) whose anchor text was found in the cited range, but not on the range's own last CONTENT line. A content line is any line whose trimmed text is not empty and not composed only of closing brackets/braces/parens plus an optional trailing `,`/`;` (`}`, `});`, `]);`, `}),`, and similar); a range ending on one or more such boilerplate lines (the common shape of a `});` that closes a whole cited block) resolves to the real content line before them instead. An anchor sitting on the range's first line survives a small insertion above the range (the shifted window still contains the anchor's original content, just at a different offset); anchoring on the last content line closes that, since the original last content line falls out of the shifted window on any insertion at all.
- **`anchor-not-unique-in-range`.** A string-anchored citation whose anchor text occurs on more than one line of the cited range -- ambiguous evidence for which occurrence is the one actually pinning the citation. A count of zero is unaffected (already `anchor-not-found-in-range`, unconditionally).
- **`test-range-straddles-block`.** A FULL citation's own range into a `.test.`/`.spec.` target (`.ts`, `.js`, `.mjs`) must stay inside the single `describe`/`it`/`test` block (including `.only`/`.skip`/`.each` variants) it started in: a block-head line at the same or a shallower indent than the range's own start line, found on any line of the range OTHER than that start line, means the citation straddled out into a sibling or outer block. A block-head line indented STRICTLY DEEPER than the start line is a nested block (e.g. every `it(` inside a `describe(` the range cites in full) and is not a straddle -- citing a whole block is expected to contain every head line nested inside it. The start line itself is never checked here -- it is either a legitimate block head (the range correctly starts a block) or legitimately inside a block's body (a deliberate partial citation), and both are fine. Deliberately scoped to test-file targets only, and to this same opt-in: a full citation into a Markdown target legitimately cites a couple of arbitrary lines all the time (the same reasoning that keeps the Markdown half of `test-range-start-not-head`/`test-range-end-not-closing` scoped to short-form citations only, see above), and turning this on unconditionally for every existing full citation would silently regress an already-green bundle for every consumer, not just one that opted in.

`--require-anchors` is off by default and, once on, surfaces a real backlog the first time it is run against an existing, unaudited bundle -- the same posture `blank-start-line` already documents for `citations-resolve` itself. `anchor-required` in particular is only useful once a bundle's citations have actually been anchored; running it against a bundle that predates anchoring will flag most of that bundle's full citations.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No errors (and, under `--strict`, no warnings either). |
| 1 | At least one error (or, under `--strict`, at least one warning). |
| 2 | CLI invocation error: bundle directory does not exist, `init`'s target directory is non-empty without `--force`, or a commander usage error (unknown option, missing argument, missing/unknown command). `--help` and `--version` still exit 0. |

## CI usage

This is advisory: don't fail the build on warnings unless you pass `--strict`. Use a normal (non-shallow) checkout of the repo that owns the bundle: repo-root detection runs `git rev-parse --show-toplevel` from the `path/to/bundle` argument itself, not from the shell's working directory, and `sources-fresh` reads `git log`, so a shallow clone reports paths as untracked.

```yaml
- name: OKF bundle check
  run: npx okf-kit@0.7.0 check path/to/bundle
```

Pin the version: an unpinned `npx okf-kit` picks up new rules on their release day, which turns an unrelated PR red.

## Where this fits

okf-kit is the producer-side check: it validates a bundle you are authoring or maintaining. Consuming an OKF bundle at query time (loading, indexing, ranking passages for an agent) lives in [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle), a separate tool.

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
