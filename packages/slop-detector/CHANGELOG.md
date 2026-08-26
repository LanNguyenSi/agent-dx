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
  - The wildcard immediately surfaced 50 pre-existing findings across 6
    files, by rule: `home-path` 30 (27 bare `~/`, 2 `/Users/you/`, 1
    `/home/node/`), `tally-phrase` 8, `org-marker` 8, `dated-evidence` 2,
    `opaque-id` 2. Every one was resolved, not deferred, by one of three
    mechanisms:
    - **`placement.allow` (28 findings):** a new narrow entry for the
      literal two characters `~/` and one for the literal string
      `/Users/you/`. A bare `~/` is portable by construction (unlike
      `/Users/<name>/` or `/home/<name>/`, it never bakes in a literal
      username), so it carries no machine-bound information to leak;
      package READMEs use it constantly as the generic "your home
      directory" idiom in install/usage examples
      (`mcp-token-audit/README.md`, `git-batch-cli/README.md`,
      `friction-log/README.md`). `/Users/you/` is the same idiom spelled
      as a literal placeholder word instead of an angle-bracket one
      (`friction-log/README.md`'s `sync_export` example). Both entries
      are deliberately narrow (exact literal matches, no wildcards), so
      `/Users/<realname>/` and `/home/<realname>/` still fire; verified
      by two mutation probes: inserting `/Users/lannguyensi/git/pandora`
      into a covered README still BLOCKs, and `placement.markers` gained
      a lowercase `"lannguyensi"` entry (marker matching has no implicit
      `i` flag, and this org's own machine-path convention, e.g.
      `-Users-lannguyensi-git-pandora`, writes the handle lowercase)
      after a probe showed `~/.claude/projects/-Users-lannguyensi-git-pandora/`
      and `~/../lannguyensi/...` passing silently through the `~/`
      allow; both now fire as `org-marker` after the new marker. A third
      probe line, `~/git/pandora` (no username at all), still passes:
      this is a known, accepted limitation of the `~/` allow, not a gap
      to close, since there is no username in it to catch.
    - **`slop-detector:disable-line` / `disable-next-line` (12
      findings):** `slop-detector/README.md`'s own "`placement-slop` by
      example" section deliberately contains evidence-shaped lines (a
      home path, a dated tally, an opaque id, a table row listing
      `n=8`/`p=0.016`/`so far` as sample tokens, and a prose mention of
      `/home/node/app`) to demonstrate what each rule catches; rewriting
      them would defeat their purpose as examples. The fenced sample
      lines themselves stay pristine (no inline comment on the evidence
      text); the marker comment immediately above each carries a
      `slop-detector:disable-next-line=placement-slop` instead. The
      table row and the prose paragraph (not inside the fenced sample)
      keep an inline `disable-line` comment. This mechanism is
      file/line-scoped, unlike a config-level `allow` regex, so it
      cannot mask a finding anywhere else.
    - **Content edits (10 findings):** real example values with nothing
      to preserve, replaced with generic placeholders:
      `github-api-tool/README.md` (5 `org-marker` occurrences, a real
      org handle in CLI examples, now `your-org`, and the repo-name
      example next to it now reads `repo-a repo-b` for the same reason);
      `friction-log/README.md` (2 `org-marker` occurrences, a `repo:`
      YAML example and a "zero `<org>`-stack assumptions" sentence, plus
      1 `opaque-id`, a `projectId:` YAML example, now generic
      placeholders); `slop-detector/README.md`'s own dogfood anecdote (1
      `org-marker`, a real org handle naming this org's PR sample, now
      genericized with the specific counts moved into this entry: the
      first real run found real violations, mostly em-dashes and
      auto-appended agent-harness footers, across a majority of the
      sampled PRs, zero false positives). One real measurement,
      `orchestrator-workflow/README.md`'s Haiku 4.5 `effort:`-drop claim
      (1 `dated-evidence`), was reworded to the durable rule with the
      dated wire-probe measurement anchored to that package's own
      CHANGELOG (`0.23.0`, which already recorded the same underlying
      fact from an unrelated A/B write-up) rather than duplicated into a
      new entry there, since inserting a new `[Unreleased]` entry above
      versioned sections shifts every citation into that CHANGELOG by
      line count and would have re-broken 16 already-fixed anchored
      citations in the OW OKF bundle.
  - `placement-slop/README.md` also gained a short recommendation (rule
    only, no counts, no task ids) pointing a monorepo at
    `packages/*/README.md` as a `placement.instructionGlobs` value, and
    dropped the now-inaccurate "the same content in README.md never
    fires" line in favor of describing the built-in defaults plus how a
    repo can widen them.
  - Corpus re-measured clean after all of the above: `check .` at the
    repo root stays green, 390 files scanned, 0 violations. Confirmed by
    toggling each mechanism independently: with the two `~/`/`/Users/you/`
    allow entries removed (disable comments and edits left in place),
    exactly 28 findings reappear; with every disable comment stripped
    (allow entries and edits left in place), exactly 12 findings
    reappear in `slop-detector/README.md`; 28 + 12 + 10 = 50.
- `packages/slop-detector/package.json`'s `files` array now includes
  `CHANGELOG.md`, so it ships with the published package alongside
  `README.md`.
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
  already has its own mechanical freshness guard (`okf-kit check` in
  CI). `log.md` is the bundle's own append-only log, the same reason
  `CHANGELOG.md` is never in `instructionGlobs`. Editing bundle document
  content to satisfy a second, unrelated guard would fight the tool that
  already owns that content's shape. This change did touch two of the
  bundle's own listed *sources* (`orchestrator-workflow/README.md` and,
  transiently, `orchestrator-workflow/CHANGELOG.md`), which is not the
  same thing as touching the bundle documents themselves: the five
  module docs that list either file as a `sources:` entry
  (`install-fence-mechanics.md`, `model-preselection.md`,
  `run-state-lifecycle-and-markers.md`, `review-gate-and-waivers.md`,
  `subagent-contracts-superset.md`) were re-verified against the new
  README wording (no citation range or anchor targets the edited
  paragraph; the edit kept the same line count so no other citation into
  that file shifted either) and re-stamped per the bundle's own
  `timestamp:` frontmatter convention. `okf-kit check --json
  packages/orchestrator-workflow/docs/okf --repo-root .` reports the
  same 13 `citations-resolve` warnings and 22 notices as origin/master,
  and 0 `sources-fresh` warnings after the re-stamp (6 before it).
- `CHANGELOG.md` files anywhere in the repo: unchanged, still never
  matched by any `instructionGlobs` entry (verified: this very entry,
  carrying a date, a tally, and an agent-tasks task id, stays green under
  `check .`). This is the pack's existing, intentional carve-out for
  evidence that is supposed to live somewhere, and this change does not
  touch it.
