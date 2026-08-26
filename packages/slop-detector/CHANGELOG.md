# Changelog

All notable changes to `slop-detector` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `placement.instructionGlobs` in the agent-dx root `slop.config.yml` now
  also covers every package README (`packages/*/README.md`), closing a
  gap the `placement-guard` CI job (`check . --pack placement-slop
  --config slop.config.yml`) had against that location kind (agent-tasks
  80e4743d, itself filed from two independent mutation-probe findings in
  agent-tasks batch27: an implementer inserted a dated/tallied evidence
  line into `okf-kit/README.md` and a reviewer repeated the same probe
  across five locations, in both cases with the guard staying clean). The
  repo-root `README.md` is deliberately not covered: it is the monorepo
  overview, not a single package's own doc.
  - The wildcard immediately surfaced 50 pre-existing violations across 6
    files. Each was resolved, not deferred:
    - **home-path, `~/` idiom (45 findings, allowed):** `placement.allow`
      gained a `"~/"` entry. A bare `~/` is portable by construction
      (unlike `/Users/<name>/` or `/home/<name>/`, it never bakes in a
      literal username), so it carries no machine-bound information to
      leak; package READMEs use it constantly as the generic "your home
      directory" idiom in install/usage examples
      (`mcp-token-audit/README.md`, `git-batch-cli/README.md`,
      `friction-log/README.md`, `orchestrator-workflow/README.md`,
      `slop-detector/README.md`). The allow pattern is deliberately
      narrow (the two literal characters `~/`, nothing else), so
      `/Users/<realname>/` and `/home/<realname>/` still fire; verified
      by a mutation probe (inserting `/Users/lannguyensi/git/pandora`
      into a covered README still BLOCKs). `placement.allow` also gained
      a second, equally narrow entry, `"/Users/you/"`, for
      `friction-log/README.md`'s `sync_export` example, which spells the
      same generic placeholder as the literal word "you" instead of an
      angle-bracket placeholder.
    - **org-marker, real example values (9 findings, fixed):**
      `github-api-tool/README.md` (5 occurrences) and
      `friction-log/README.md` (3 occurrences: a `repo:` example, a
      `projectId:` example, and a "zero LanNguyenSi-stack assumptions"
      sentence) used the real `LanNguyenSi` org handle, a real project
      id, and a real repo slug as CLI/config example values. Replaced
      with generic placeholders (`your-org`, `your-org/your-repo`, an
      all-zero UUID, "org-specific-stack"); no information is lost, since
      the specific org/project identity was never load-bearing in an
      example.
    - **dated-evidence, real measurement (1 finding, fixed):**
      `orchestrator-workflow/README.md` stated a wire-probe result
      ("A wire probe on 2026-08-19 (not re-measured for this doc) showed
      the Claude Code CLI silently drops the `effort:` parameter for
      Haiku 4.5..."). Reworded to state the durable rule only (Haiku 4.5
      drops the `effort:` frontmatter parameter rather than rejecting
      it), with the dated wire-probe detail moved to
      `packages/orchestrator-workflow/CHANGELOG.md`'s `[Unreleased]`
      section.
    - **slop-detector/README.md's own self-documenting rule examples (13
      findings, allowed via disable comments):** the package's own
      "`placement-slop` by example" section deliberately contains
      evidence-shaped lines (a home path, a dated tally, an opaque id, a
      table row listing `n=8`/`p=0.016`/`so far` as sample tokens, a
      prose mention of `/home/node/app`, and a dogfood anecdote naming
      the org) to demonstrate what each rule catches. These are
      documentation, not leaked evidence, and rewriting them would defeat
      their purpose as examples. Marked with `<!--
      slop-detector:disable-line=placement-slop -->` on each of the 6
      affected physical lines (11, 60, 127, 128, 132, 141), the pack's
      existing per-line opt-out mechanism, which is file- and
      line-scoped (unlike a config-level `allow` regex, it cannot mask a
      finding in any other file).
  - Corpus re-measured clean after the above: `check .` at the repo root
    stays green, 390 files scanned, 0 violations.
- OKF bundle docs (`packages/*/docs/okf/**`) are deliberately **not**
  covered by `placement.instructionGlobs` at all, for the whole bundle
  consistently. Measured: a `packages/*/docs/okf/*.md` wildcard on the
  orchestrator-workflow bundle surfaces 14 pre-existing violations across
  5 of its 6 module docs (`index.md`, `model-preselection.md`,
  `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
  `subagent-contracts-superset.md`) plus 72 in `log.md` alone. These docs
  carry verification stamps, tallies, and task ids by design: okf-kit's
  sources-fresh / re-verify convention re-stamps them with exactly this
  kind of dated evidence on every verification pass, and the bundle
  already has its own mechanical freshness guard (`okf-kit check` in CI).
  `log.md` is the bundle's own append-only log, the same reason
  `CHANGELOG.md` is never in `instructionGlobs`. Editing bundle document
  content to satisfy a second, unrelated guard would fight the tool that
  already owns that content's shape.
- `CHANGELOG.md` files anywhere in the repo: unchanged, still never
  matched by any `instructionGlobs` entry (verified: a new entry in this
  very file, carrying a date, a tally, and an agent-tasks task id, stays
  green under `check .`). This is the pack's existing, intentional
  carve-out for evidence that is supposed to live somewhere, and this
  change does not touch it.
