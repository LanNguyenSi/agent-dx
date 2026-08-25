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

### Authoring guidance baked into the templates

- **`timestamp` means "last verified against sources," not "created on."** Bump it, and add a line to `log.md`, every time you re-verify a doc against its sources. Always use the real instant of verification (`new Date().toISOString()` or equivalent); never hand-write an artificial midnight datetime, `sources-fresh` staleness comparisons depend on it being real.
- **Never list the bundle's own directory in `sources`.** A bundle directory changes on every doc edit inside it, so a self-referential `sources` entry goes permanently stale. This happened to the OKF pilot's own `BENCHMARK.md` (`agent-tasks` `docs/okf/BENCHMARK.md`, `sources: [docs/okf/]`); `benchmark-template.md` here omits `sources` entirely for the same reason, since a benchmark record measures the bundle rather than describing a piece of the codebase.
- **Keep all links same-directory relative.** Use `name.md`, not `/name.md`; see `no-absolute-links` above for why a leading slash breaks once the bundle is viewed outside its own repository.

## Check catalog

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. A relative target that climbs out of the bundle directory (`../outside.md`) and still resolves on disk is accepted; the rule checks resolution, not containment. |
| `no-absolute-links` | warning | Link targets should not start with `/`. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources`, when present, must be a non-empty array of non-empty strings. With a repo root (explicit or auto-detected), each listed path (file or directory) must also exist under it. |
| `sources-fresh` | warning / notice | For docs with a `sources` list and a repo root, flags a source path whose last git commit is newer than both the doc's `timestamp` and the doc file's own last commit. See "Staleness (sources-fresh)" below. |
| `citations-resolve` | warning / notice | For docs with a repo root, flags a `` `path:N`/`path:N-M` `` citation (and its `` `:N` ``/`` -`M` ``/`` (`N`) `` continuations, and bare paragraph-bound short forms `:N-M`/`(N-M)`) whose target file is missing, whose range is inverted or exceeds the file, or whose start line is blank or (for a non-markdown target) only a closing brace. A short-form citation's range into a test file is also checked for a describe/it block boundary. See "Citation resolution (citations-resolve)" below. |

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

**Continuation citations.** Once a sentence states a full `path:N` citation, prose commonly repeats just the line (or range) for a later reference in the same sentence: `` `:N` ``/`` `:N-M` `` (bare colon-prefixed), `` -`M` ``/`` –`M` `` (hyphen- or en-dash-led, the tail of a split range like `` `path:N`-`M` ``), or `` (`N`) `` (parenthesized). Each resolves against the nearest preceding citation in the same doc that resolved to a real file; a continuation right after an unresolved, ambiguous, or out-of-scope citation is silently skipped, not misattributed to an earlier, unrelated file.

**Short-form citations.** Distinct from a continuation above: a *bare* (no backtick, no file name at all) colon-range `:N-M`, e.g. `:580-588` in running prose. A short-form citation binds to **the last full `path:N-M` citation named earlier in the same paragraph** -- not the nearest preceding citation anywhere in the doc (that is what a continuation does); a paragraph boundary is a blank (empty or whitespace-only) line. A short-form citation with no full citation earlier in its own paragraph is reported `short-form-unbound`, not silently skipped. Only a range is recognised, never a bare single number (`:5`): a bare number is too easily an unrelated enumeration marker (e.g. a numbered list item) to detect mechanically without a large false-positive cost. A resolved short-form citation gets every check a full citation gets, plus the test-file/Markdown block-boundary check above (`test-range-*` / `markdown-range-boundary-bracket-or-fence`).

**Serial-connective gate, and why the paren form is not collected at all.** Three earlier rounds each tried to separate a real short-form citation from ordinary prose that merely contains an N-M-shaped number pair ("the window (2026-2027)", "follow steps (2-4)", "three engineers (1-3)") by deciding from the range's *values*: an inverted-pair check, a span cap plus a year/well-known-port plausibility gate, then a containment-or-adjacency check against the paragraph's last full citation. All three were eventually defeated by the same class of false positive, because every real paren-form citation this rule was ever built against has the identical shape `<English word> (N-M)` as ordinary prose -- there is no lexical signal that tells them apart. The bare parenthesized form `(N-M)` is therefore not collected as a short-form citation candidate at all; measured against this repo's own dogfood bundle, dropping it changed nothing (39 findings / 17 warnings / 22 notices, identical with and without it).

The colon form does not have this problem, but still needs a gate: a candidate `:N-M` is collected only when the nearest preceding non-whitespace text, after trimming whitespace, is one of `,`, `;`, `(`, or ends in the word `and`/`or` -- the shape a short-form citation takes in a serial list of sub-ranges ("the `TODO` cells, :72-74 (the ...), and :92-97 (the ...)", "review finding L1 (:1170-1227, ...)"). This is a measured, not a guessed, gate: see the CHANGELOG for the corpus sample it was calibrated against. The comma is load-bearing, not just `(` and `and`; do not narrow the gate to those two. A candidate the gate rejects is dropped before any paragraph-binding is attempted -- it is not a citation, and produces nothing at all, not even `short-form-unbound`.

**Documented residual (not fixed).** A prose shape where the serial connective happens to precede a bare range that is still not a real citation -- e.g. "the exposed ports, :80-443, stayed open" -- still binds to the paragraph's last full citation and can produce a false warning. This was not observed anywhere in the corpus this gate was calibrated against (see the CHANGELOG); it is a known, accepted limitation of a mechanical (non-semantic) gate rather than something this round attempted to close.

**Excluded from short-form matching entirely** (not collected, regardless of the serial-connective gate): a match inside a fenced code block, an indented code block, an inline code span (`` `like this` ``), or a Markdown table row -- a bare numeric range in any of these is virtually never a citation. Also excluded: reserved files (`index.md`, `log.md`), which are append-only narrative journals that routinely narrate historical "old :N-M -> new :X-Y" line-number deltas as prose about the past, not live citations against current content; full/continuation citations in reserved files are still checked as normal. This carve-out has a known cost: it also leaves genuine short-form citations in those files completely unchecked (see the CHANGELOG for the current dogfood bundle's gap).

**Markdown fence-opening exception.** A range boundary landing on a bare bracket line is always a drift signal. A bare code-fence delimiter (```` ``` ```` or `~~~`) at the range's END is also always a drift signal, but at the range's START it is exempted when that line is a genuine *opening* fence (determined by replaying the doc's own fence open/close state from the top, not by the line's text alone, since an untagged opening fence and a closing fence are lexically identical): citing a fenced code block starting at its own opening delimiter is the natural, correct way to cite it, not drift.

**Hard-wrapped prose.** A doc that hard-wraps prose at a fixed column can split a hyphenated filename across a line break right after its trailing `-` (e.g. `run-state-lifecycle-and-markers.md` wrapping to `run-state-lifecycle-and-\nmarkers.md`). A `` `path:N` `` match is skipped entirely (not checked, not counted as a citation) when it starts at column 0 of its line -- optionally after only whitespace or a list/quote marker (`-`, `*`, `>`, digits, `.`) -- and the previous line ends with `-`/`–`: the signature of a wrapped continuation rather than a genuine citation to a short bare filename.

**Path resolution**, tried in order: (1) the doc's own frontmatter `sources` list, matched by exact suffix, only when exactly one source matches; (2) for a citedPath with no `/` only, doc-relative and then each ancestor directory of the doc up to the repo root, nearest first (so a bare filename like `README.md` prefers the README *for the package the doc lives in* over a same-named file that merely happens to also sit at the repo root); (3) repo-root-relative; (4) doc-relative; (5) the nearest earlier citation in the same doc whose path contains a `/` and ends with the same suffix (the "full path was mentioned earlier" convention); (6) a repo-wide search by basename. A cited path starting with `/` is treated as an absolute or placeholder path (e.g. inside a fabricated example stack trace) and skipped without a finding.

Like `sources-fresh`, this rule requires a repo root (explicit `--repo-root` or auto-detected): without one, it emits a single bundle-level notice (`citation resolution skipped: not inside a git work tree`) rather than silently reporting nothing.

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
  run: npx okf-kit@0.5.0 check path/to/bundle
```

Pin the version: an unpinned `npx okf-kit` picks up new rules on their release day, which turns an unrelated PR red.

## Where this fits

okf-kit is the producer-side check: it validates a bundle you are authoring or maintaining. Consuming an OKF bundle at query time (loading, indexing, ranking passages for an agent) lives in [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle), a separate tool.

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
