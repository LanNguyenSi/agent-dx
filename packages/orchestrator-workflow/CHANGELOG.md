# Changelog

All notable changes to `orchestrator-workflow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- After independent review, a narrowly scoped docs-only closing delta may be
  accepted without another reviewer round when the entire unreviewed delta is limited
  to explanatory documentation, comments, or citations. Source/test edits and
  semantic changes to executable commands, configuration, policy,
  instructions, or behavior remain ineligible; the option applies only to
  low/medium documentation or maintainability findings, never high/critical
  or other ineligible findings. The recorded `05-review-findings.md` row
  preserves its Severity/Decision headers and records Decision `accepted`.
  Anchored by the analysis in
  `lava-ice-logs/2026-09-05/ow-kit-effort-analysis.md` section 7(iii).

- Task-slicing guidance now requires briefs to enumerate every file and doc
  site that references an identifier, config value, build context, or
  documented command the task will change, using annotated `relevant_files`
  and `relevant_docs` entries for sites outside the edit set. Anchored by
  thin n=3 evidence in
  `lava-ice-logs/2026-09-05/ow-kit-effort-analysis.md` sections 5(b) and
  7(v).

- On any round after a task's first, the orchestrator's briefing names
  every mutation probe named in an earlier round of this task, and the
  implementer replays each one, not only the round's new probes, before
  the next reviewer spawn, reporting each replayed probe in
  `mutation_probes` with a new `replayed` sub-field. A replayed probe
  whose mutant now survives or can no longer be applied is a regression
  signal, reported as such and resolved before the next reviewer spawn.
  `04-implementation-summary.md` gained a Mutation Probes subsection
  under Test Evidence to hold this evidence across rounds. The
  orchestrator's reviewer briefing names the replayed probes the
  implementer reports as killed, together with their `mutant` and
  `verified_applied_via` values, so the reviewer may skip re-running
  those; the reviewer output contract is unchanged. Anchored by the
  analysis in `lava-ice-logs/2026-09-05/ow-kit-effort-analysis.md`
  section 7(ii).

- The installed implementer and reviewer prompts now carry a checklist item
  for any diff that adds or changes a GitHub Actions `run:` step: replay it
  locally under the shell the step actually runs (`bash --noprofile --norc
  -eo pipefail` when `shell: bash` is set on the step or via
  `defaults.run.shell`, `bash -e` otherwise on Linux and macOS runners;
  Windows runners default to pwsh) before treating it as tested, with the
  expected-success and the expected-failure inputs, replaying a job's steps
  in their committed order, and guarding a step that expects a non-zero
  command inside an `if` or a `set +e`/`set -e` block. The reviewer replays
  in a scratch copy outside the reviewed working tree, keeping the replay
  compatible with its read-only Bash rule. The reviewer's `reproduction`
  field now names this replay as a second, explicitly non-probabilistic
  trigger alongside empirical/probabilistic evidence, with `sample_size:
  not_applicable` allowed. SKILL.md points to the installed implementer
  prompt for the rule. Anchored by the analysis in
  `lava-ice-logs/2026-09-05/ow-kit-effort-analysis.md` section 7(vi).

## [0.29.0] - 2026-09-05

### Added

- Native Codex custom agents under `.codex/agents/`, including profile-scoped
  roles and optional effort-tier variants with explicit model and effort.
  The initial routing uses Astra for review/advice and implementation
  escalation, Sol for discovery/slicing, Terra for regular implementation,
  and Luna for narrowly scoped low-tier work.
- Harness-specific role/tier routing overrides through `--routing <file>`
  on `init`, `setup`, and `apply`, persisted alongside the legacy `models`
  configuration. Optional `--codex-catalog <file>` checks selected Codex
  model/effort pairs against a supplied catalog before installation writes.

### Changed

- Agent-led installation and deliberate model refresh are the recommended
  entry point. The agent inspects capabilities and existing preferences,
  applies authorized scoped changes through the CLI, and reports verification
  gaps. The CLI remains available as the reproducible installation backend.
- Codex workflow guidance uses native role delegation when supported, with an
  explicit inline fallback for environments without native subagents. Normal
  reinstallation preserves recorded routing; model changes use explicit
  overrides or documented operator synchronization.


## [0.28.0] - 2026-09-04

### Added

- The explorer, reviewer, and implementer prompts, and `SKILL.md`'s
  Discover step, each gained one tool-agnostic sentence pointing the role
  at a connected structural code-search, verify, or mutation-probe runner
  when one is available in the session, in place of raw grep, hand-editing
  probe files, or reading full logs. Anchored by a pandora-workspace
  measurement of subagent tool-call patterns (see run
  `.ai/runs/2026-09-03-agent-tools-kit`).

### Changed

- `init`'s interactive harnesses prompt on a target whose own manifest
  recorded a real `harnesses: []` (a deliberate `--harness none`
  templates-only install) now starts with nothing pre-checked, matching
  `apply`'s existing semantics, instead of pre-checking whatever
  `detectHarnesses(targetDir)` found on disk. Decision D-002 (agent-dx
  7669907c): the weak-signal argument that motivated `apply`'s own fix
  (agent-tasks fe834823, a stray harness config left on disk, e.g. a
  `.claude/` directory, is not the recorded intent, the manifest is)
  applies to `init` identically, and the earlier fix's concern (ask
  instead of silently falling back to templates-only) is preserved
  because the prompt still appears and still annotates detection with a
  " (detected)" label; only the pre-check now follows recorded intent
  instead of on-disk detection. `init` and `apply` now share one
  resolution inside `resolveInitInputs` (`stickyPreChecked ?? []`,
  `stickyAnnotateDetected ?? detected`) instead of `init`'s own call site
  relying on a different default.

## [0.27.0] - 2026-09-01

### Added

- The implementer output contract gained a `commits` field: a YAML list of
  the full commit shas produced on the task branch, in order, `commits: []`
  when the task produced no commit. A contract field is checked by the
  subagent misfire rule; a prose ask in the brief is not, so implementers
  kept omitting the commit sha and the orchestrator had to re-derive it
  from git. The misfire rule now also treats an omitted `commits` field, on
  a task assignment that asked for a commit, as a misfire.

### Fixed

- Interactive `apply` on a target whose own manifest recorded a real
  `harnesses: []` (a deliberate `--harness none` templates-only install)
  now starts its harnesses checkbox with nothing pre-checked at all:
  previously the prompt pre-checked whatever `apply`'s harness fallback
  chain (the target's recorded harnesses, else the operator manifest's
  defaults, else detection, else `claude`) resolved to, which is never
  empty, so a bare Enter silently re-widened a deliberately
  templates-only install. The prompt now pre-checks nothing on this path
  regardless of what is on disk; selecting a harness in the prompt still
  adds it, same as before. The checkbox still shows the " (detected)"
  label on a harness that already has files on disk, so the operator can
  still see it before deciding.
- `apply` now keeps a target whose own manifest recorded a real
  `harnesses: []` (a deliberate `--harness none` templates-only install)
  templates-only on a flagless, non-interactive re-run, matching `init`'s
  existing behavior: previously, `apply` never passed
  `previousIsRecordedManifest` to `resolveInitInputs`, so the
  harnesses-stickiness gate that already protected `init` never fired for
  `apply`, and a flagless `apply` could silently widen a templates-only
  target back out to the operator's default harness or whatever
  `detectHarnesses` found on disk. `apply` now sets
  `previousIsRecordedManifest` from whether the target actually has its own
  repo manifest, and `buildApplyPrevious` carries that manifest's
  `harnessesRecordedEmpty` straight through into the synthetic `previous`
  it hands `resolveInitInputs`. An explicit `apply --harness <list>` still
  overrides, the same as it always could, and a target whose `harnesses`
  field is missing or malformed (not a real recorded empty set) still falls
  through to the existing fallback chain unchanged. Interactive `apply` is
  unaffected in intent: it still prompts (agent-tasks 8602a952).

## [0.26.0] - 2026-08-30

### Added

- The orchestrator now writes a per-worktree run pointer, `.ai/run`: a plain
  text file whose first non-empty line is the absolute path of the run
  directory, one written in every repository or worktree a run touches
  (`SKILL.md` Run state, step 1, and all three Harness notes bullets;
  `agents-md-section.md` Run state gained the matching bullet). For a run
  spanning more than one repository, `00-goal.md` now also carries one keyed
  `run-base[<repo-basename>]` marker per repository alongside the existing
  unkeyed one, exact form `<!-- solution-acceptance: run-base[<repo-basename>]
  = <sha> -->`; the shipped template line uses the placeholder key
  `<repo-basename>` and value `<sha>` as a documentation example. Both are
  written for a new consumer: the `.ai/run` pointer and the keyed marker are
  read by grounding-mcp's `ow-run-completeness` reader, released as
  `@lannguyensi/grounding-mcp` 0.9.0 (agent-grounding task
  `design/ow-run-pointer-binding`, agent-tasks 43a7ef58, PR #198). The
  reader resolves a run through the pointer first and falls back to scanning
  the repository's own `.ai/runs/` (newest by name) only when no pointer file
  exists, so kits and repos without the pointer keep working exactly as
  before; the run-base marker's own date-heuristic fallback for a `TODO`
  value is a separate mechanism and is unchanged. `README.md` ("What gets
  installed") and `INSTALL-AGENT.md`
  ("Write surface" and the manual scaffold list) now note that `.ai/run`
  should be added to the repository's `.gitignore` (the installer does not
  edit `.gitignore` itself). Pinned by new tests in
  `test/template-markers.test.ts` (the keyed placeholder line's exact text,
  its whole-line-comment shape, its position directly below the unkeyed
  marker, and that the existing unkeyed `run-base` regex still matches
  exactly once) and a new `test/docs-consistency.test.ts` describe block
  (the pointer contract's phrases in SKILL.md Run state, the exact keyed
  example string, step 1, each of the three Harness notes bullets
  individually, the agents-md-section bullet, and the README/INSTALL-AGENT
  gitignore notes). Anchors in `docs/okf/*.md` that cite line ranges in
  `SKILL.md`, `test/docs-consistency.test.ts`, and
  `test/template-markers.test.ts` drifted out of range because of the line
  shifts this change introduces; those anchors were re-pointed in the same
  PR, and `run-state-lifecycle-and-markers.md` gained a section documenting
  the pointer and the keyed marker.
- Two review rounds on the run-pointer change above corrected inaccurate
  claims and hardened the pinning tests. `SKILL.md` Run state now states the
  pointer contract as a short lead sentence plus three bullets (what the
  pointer's content is, when to write, overwrite, and remove it, and to
  make sure it is ignored before writing it), followed by a separate
  paragraph on how the run-completeness reader uses it: pointer first,
  falling back to that repository's own `.ai/runs/` (the run there that
  sorts newest by directory name) only when no pointer file exists, with a broken pointer rejected outright
  rather than falling back; the exact accept/reject rules are left to the
  consuming gate's (grounding-mcp) own documentation, not restated here.
  The keyed-marker grammar sentence is now a single generalised rule: write
  the marker exactly in its documented form, on its own line; a deviating
  line is either rejected, which blocks the run, or not recognised at all
  (for example inside a list bullet), which leaves the binding for that
  repository silently missing. The consumer detail that a real key left
  with the placeholder value `<sha>` is read as-is and blocked by the
  verdict layer lives in `docs/okf/run-state-lifecycle-and-markers.md`,
  not in the skill text. `test/docs-consistency.test.ts`'s pointer-doc
  describe block now routes six of its eight checks through one shared
  `expectPointerMention` helper that asserts the exact phrase `` `.ai/run`
  pointer `` (a bare `.ai/runs/` mention alone cannot satisfy it); the
  SKILL.md Run state contract check and the exact-keyed-example check keep
  their own specific phrases instead, and a further check pins the
  grammar rule's wording ("on its own line", both deviation outcomes).
  `test/template-markers.test.ts`'s property test now carries
  grounding-mcp's `KEYED_RUN_BASE_STRICT` and `PLACEHOLDER_KEY` regexes
  verbatim, kept in sync by hand, instead of a locally tightened mirror,
  and still asserts that two constructed near-miss variants (uppercase,
  space before the colon) do not match. `agents-md-section.md`'s
  run-directory bullet still notes the run directory can live "in the
  workspace or a touched repository". `docs/okf/run-state-lifecycle-and-markers.md`
  carries the corrected claims plus the consumer's own test-measured
  evidence for the scan fallback and the malformed/not-seen split, and
  every `docs/okf/*.md` anchor that cited a line range shifted by either
  round's edits was re-pointed in the same PR.
- An operator-level install layer: a new `operator-manifest.ts` module and
  an operator home directory (default `~/.orchestrator-workflow/`,
  overridable via the `ORCHESTRATOR_WORKFLOW_HOME` environment variable)
  hold one manifest per operator (`{ kit, schemaVersion: 1, defaults: {
  harnesses, profile, tiers, models }, targets: [{ path,
  lastAppliedVersion, lastAppliedAt }], createdAt, updatedAt }`), separate
  from each repository's own `.ai/workflow/manifest.json`. Four new
  subcommands sit alongside the existing per-repository `init`/`uninstall`,
  which stay fully supported and unchanged: `setup` writes or updates the
  operator defaults without touching any repository; `apply --target
  <repo>` projects those defaults, and the target's own previously
  recorded settings, onto one repository through the same
  option-resolution logic `init` uses (`resolveInitInputs`, extracted for
  reuse), and registers the target, by its resolved real path, in the
  operator manifest, with `--sync` inverting precedence so the operator's
  defaults win over the target's recorded profile/tiers/models, and
  `--pin`/`--unpin`/`--force-pin` controlling the new per-repo kit-version
  pin (below); `doctor [--json] [--prune]` walks the registry and reports
  each target's status (`clean`, `divergent`, `version-lag`, `drift`,
  `missing`, `no-manifest`, `unverifiable`), exiting `2` when the operator
  manifest is missing or unreadable (or, with `--prune`, when the manifest
  lock cannot be acquired or the rewrite fails), `1` when any target is
  `drift`/`missing`/`no-manifest`/`unverifiable`, else `0`, and `--prune`
  removes `missing`/`no-manifest` targets (never `unverifiable`) and
  rewrites the manifest in normalized form; `adopt [dir] [--json]` registers an
  already-installed repository verbatim, touching nothing in it,
  bootstrapping the operator manifest from the repository's own recorded
  settings when none exists, recording the repository's own version as
  `lastAppliedVersion`, and printing that target's `doctor` report (exit
  `1` only on drift, exit `2` for a precondition failure). Design
  decisions: no new binary, all four subcommands live on the existing
  `orchestrator-workflow` CLI; the registry is implicit, `apply`/`adopt`
  register as a side effect of a real run and `doctor --prune` is the only
  way to remove an entry; a multi-repo workspace root is an ordinary
  target, nothing special. `README.md` gained a new "Operator-level
  install" section and `INSTALL-AGENT.md` gained the operator path (an
  installing agent runs `apply` instead of `init` when an operator
  manifest already exists, and `adopt` for an already-installed
  repository) plus the new operator-home and `pin` entries in its Write
  surface list. Consumer-side evidence: agent-tasks `b457ee55`, PRs
  #142-#147.
- The repo manifest (`.ai/workflow/manifest.json`) gained one optional
  field, `pin`: a kit-version string. `apply --pin <version>` sets or
  replaces it (trimmed; empty, whitespace-only, or containing internal
  whitespace rejected as a usage error, exit `2`, writing nothing),
  `--unpin` clears it, and `--force-pin` advances an existing pin to the
  running version (a no-op on an unpinned target); read by `apply`'s pin
  gate and by `doctor`, which on a pinned target compares the pin against
  the installed version instead of the installed version against the
  running kit. Purely additive: a
  caller that never sets it sees a byte-identical manifest to before.
- `init --harness none` (the literal word `none`, alone): a templates-only
  mode that writes only `.ai/workflow/**` and `.ai/runs/.gitkeep`, records
  `harnesses: []` in the manifest, and touches no `AGENTS.md`, `CLAUDE.md`,
  or per-harness directory. `none` combined with a real harness name
  (`none,claude`, either order) is a usage error rather than an implicit
  precedence rule. A plain re-run (no `--harness` flag) after a recorded
  `harnesses: []` install stays templates-only instead of falling back to
  filesystem detection; a later `init --harness <list>` on the same target
  adds harness files and manifest entries additively, without touching the
  already-installed templates. `apply` shares the same option parsing (an
  explicit `--harness none` on an `apply` call resolves to templates-only
  too) but not the re-run stickiness: `apply`'s own harness fallback chain
  (target's recorded harnesses, else the operator defaults, else detection)
  is unchanged, so a target `apply`-installed as templates-only is not
  guaranteed to stay that way on a flagless `apply` re-run, a gap left open
  by this change rather than closed. The closing summary line prints
  `templates only` instead of `installed for: ` followed by nothing.
  Motivated by friction filed 2026-08-28 while refreshing an agent-tasks
  install that had ended up in the templates-only manifest shape (`harnesses:
  []`, produced by a 0.14.0-era install with no harness configured) with no
  supported way to reproduce or re-render that state: `--harness none`
  rejected the literal value, and `--harness ""` fell back to detection,
  which under `--yes` installed `claude` unasked. Documented in `README.md`
  ("Non-interactive") and `docs/okf/install-fence-mechanics.md` (new
  "`--harness none` (templates-only mode)" section). Agent-tasks 613316c9.

### Changed

- `setup`, `apply`'s registration step, `doctor --prune`, and `adopt` all
  write the operator manifest through the same locked write API,
  `updateOperatorManifest`/`withOperatorManifestLock`, backed by one
  advisory lock (`.manifest.lock` in the operator home, stale after 30s)
  so concurrent `orchestrator-workflow` invocations on one machine cannot
  race each other's writes.

## [0.25.0] - 2026-08-27

### Added

- A "Review-round escalation budget" (`SKILL.md`, new section right after
  the existing Round-2 halt rule): by the second round-2 halt signal on a
  task, or its third `fix_required` review round, whichever comes first,
  the orchestrator now picks one of three escalations, tier/model
  escalation, an advisor spawn, or an operator merge-hold, instead of
  running another round unaided, and records the choice in
  `03-decisions.md`'s new Review-round escalation section (the
  `review-round-escalation` marker: `n/a | tier_escalation | advisor |
  merge_hold`, `n/a` a deliberately fail-open default since most runs
  never trigger the budget at all, unlike the `TODO` fail-closed sentinel
  the `solution-acceptance:` marker family uses). Which of the three is
  picked stays a judgment call; only that one is picked and recorded is
  now mandatory, and escalating never substitutes for a review round.
  `agents-md-section.md` carries the same rule in short form. The
  reviewer output contract (`SKILL.md` and `reviewer.md`) gained a
  `recurrence: new | repeated` field per finding, and step 7 now has the
  orchestrator name the review round number in the briefing when it is
  not the task's first, so the reviewer can classify each finding against
  the rounds it was told about instead of the orchestrator re-deriving
  recurrence by hand. `03-decisions.md`'s new marker is a documented
  convention only: nothing in this package's own code reads it today
  (unlike the `solution-acceptance:` markers, which grounding-mcp's
  run-completeness reader does parse); wiring it into that reader, if
  wanted, is a follow-up in the consuming project, not part of this
  change.

  Evidence: agent-tasks d03af8f6 (pandora run
  `.ai/runs/2026-08-26-open-pool-batch30`, a harness risk-gate deletion
  arm) ran five implementer rounds on the same effort tier (rounds 1-5, the
  default-tier implementer, Sonnet) before this rule existed; each reviewer
  round found one new HIGH on the permissive side of the same detection layer
  (first-segment matching, wrapper flags, xargs flags, a find-root premise
  twice, xargs `-i`/append), and the Round-2 halt rule's split-or-redesign
  response was applied three times (D-014, D-019, D-022/D-023) without ever
  escalating tier, model, or to the advisor, and without a merge-hold. Only
  after round 5 did the operator suggest a stronger model (D-024); round 6, on
  Fable with the `-xhigh` variant, found and closed twelve further fail-open
  classes in one round by its own 248-probe audit, and the following review
  found only one remaining, a documentation-only medium. A same-run comparison
  task, agent-tasks da823721, needed three rounds with one round-2 halt and
  was accepted after it, well inside this budget. This is the first data
  point relating implementer model strength to round count on a
  permissive-security-parser class of task; the 2026-08-24 tier A/B (see
  `[0.23.0]` below) measured only
  `implementer-low` against the default tier on a different task shape,
  not model strength, so whether a stronger model generally shortens
  these rounds remains open.
- A new `okf-anchor-guard` job in `.github/workflows/ci.yml` (this repo)
  runs okf-kit's anchor check against `docs/okf` and fails the build (no
  branch-protection change; master has no required checks today) when an
  edit to `SKILL.md`, an agent template under `assets/agents/`,
  `src/models.ts`, a `test/*.test.ts` file, any other `src/*.ts` module,
  a run template under `assets/templates/`, or `assets/agents-md-section.md`
  shifts a cited range out of the section or text an anchored bundle
  citation names, instead of only the existing warn-only `okf-staleness.yml`
  drift watch (which never blocks by design and stays untouched). Every
  in-scope bundle citation into those source categories now carries a
  string-form anchor (up from a first-round draft that review round 2
  found had missed 44 bare, non-backtick-delimited citations in two of the
  five docs/okf siblings; the citation parser was corrected to match
  okf-kit's own backtick-optional shape; scope later widened from the
  original four categories to every `src/*.ts` module and every
  `assets/templates/*.md` plus `assets/agents-md-section.md`, agent-tasks
  ca9d5048); the `CHANGELOG.md` citations still carry heading anchors from
  the prior round (that mechanism is untouched, but every CHANGELOG entry
  added above them, this one included, re-points all of them -- see
  `docs/okf/log.md` for the live count and the re-point history, not
  hand-copied here since it drifts with every CHANGELOG edit).
- Every anchor now satisfies two mechanically-checked properties review
  round 2 added (a first-round anchor sitting on a wide range's first line,
  as 107 of 121 did, survives an insertion shorter than the range itself --
  measured: round 1 had 46 SKILL.md-targeting anchors, and a 1-line
  insertion near the top of SKILL.md left 24 of them silently green): (a)
  the anchor text occurs on the LAST line of its cited range (ranges were
  narrowed where needed to end on real content rather than a
  blank/closing-brace line), and (b) it occurs at most 3 times in the
  whole target file (23 first-round anchors used a too-common token, e.g.
  `describe(`, and were
  replaced). Two anchors were additionally re-pointed because the text
  they carried did not match the claim their citing sentence made, not
  just its mechanical position; see `docs/okf/log.md` for both. Pinned by
  three new tests in `test/docs-consistency.test.ts` (version-pin
  coverage extended to every `.github/workflows/*.yml` file, not just
  `okf-staleness.yml`; the last-line/occurrence-cap rule, verified red
  against the first-round anchors and green against this round's; and an
  erosion brake asserting zero unanchored in-scope citations going
  forward). `ci.yml`'s anchor-finding jq filter now matches any
  `anchor-*`-tagged finding by pattern instead of four hardcoded rule
  ids, guarded by a new self-test step that builds a throwaway fixture
  bundle with one deliberately drifted anchored citation and requires the
  filter to catch it before the real check runs.
  `okf-kit check` reports the same 0 errors / 13 warnings / 22 notices
  before and after this round's full anchor rewrite (0 anchor findings
  either way; the 13 pre-existing warnings are unrelated
  `install-fence-mechanics.md` short-form findings against `init.test.ts`
  and `init.ts`). Differential mutation probe, replacing the first
  round's single 27-finding number: inserting `k` dummy lines near the
  top of SKILL.md, 52/52 (100%) of its unique cited ranges now produce a
  finding at `k=1`; 51/52 (98%) at `k=2`, one named exception (a
  same-block token collision, see `docs/okf/log.md`). A `package.json`
  patch-version bump still leaves the anchor-finding count at 0,
  confirming no false positive. Residual gaps named in `docs/okf/log.md`:
  a content change inside a cited range that neither shifts its line
  count nor disturbs the anchor text stays invisible to this check
  (mechanical, never semantic, the same limit okf-kit's own README
  documents), plus the one named same-block token collision above
  (agent-tasks task 578f5bfd, review round 2; following the
  anchored-citations feature itself, task 5c8013c0, and its release, task
  c0effc67).

### Changed

- `docs/okf/subagent-contracts-superset.md`: rewrote its 22 sibling short-
  form citations (21 initially, plus one missed and fixed this round) from
  the parenthesized form (`(N-M)`) to the colon form (`, :N-M`) so
  `citations-resolve` checks them again. Neither form was ever machine-
  checked in a released `okf-kit`: the colon-form gate and the drop of
  paren-form collection landed in the same `[Unreleased]` entry, so
  "dropped" overstates it. Inserting this entry shifts every later line
  number in this file, so any absolute-line `CHANGELOG.md` citation below
  it breaks until re-pointed; this round re-points all sixteen such
  citations across the three touched docs/okf siblings
  (`subagent-contracts-superset.md`, `review-gate-and-waivers.md`,
  `run-state-lifecycle-and-markers.md`), each checked against the
  `## [x.y.z]` section its own sentence names, not against a byte-diff of a
  moving base. `okf-kit check` against a repo build (not the published
  package) reports 0 errors / 13 warnings / 22 notices; all 13 are
  pre-existing `install-fence-mechanics.md` short-form findings unrelated
  to this change, so the three touched docs carry no citations-resolve or
  sources-fresh finding of their own (log.md records the fuller
  sources-fresh investigation, since that count depends on this round's
  commit shape, not on the citations themselves). Coverage holds only
  against a repo build: CI's `okf-staleness.yml` still pins the published
  `okf-kit@0.5.0`, which predates short-form colon resolution, so it
  reports 0 short-form findings until that release ships (agent-tasks task
  2e3e5f4b).
- All sixteen `CHANGELOG.md` citations across the three `docs/okf` siblings
  above now also carry a heading anchor (`` `CHANGELOG.md:N-M#x.y.z` ``, a
  new `citations-resolve` form -- see okf-kit's own CHANGELOG for the
  design), pinning each one to the release section its own sentence names
  instead of only to a line range that a future top-of-file insertion can
  silently shift into the wrong section. `okf-kit check` against a repo
  build still reports the same 0 errors / 13 warnings / 22 notices as
  above (all pre-existing, unrelated to this change); a mutation probe that
  moved one migrated citation's range into its neighbouring release
  section, and a second probe that inserted a dummy entry at the top of
  this file (shifting every citation below it), were both caught by the
  new anchor check and reverted (agent-tasks task 5c8013c0).

### Corrections

- Correction to the "Known limit of the pack" note in the 0.24.0 entry
  below: this is not an `orchestrator-workflow` behavior change, it
  documents a `slop-detector` fix. The 0.24.0 note described a known limit
  of `placement-slop`, that an `allow` match suppressed every placement
  rule on the line it matched, not just the marker span it was meant to
  excuse. `slop-detector` has since fixed this (`placement.allow` is now
  span-scoped, not line-wide). Consumer-visible effect: a config that
  reported clean before can now report a `block`-severity finding (e.g.
  `placement-slop/home-path`) when a home path, a date, or a tally phrase
  shares a line with an allowed marker.

## [0.24.0] - 2026-08-24

### Changed

- **Moved org-, machine-, and point-in-time-bound evidence out of the kit's
  reusable instruction files; rule text is unchanged.** Public,
  tool-agnostic kit files (`SKILL.md`, `agents-md-section.md`) now carry
  rules and procedures only; the measurements, dates, sample sizes, task
  ids, and incident tallies that used to sit inline are recorded here in
  the changelog instead, with a one-line pointer left in prose.
  - `SKILL.md` step 6 ("Delegate implementation"): the parenthetical
    `(2026-08-24 A/B measurement, n=8: implementer-low reached accept a
    median 320 seconds slower, p=0.016, with 9 high-plus-critical review
    findings against 1 and 8 fix rounds against 1)` is now `(anchored by an
    A/B measurement; see CHANGELOG 0.23.0)`. The full numbers already live
    in the 0.23.0 entry below.
  - `agents-md-section.md`'s Scaling delegation bullet: the paragraph
    naming the A/B's `n=8`, the median slowdown, `p=0.016`, the
    high-plus-critical finding count, the fix-round count, the Haiku 4.5
    model detail, and agent-tasks task `7f38899d` is replaced by "This rule
    is anchored by an A/B measurement; the data and the model caveat are
    recorded in the orchestrator-workflow CHANGELOG (0.23.0)." Same data,
    same 0.23.0 entry.
  - `SKILL.md`'s "Subagent misfire rule": the incident tally `(four so
    far)` and the whole reviewer/model-correlation passage ("So far this
    signal has only been observed for the reviewer role ...", including the
    0.21.0 advisor remark and the pointer to the per-role model
    preferences) are removed. The rule itself (the signal definition, the
    contract-parse and near-instant detection signals, the
    resume-over-respawn preference and its reasoning, the respawn fallback,
    the watchdog-stall exception, the `03-decisions.md` record requirement,
    and "a misfired review is not a review") is unchanged. The removed
    passage, verbatim, for the durable record: "Every incident of this
    exact signal (a return within seconds, zero tool calls, harness or
    system boilerplate instead of the output contract) whose outcome was
    recorded (four so far) has resolved on the first resume attempt; fall
    back to a fresh respawn only if the resume attempt itself misfires the
    same way. So far this signal has only been observed for the reviewer
    role, a role whose default model differs from explorer's,
    task-slicer's, and implementer's (since 0.21.0 the advisor shares the
    reviewer's default model too; the advisor has had no spawns yet, so it
    contributes no evidence either way; see the per-role model
    preferences); treat that correlation as an open lead worth watching as
    more incidents accumulate, not as a confirmed cause." Of the four
    resume outcomes recorded for that signal, three were on 2026-07-16 and
    one was on 2026-07-20. The watchdog-stall exception's removed sentence,
    also verbatim: "This resume-over-respawn preference does not extend to
    a structurally different misfire class: a mid-run watchdog stall (the
    subagent goes idle partway through a run rather than returning
    near-instantly) did not resolve on resume in the one measured incident
    of that class, it stalled a second time, and only a fresh, explicitly
    constrained respawn produced a contract-valid review; treat a watchdog
    stall as outside this preference."
  - `SKILL.md`'s Run state paragraph: "see the grounding-mcp 0.6.0 docs for
    the full consumer semantics" is now "see the consuming gate's
    documentation (grounding-mcp) for the full consumer semantics", dropping
    the pinned version number.

### Added

- **Reviewer placement check.** `reviewer.md`'s "Check, at minimum" list
  gains a check for org-, machine-, or point-in-time-bound evidence (dates,
  sample sizes, task ids, home paths, incident tallies) leaking into a
  reusable instruction file (a skill, an agent prompt, an AGENTS.md
  section, a template); the fix it recommends is moving the evidence to the
  changelog, the run files, or the consuming workspace and leaving a
  one-line pointer.
- **Hand-off placement check.** `SKILL.md` step 9 ("Hand off") gains one
  sentence for the orchestrator: check before handing off that no such
  evidence was added to a reusable instruction file.
- **`placement-guard` CI job.** A dedicated job in agent-dx's
  `.github/workflows/ci.yml`, separate from the package matrix, builds
  `slop-detector` and runs its opt-in `placement-slop` pack against the
  monorepo's instruction files (`packages/orchestrator-workflow/assets/**`
  and `packages/agentic-coding-playbook/**`, configured via the repo-root
  `slop.config.yml`), failing on block-level violations.
- **Root `slop.config.yml`.** Opts the `placement-slop` pack in for the CI
  job, configures the `LanNguyenSi` org marker with `allow` entries for its
  two legitimate repo links (`github.com/LanNguyenSi/`,
  `raw.githubusercontent.com/LanNguyenSi/`, both anchored to a full
  `https://` URL), widens the pack's instruction-file globs to cover this
  package's `assets/` tree and the `agentic-coding-playbook` package, and
  overrides `placement-slop/dated-evidence`, `placement-slop/tally-phrase`,
  and `placement-slop/opaque-id` from their pack default of `warn` to
  `block`, so the CI job actually fails on a leaked date, tally phrase, or
  opaque id instead of only warning (a home path or an unlisted org marker
  was already `block` by pack default). `packages/github-api-tool/SKILL.md`
  carries two pre-existing dated examples that this severity change would
  now block; it is `ignorePaths`-excluded pending a follow-up cleanup of
  that unrelated package.
  Known limit of the pack, unchanged here: an `allow` match suppresses
  every placement rule on that line, so a home path or a date that shares
  a line with an allowed repo URL is not reported; a span-scoped allow is
  a slop-detector follow-up.

## [0.23.0] - 2026-08-24

### Changed

- **Tightened the `implementer-low` tier rule from discretion to a checkable
  gate on the task contract.** `agents-md-section.md`'s Scaling delegation
  bullet and `SKILL.md` step 6 ("Delegate implementation") no longer say
  `-low` "fits mechanical, narrowly scoped tasks" for the implementer;
  `implementer-low` is now spawned only when none of the following hold: an
  acceptance criterion demands a test, typecheck, lint, or build run; the task
  assignment names mutation probes to run; or the task slicer's
  `suggested_tests` came back non-empty. A task with any of those, including a
  bugfix that looks mechanical, runs on the unsuffixed implementer or higher.
  When it is unclear whether a criterion demands a run, exclude
  `implementer-low`. The explorer and the task-slicer keep the prior
  discretionary `-low` guidance unchanged, since no equivalent measurement
  exists for those roles. Operator decision 2026-08-24 after a Tier-A/B
  measurement of implementer-low as installed (Haiku 4.5) against the default
  implementer (Sonnet 5, effort medium) (agent-tasks task 7f38899d), blinded,
  n=8, identical tasks in both tiers: implementer-low reached accept a median
  320 seconds slower (p=0.016), drew 9 high-plus-critical review findings
  against 1, and needed 8 fix rounds against 1. The A/B's implementer-low ran
  on Haiku 4.5, which does not support the `effort` parameter, so the harness
  ignores the pinned `effort: low` on that model; the measurement compared
  Haiku 4.5 without effort control against Sonnet 5 at `effort: medium`.

## [0.22.0] - 2026-08-20

### Changed

- **Default subagent spawns no longer inherit the orchestrator session's
  effort.** Every unsuffixed default agent file (`explorer.md`,
  `task-slicer.md`, `implementer.md`, `reviewer.md`, `advisor.md`) now
  carries its own pinned default effort, unconditionally, regardless of
  whether `--tiers` is on: `effort: medium` for explorer, task-slicer, and
  implementer, `effort: high` for reviewer and advisor
  (`TIER_DEFS[DEFAULT_TIER[role]].effort`, the same tier data `--tiers`
  already used, applied by `composeClaudeAgent` for every install, tiers
  flag or not). opencode gets the matching pinned line via
  `opencodeEffortLine` (renamed from `opencodeVariantEffortLine`, now shared
  by the default file and the tier variants): a resolved Claude-family model
  gets `variant: high` for reviewer/advisor and no effort field at all for
  the three medium-default roles (opencode's `variant:` option does not
  distinguish an effort below `high`, the same collapse tier variants
  already documented), a non-Claude-family provider-qualified model gets
  `reasoningEffort: medium`/`reasoningEffort: high`, and Ollama, a
  provider-less id, or an unresolved model gets no effort field either way.
  Practically: on a high-effort orchestrator session, a default subagent
  spawn used to silently run at that same high effort; it now runs at its
  own role's pinned effort instead, which is weaker (and cheaper) for the
  three medium-default roles. Escalate deliberately via the `-high`/`-xhigh`
  tier variants (`--tiers`) when a task actually needs more.
  **`CLAUDE_CODE_EFFORT_LEVEL` still beats this pin**: when the harness
  environment sets that variable, it overrides every installed agent's
  frontmatter `effort:`, default files and tier variants alike, the same
  warning `--tiers` already carried. **opencode cannot express `medium` for
  a Claude-family model at all**: the `variant:` field only distinguishes
  `high`/`max`, so a Claude-family default file for explorer, task-slicer,
  or implementer renders with no effort field, falling back to whatever the
  resolved model's own default happens to be.
  The default file's content stays byte-identical whether or not `--tiers`
  is also on, since the pin does not read the `tiers` flag; this invariant
  is now belt-and-suspenders tested directly (a two-target diff, not just
  inferred from reading the source).
  A `--tiers`-off install (the default) renders no variant files at all, so
  it has no in-install escalation path off a default's pinned effort; pull
  `init --tiers` afterward if a task needs one.

## [0.21.0] - 2026-08-20

### Added

- Advisor role: a fifth subagent, read-only and installed only under the
  `full` profile (never under `minimal`, the same as explorer and
  task-slicer), with a default model of `opus` (`ROLE_TIERS`: `high, xhigh`,
  `DEFAULT_TIER`: `high`, so `--profile full --tiers` renders 15 files per
  harness instead of 13: 5 default files plus 10 variants). Unlike the other
  four roles, the advisor is escalation-only: the orchestrator spawns it only
  at a defined set of triggers (architectural uncertainty, requirements that
  contradict each other, multiple valid solution paths where committing to
  one is expensive to reverse, repeated implementation failures on the same
  task, a review deadlock, or a high-risk decision), never as a standard
  pipeline step. The advisor reads the situation, lays out options with
  pros/cons/risk, and recommends; it never decides and never writes code —
  the orchestrator still decides, and a critical risk still goes to the
  operator, the same hard rule the review gate already applies. This ships
  as a docs/policy/prompt-only change on top of the prior commit's `models.ts`
  core (`ROLES`, `READ_ONLY_ROLES`, `DEFAULT_MODELS`, `ROLE_TIERS`,
  `DEFAULT_TIER`, and the `assets/agents/advisor.md` prompt): `README.md`
  (role table, tier table, read-only posture, a new "Advisor (escalation)"
  paragraph), `INSTALL-AGENT.md` (brace lists, `--models` example, manifest
  JSON example, read-only-posture sentences, manual-scaffold role loops),
  `assets/agents-md-section.md` (per-role model bullet plus a new Scaling
  delegation bullet stating the escalation triggers and the
  recommends-never-decides rule), and `assets/skill/SKILL.md` (a Roles-section
  bullet, the subagent input contract's role enum, a new "Advisor output
  contract" block, a step 8 sentence naming when the orchestrator may spawn
  it, and the harness notes' full-profile role enumeration). See README.md's
  "Advisor (escalation)" paragraph for the design rationale behind the
  escalation-only framing.

### Changed

- The subagent misfire rule's model-correlation observation ("the reviewer
  role, the one role whose default model differs from the other roles'") no
  longer holds now that the advisor shares the reviewer's `opus` default;
  reworded to name the roles the differing-model claim actually still holds
  against (explorer, task-slicer, implementer) while keeping the historical
  observation intact — this signal has still only ever been observed for the
  reviewer role, never for the advisor. `test/docs-consistency.test.ts`'s
  `DEFAULT_MODELS`-grounded pin for this claim was narrowed to match (scoped
  to the three roles the prose now names, plus a new assertion that
  `DEFAULT_MODELS.advisor` equals `DEFAULT_MODELS.reviewer`, grounding the
  "since 0.21.0 the advisor shares that model" half of the corrected prose).
- Full test suite grows to 247 (238 baseline + 9 new: 6 tests in a new
  `describe` block pinning the escalation policy paragraph in
  `agents-md-section.md` and the four `SKILL.md` additions listed above, 1
  from the existing instruction-trust-boundary loop test picking up
  `agents/advisor.md`, and 2 from the existing README tier-table loop test
  picking up the advisor row; the misfire-rule fix reuses two existing
  tests rather than adding new ones).

## [0.20.0] - 2026-08-20

### Added

- Tier-selection policy for the orchestrator, following up on 0.19.0's
  `--tiers` rendering mechanics with the guidance that was missing: when tier
  variants are installed (manifest `tiers: true`), the orchestrator picks
  the effort tier per task by complexity and risk, at its own judgment. The
  guidance is discretionary by design, not a rigid assignment table: the
  unsuffixed default subagent is the normal case, a `-low` variant fits
  mechanical, narrowly scoped tasks, `-high`/`-xhigh` fit high-risk changes,
  hard problems, or repeated failed attempts, and tier choice is a conscious
  decision rather than a ritual, defaulting to the unsuffixed subagent when
  unsure. Ships in the generated `AGENTS.md` section's Scaling delegation
  bullet list and in both of `SKILL.md`'s "Delegate implementation" and
  "Delegate review" steps, each also instructing the orchestrator to record a
  non-default tier choice with a one-line reason in `03-decisions.md` when
  the task is non-trivial. `test/docs-consistency.test.ts` gains a new
  `describe` block pinning the policy prose in `agents-md-section.md`, the
  absence of a rigid tier-assignment table there, an anti-drift check that
  the tier suffixes the prose names (`-low`, `-high`, `-xhigh`) actually
  exist in `models.ts`'s `ROLE_TIERS.implementer`, and the rule's presence in
  both `SKILL.md` delegate steps.

## [0.19.0] - 2026-08-19

### Added

- `init` gains `--tiers`: renders an additional per-role subagent variant
  file for each non-default effort tier, alongside the one default
  (unsuffixed) agent file `--profile` already installs. Off by default, like
  every optional pack in this kit; a plain re-run with no `--tiers` flag
  keeps whatever the previous install had, the same override-vs-persist rule
  already used for `--profile`/`--models`, and there is no interactive
  prompt, tiers is opt-in via the flag only. `models.ts` adds `Tier`
  (`low|medium|high|xhigh`), `ROLE_TIERS` (which tiers each role gets:
  explorer/task-slicer `low,medium,high`; implementer all four;
  reviewer `medium,high,xhigh`), `DEFAULT_TIER` (the tier each role's plain
  file already corresponds to: `medium` for explorer/task-slicer/implementer,
  `high` for reviewer, never rendered as its own variant since that would
  both collide with and duplicate the default file), `TIER_DEFS` (tier ->
  model class + requested effort), and `CLASS_MODELS` (model class -> model
  alias: `small`->`haiku`, `medium`->`sonnet`, `large`->`opus`). The default
  file for every role stays byte-identical to a tiers-off install (still
  `manifest.models[role]`, no `effort:` key) whether or not `--tiers` is
  passed, so the reviewer's `opus` default can never be silently downgraded
  by this feature; a dedicated regression test pins that. Variant files are
  named `<role>-<tier>.md`; with `--profile full` and tiers on, that is 4
  default files plus 9 variants (13 total). Claude Code variants carry
  `model: <class alias>` and `effort: <tier>` frontmatter (plus
  `disallowedTools: Edit, Write, NotebookEdit` for the read-only roles, same
  as the default file). opencode variants key off the resolved model's
  family, not its provider prefix: a Claude-family id (any provider fronting
  a `claude-`-named model, e.g. `anthropic/claude-...`,
  `github-copilot/claude-...`, or the nested
  `openrouter/anthropic/claude-...`) gets `variant: high`/`variant: max` for
  the `high`/`xhigh` tiers only (`low`/`medium` collapse to no effort field,
  a documented opencode `variant:` limitation, not a bug), Ollama or a provider-less
  id gets no effort field, and every other non-Claude-family model gets a plain
  `reasoningEffort: <tier>` line; the variant's `model:` line resolves
  through the same live `opencode models` catalog lookup as the base
  per-role model, keyed by the tier's model class instead of by role. A tier
  whose class model cannot be resolved at all renders no variant file for
  that class, not a file with the `model:` line simply omitted, and the CLI
  warns once per unresolved class on stderr; this guard and its warning
  are opencode-scoped only, since Claude Code variants resolve `model:` from
  a plain alias and need no live catalog lookup. The chosen value is
  recorded in a new `tiers` boolean on
  `.ai/workflow/manifest.json`; a manifest written before tiers existed (no
  `tiers` key) degrades to `false`, the same per-field-degradation style
  already used for a missing `profile` field. Variant files flow through the
  existing `installKitFile` hash ledger, so idempotence, conflict detection,
  and `uninstall` all cover them automatically with no dedicated code.
  Motivated by a harness capability probe (2026-08-19): Claude Code's
  `effort:` subagent frontmatter is wire-verified to reach the model request
  as `output_config.effort`, which is what makes rendering per-tier
  frontmatter variants worth doing at all, but the same probe also found
  that the `CLAUDE_CODE_EFFORT_LEVEL` environment variable always overrides
  frontmatter `effort:` on every installed agent when set, tier variants and
  default files alike; README's new "Effort tiers" section documents that
  override explicitly as a warning, not a footnote. README documents the
  flag, the role/tier table, the tier -> model class/effort table, and the
  opencode provider behavior; `INSTALL-AGENT.md` documents `--tiers` in the
  init question/example and the manifest JSON shape, and states the manual
  fallback path does not render tier variants at all. A new, narrowly scoped
  `docs-consistency.test.ts` check enumerates the README tier table against
  `ROLE_TIERS`/`DEFAULT_TIER` directly, so a role or tier added to either
  without a matching table update fails loudly. Both OKF bundle docs
  touching the installer (`model-preselection.md`,
  `install-fence-mechanics.md`) are re-verified and re-stamped.

## [0.18.0] - 2026-08-18

### Changed

- Extends the Subagent misfire rule (`SKILL.md`) and hardens the installed
  reviewer prompt, both docs/prompt-only, after two further sessions
  (2026-07-19, 2026-07-20) reproduced the same near-instant, no-tool-activity
  reviewer misfire the rule was originally written for in 0.11.0: a
  first-spawn reviewer returned within seconds, zero tool calls, harness or
  system boilerplate instead of the output contract. In the 2026-07-20
  session, a resume on the same subagent with the assignment explicitly
  repeated produced a full, contract-valid review; the 2026-07-19 session's
  resume outcome was not recorded. Explorer and implementer first spawns
  never misfired in either session.
  - **Concrete resume-over-respawn workaround.** The rule previously said
    only "resume or respawn," leaving the choice and the resume mechanics
    unstated. It now names, for this specific signal, resume over a fresh
    respawn as the preferred response, states the mechanic (repeat the
    original assignment explicitly, not a generic retry, since resume keeps
    the subagent's prior context while a fresh spawn starts cold), and
    scopes the fallback to a fresh respawn to the case where the resume
    attempt itself misfires the same way. This preference is scoped to the
    near-instant, no-tool-activity signal; a structurally different misfire
    class, a mid-run watchdog stall, is out of scope for it: the one
    measured incident of that class did not resolve on resume (it stalled a
    second time) and only a fresh, explicitly constrained respawn produced a
    contract-valid review.
  - **Model correlation flagged as an open lead.** A structural comparison
    of the four installed agent prompts (`explorer.md`, `implementer.md`,
    `reviewer.md`, `task-slicer.md`, checking each one's frontmatter, line
    count, and its `models.ts` default-model entry) found this signal has so
    far only been observed for the reviewer role. Tool posture does not
    explain it: the explorer role carries the identical read-only
    restriction and has not shown the signal. The reviewer role is the only
    one of the four whose default model (`opus`) differs from the other
    three's default (`sonnet`); `SKILL.md` now names that correlation
    explicitly as an open lead to keep watching as more incidents
    accumulate, not as a confirmed root cause: a deterministic repro of a
    harness-level subagent-spawn race is not achievable in a docs/
    prompt-only package (there is no runtime code here that spawns
    subagents), so this remains an observation, not a fix at the harness
    layer.
  - **Reviewer prompt hardening.** `reviewer.md` now instructs the reviewer
    to begin its very first turn with a tool call before writing any
    analysis, and forbids a text-only opening turn (harness boilerplate, a
    restated-instructions preamble). This does not address a harness-level
    spawn race directly, but removes one plausible contributing factor (the
    prompt not forcing an immediate tool call) at no cost.
  - **Observation task, not closed.** Whether the hardened prompt plus the
    documented workaround measurably reduces the recurrence rate can only be
    judged by watching subsequent sessions for the same signal; this is
    recorded as an open observation, not claimed as verified here. Observable:
    first-spawn reviewer misfires of this exact signal, counted per session
    and recorded as they occur via the friction-log and run notes; review the
    accumulated count after roughly five more sessions.

  Motivated by agent-tasks task a932b12a.

  Review-fix follow-up (same task, same day): review found the claim "every
  incident of this exact signal has resolved on the first resume attempt"
  overstated the record: only four resume outcomes for this signal are
  actually recorded (three on 2026-07-16, one on 2026-07-20); the
  2026-07-19 session above never had a resume outcome recorded at all. This
  entry's intro paragraph and `SKILL.md` now bind that claim to recorded
  outcomes ("four so far") instead of a universal resolve rate, and no
  longer attribute a resume success to the 2026-07-19 session specifically.
  `SKILL.md` also gained the watchdog-stall scope carve-out folded into the
  workaround bullet above, so the resume-over-respawn preference is not
  read as covering every misfire. The docs/okf bundle
  (`subagent-contracts-superset.md`, `review-gate-and-waivers.md`,
  `run-state-lifecycle-and-markers.md`) had landed the feature commit above
  with no bundle update at all, repeating the 0.16.0/0.17.0 gap; this pass
  closes it (see `docs/okf/log.md` for the re-verification detail).

## [0.17.0] - 2026-08-18

### Changed

- Anchors three process lessons from a live review-fix run in the kit
  procedures (`SKILL.md` plus the installed `task-slicer.md` and
  `reviewer.md` prompts), each docs/prompt-only:
  - **Round-2 halt criterion.** Step 8 (Decide acceptance), detailed in a new
    Round-2 halt rule section, now names a stop signal for a repeating
    review-fix cycle: a review round finds a new defect of the same class
    the previous round's fix addressed, so the class has recurred once after
    being fixed, and the next fix would again be case-by-case enumeration
    (boundary tokens, spellings, and similar one-off patches). Stop the
    first time this signal fires: the recurrence is already the class's
    second occurrence, so do not wait for a third one before stopping. Name
    the structural cause in one sentence, and split or redesign instead of
    continuing: ship the healthy half on its own verification and refile the
    removed half as its own task carrying the measurement history that led
    to the split. Failing acceptance criteria go to the operator as a
    merge-hold (hold the change unmerged and hand the decision to the
    operator).
  - **Split-by-default for documented-divergence sub-tasks.** Step 4 (Slice
    tasks) and the task-slicer prompt now default a high-risk sub-task whose
    acceptance criteria allow recording the divergence instead of changing
    behavior, so its outcome is undetermined at slice time (for example,
    phrased along the lines of "... or record the divergence as a
    deliberate, documented boundary"), to its own PR (its own independently
    shippable unit), instead of bundling it with a lower-risk sibling task
    whose shipping should not wait on it.
  - **Diff-as-file reviewer briefing.** Step 7 (Delegate review) and the
    reviewer prompt now cover the case where the reviewer's environment
    cannot use version control to see the diff (for example a policy-gated
    repository): the orchestrator supplies the diff as a pre-generated file
    in the briefing instead of expecting the reviewer to derive it, and the
    reviewer explicitly reports when it could only reconstruct the delta
    some other way instead of silently reviewing less than the full change.

  Motivated by agent-tasks task 66c548ad.

## [0.16.0] - 2026-08-18

### Changed

- Hardens three subagent output-contract gaps measured across a 16-round
  dogfood run: two separate implementer rounds omitted briefed-as-mandatory
  mutation probes from their return entirely (a human had to rerun them);
  one implementer committed a false "Verified by ..." claim into a source
  comment for a probe it never measurably ran; one reviewer omitted the
  mandatory `acceptance_recommendation` field. Three changes, each docs/
  prompt-only:
  - Implementer output contract gains a `mutation_probes` field (`mutant,
    verified_applied_via, result, restored_verified`), mirrored
    byte-identically in `SKILL.md`'s reference copy and the installed
    `assets/agents/implementer.md` prompt. The Subagent misfire rule now
    states explicitly that an implementer return omitting this field, when
    the task assignment named mutation probes to run, is a misfire like any
    other: resume or respawn, never fold into run state.
  - The installed implementer prompt gains a claim-only-what-was-measured
    rule: a verification claim (for example "Verified by ...") in a code
    comment, commit message, or the implementer's own report is only for a
    check the implementer actually ran and measured itself.
  - Reviewer contract marks `acceptance_recommendation` as a hard-mandatory
    field in both the installed `assets/agents/reviewer.md` prompt and
    `SKILL.md`'s reference copy; `SKILL.md` adds that when the field is
    missing, the orchestrator asks the reviewer to resupply it rather than
    inferring a recommendation from the findings list.

  Motivated by agent-tasks task 16637a96.

  Review-fix follow-up (same task): `mutation_probes` shipped with no
  trigger the kit itself ever produced (SKILL.md step 6 said nothing about
  naming probes) and no not-applicable signal (an implementer never given
  probes returned the same placeholder block as one that silently dropped
  them). Step 6 now instructs the orchestrator to name the mutation probes
  to run in the task assignment whenever acceptance rests on a test that
  must fail without the change, and carries a short reference to the
  claim-only-what-was-measured rule. Both `mutation_probes` rule-text
  copies (`SKILL.md`'s reference paragraph and the installed
  `implementer.md` prompt) gained a not-applicable clause: when the
  assignment names no probes, the implementer returns `mutation_probes: []`
  rather than omitting the field, so "none asked for" is distinguishable
  from "asked for and not reported". The installed prompt's wording for a
  missing field changed from "incomplete" to "treated as a misfire, not
  evidence", matching the Subagent misfire rule's own language; that rule's
  paragraph also had an uneven line-wrap seam (left by the original 0.16.0
  edit) rewrapped.

## [0.15.0] - 2026-08-17

### Added

- `init` gains `--profile minimal|full`: `full` (the default) installs every
  subagent role, byte-identical to pre-0.15.0 behavior when the flag is
  omitted or passed explicitly as `full`; `minimal` installs only
  `implementer` and `reviewer` (`task-slicer` and `explorer` are omitted).
  The reviewer is never omittable under either profile (Standing Rule:
  always review), so `minimal` is the write+check pair, not "just
  implementer". `rolesForProfile` selects the installed role set for both
  the Claude Code and opencode per-role agent files; Codex has no per-role
  files, so the profile choice does not change what it gets. The chosen
  profile is recorded in a new `profile` field on
  `.ai/workflow/manifest.json`. A plain re-run with no `--profile` flag
  keeps the previously installed profile, the same override-vs-persist rule
  already used for `--harness`/`--models`; an explicit `--profile` always
  overrides. A manifest written before profiles existed (no `profile` key)
  degrades to `full`, not `minimal`, since that install always put down
  every role; a CLI-path test spawns `init` against a hand-written
  pre-profile manifest and asserts all four agent files are (re)installed,
  closing a gap where a naive fallback could silently narrow an existing
  install. A `full` -> `minimal` downgrade prints a note naming the
  now-untracked `task-slicer.md`/`explorer.md` agent files and how to
  remove them (`orchestrator-workflow uninstall` first, or by hand);
  `uninstall` needs no other change since it only ever iterates
  `manifest.files`, so the leftover files are simply absent from its
  removal loop and it still completes without error afterward. `SKILL.md`
  and the installed `AGENTS.md` policy section now state, at every role
  paragraph that names the explorer/task-slicer subagents, that only the
  roles the profile carries exist as named subagents and any missing role
  is run inline with the same contract, reusing the existing Codex
  "run roles inline" idiom; a docs-consistency test pins the sentence.
  README documents the flag, the single interactive profile question, and
  scopes its "uninstalling a minimal install is always clean on its own"
  claim to installs that were never downgraded from `full`, since a
  downgrade's untracked leftover files are exactly the case that claim
  doesn't cover. Both OKF bundle docs touching the installer
  (`install-fence-mechanics.md`, `model-preselection.md`) are re-verified
  and re-stamped against the file:line locations this feature shifted.
  Also drops an unused `ROLES` import left over in `cli.ts` after
  `promptModels` switched to an explicit `roles` parameter.

## [0.14.0] - 2026-07-18

### Changed

- Reviewer contract now requires independent reproduction when acceptance
  rests on empirical or probabilistic evidence: flake rates, benchmarks, "n
  runs green", or performance/timing numbers. The reviewer must rerun the
  measurement itself, not re-read the implementer's log, and record method,
  sample size, and result against the implementer's claim in a new
  `reproduction` field (`method, sample_size, result,
  matches_implementer_claim`) added to the Reviewer output contract in
  `SKILL.md` step 7 and to the installed `assets/agents/reviewer.md` prompt
  body (shared, byte-identical, by the Claude Code and opencode reviewer
  subagents). `matches_implementer_claim` uses `matched | mismatched |
  not_applicable` rather than `yes | no | not_applicable`: bare `yes`/`no`
  are YAML 1.1 boolean synonyms, and picking unambiguous tokens up front
  costs nothing even though this field is prose a human reads, not a
  machine-parsed value. The trigger is deliberately narrow: a single deterministic
  check (one test run, `tsc`, lint) does not qualify, only claims that could
  vary run to run. `05-review-findings.md` gains a short trailing comment
  pointing reviewers at the rule; the findings-table placeholder row itself
  is untouched. Motivated by a live incident (agent-dx run
  2026-07-18-harness-subprocess-test-deflake): an implementer's "8/8 green"
  flake-rate claim on a maxWorkers-cap fix was overturned only because the
  reviewer independently reran the suite and found 2/6 red on an independent
  6-run sample (flake rate ~1/3, matching the pre-fix baseline) — nothing in
  the prior contract required that rerun. Docs-only change: no runtime
  behavior in this package depends on the new field, it is a reporting
  contract the orchestrator and operator read. Motivated by agent-tasks task
  0018d61c.

## [0.13.0] - 2026-07-18

### Changed

- `05-review-findings.md`'s findings-table placeholder/legend row
  (`| low/medium/high/critical | ... | accepted/defer |`) now carries a
  comment stating its fail-closed semantics: replace this row when
  transferring reviewer findings (step 7), or delete it outright for a
  genuine zero-findings review (a header row with no data rows is valid; a
  leftover legend row next to real finding rows is also fine). `SKILL.md`'s
  step 7 gains a matching one-sentence rule. This is the contract half of a
  fix for a mixed-state bypass in grounding-mcp's orchestrator-workflow
  completeness reader: the reader identifies a real finding row by its
  Severity cell carrying a single concrete value, so the shipped slash-list
  legend row was never counted as a finding — a run that filled the
  `acceptance-recommendation` marker with `accept` but left this row
  byte-for-byte as shipped read as `complete: true` with zero findings,
  indistinguishable from a genuine zero-findings review. The runtime half
  (the reader treating a survived, unaccompanied placeholder row as an
  explicit format blocker instead of silently reporting zero findings) is a
  lockstep sibling change in grounding-mcp's own release, outside this
  package. In this package the change is docs/template/test-only: no
  runtime behavior changes here, the completeness reader itself is not part
  of this package, and the fail-closed enforcement only takes effect once
  grounding-mcp ships its lockstep sibling change (agent-tasks task
  8f173547); do not tag/publish this 0.13.0 release before that change ships
  (release ordering). A template-markers test pins the placeholder row's
  literal wording (mutation-checked, matching the reader's literal match) and
  that the replace/delete rule is documented next to it. Motivated by
  agent-tasks task fa0eca65.

## [0.12.0] - 2026-07-16

### Added

- `SKILL.md`'s Hand off step (9) gains an optional bundle-upkeep hook,
  symmetric to the 0.8.0 discovery-side rule: when the repo carries a
  curated knowledge bundle (for example a `docs/okf/` directory with an
  index), the orchestrator checks before handoff whether the change touches
  paths any bundle doc claims as sources, and if so either updates the
  affected docs (re-verify and re-stamp) or records a follow-up task, and
  runs the bundle validator when one is available (for example `okf-kit
  check`). The hook is optional guidance, never a gate: repos without a
  bundle are unaffected. `06-handoff.md` gained a matching optional
  "Knowledge Bundle" section so the outcome (updated / not affected /
  follow-up filed) is recorded alongside the rest of the handoff. Motivated
  by the OKF initiative's Phase 3 evidence: four upkeep sweeps on 2026-07-16
  found 48/24/11/8 stale claims accumulated in the four oldest bundles, with
  warn-only drift CI already live in 8 repos — discovery-side consumption
  shipped in 0.8.0 and named this hook as its symmetric, still-missing,
  loop-closer. Docs-consistency tests pin the hook's source-overlap check,
  its two responses, the validator run, and its explicit non-gate
  optionality, plus the handoff template's new section and outcome
  vocabulary.

## [0.11.0] - 2026-07-16

### Added

- `SKILL.md` gains a Subagent misfire rule: a subagent return that does not
  parse against its role's output contract is a misfire, not evidence. A
  near-instant return with no tool activity is a misfire signal rather than
  proof: the orchestrator accepts it only when the output is contract-valid
  and the assignment was answerable from the context supplied with it, so
  legitimately tool-free returns (a slicer answering from provided context)
  are not discarded. On a misfire the
  orchestrator resumes or respawns the subagent, never folds the
  non-contract output into run state, and records the misfire in
  `03-decisions.md`. The rule calls out the review case explicitly, since a
  misfired review is not a review and never satisfies the review gate.
  Motivated by a live incident: a reviewer subagent spawn returned in 5
  seconds with 0 tool uses, handing back harness hook-boilerplate instead of
  the reviewer output contract; a resume produced a correct full review. The
  kit previously said nothing about malformed subagent returns, leaving the
  door open to silently accepting a non-review as a passed review gate.
  Docs-consistency tests pin the rule's detection signals, response, record
  location, and review-gate consequence.

## [0.10.0] - 2026-07-16

### Changed

- The task-slicer output schema is now a lossless superset of the subagent
  input contract: each task carries `constraints`, `suggested_tests`,
  `allowed_changes`, `forbidden_changes`, and `relevant_docs` in addition
  to the existing `id`, `title`, `goal`, `relevant_files`,
  `acceptance_criteria`, `dependencies`, and `risk` — every field the
  subagent input contract requires now has a same-named slicer-output
  counterpart. Previously the slicer output contract in `SKILL.md` and the
  installed `task-slicer.md` prompt omitted
  `constraints`/`allowed_changes`/`forbidden_changes` even though the
  implementer input contract and `implementer.md` treat them as
  load-bearing, forcing the orchestrator to invent them when delegating
  implementation instead of copying them from the slice. `SKILL.md` now
  states this 1:1 mapping explicitly next to the contract. `02-tasks.md`
  gained matching **Relevant Docs** / **Allowed Changes** /
  **Forbidden Changes** sections so its sections map 1:1 to the slicer
  output fields. `task-slicer.md`'s rules frame allowed/forbidden changes
  as scope boundaries for the implementer (which files or areas it may and
  must not touch), not as implementation instructions, keeping the slicer
  a planner. Docs-consistency tests pin both output-contract locations
  (including their field-for-field equivalence), the template sections,
  the prose enumerations, and the mapping sentence; the superset check
  derives the required field set from the subagent input contract itself,
  so a field added there cannot silently go missing from the slicer
  output.

## [0.9.0] - 2026-07-16

### Added

- `00-goal.md` now carries a `<!-- solution-acceptance: run-base = TODO -->`
  marker, following the same pattern as the existing final-status and
  acceptance-recommendation markers. grounding-mcp 0.6.0 reads this marker
  to bind run-completeness precisely to the change under review; a run that
  fills it with a valid sha gets an exact binding, a malformed value blocks
  explicitly (7-40 hex guard), and a run that leaves it as `TODO`
  falls back to the tolerant day-granular date heuristic. `SKILL.md`'s Run
  state section now instructs the orchestrator to replace `TODO` with the
  repo HEAD sha (`git rev-parse HEAD`) when creating the run directory,
  before the first implementation commit, and states the consumer
  semantics: the recorded base must resolve in the repo, be an ancestor of
  HEAD, and not lie behind the merge-base with the remote default branch.
  A template-markers test pins the new marker the same way as the existing
  two.

## [0.8.0] - 2026-07-16

### Added

- The explorer role prompt and the skill's Discover step now tell discovery
  to check for a curated knowledge bundle (for example a `docs/okf/`
  directory with an `index.md`) before mapping terrain by hand, reading the
  relevant docs it points to and treating their claims as leads to verify,
  not as ground truth. Both locations also prefer a connected semantic
  code-search tool over raw grep for orientation questions. Wording
  is deliberately tool-agnostic: OKF/`docs/okf/` is named only as an
  example, and semantic search is phrased generically with no dependency on
  a specific MCP tool. Docs-consistency tests pin both locations, including
  a negative pin that no specific tool name is hardcoded.

## [0.7.4] - 2026-07-05

### Changed

- `05-review-findings.md` Decision legend now matches the grounding-mcp
  completeness reader's resolved vocabulary. The example row previously
  invited `accepted/fix/defer/reject`, but the reader's
  `RESOLVED_DECISIONS = {accepted, defer}` treats a high/critical finding
  marked `fix` or `reject` as unresolved, so the gate arms (fail-closed but
  surprising). The example is narrowed to `accepted/defer` and a Decision
  legend comment now spells out that every other value (`fix`, `reject`,
  blank, `open`, `TODO`) arms the completeness gate until resolved. Docs
  only, no runtime behavior change; a template-vocabulary test pins the
  reconciliation. Reader left untouched (its fail-closed design is
  deliberate); this is the single-repo path (a).

## [0.7.3] - 2026-07-05

### Fixed

- `05-review-findings.md` now carries a load-bearing comment above the
  findings table naming the Severity and Decision columns: grounding-mcp's
  orchestrator-workflow completeness reader (0.6.0) locates the table by a
  header row whose cells include both, and fails closed with an explicit
  "not in the expected table format" blocker when a run drifts onto a
  Decision-less convention (a live run had used
  `| Severity | Finding | Resolution |`, which the reader cannot verify).
  The shipped header itself was already correct
  (`| Severity | Category | Description | Suggested Fix | Decision |`); this
  adds the comment plus a one-sentence rule in `SKILL.md`'s review step
  telling the orchestrator to transfer reviewer findings into the table
  as-is, keeping those two headers, and a test pinning the header row so
  the convention cannot silently drift again.

## [0.7.2] - 2026-07-02

### Security

- The read-only explorer and reviewer prompts now carry an explicit Bash
  no-mutation guard: Bash is for tests, linters, and read-only inspection
  only; `git checkout` / `git restore` / `git clean` / `git stash` /
  `git reset`, `sed -i`, and redirecting output into a file are named as
  forbidden, and a
  wrong-looking working tree must be reported (finding / risk) instead of
  "fixed". Background: 0.7.1 made both roles tool-level read-only for
  Edit/Write/NotebookEdit, but Bash necessarily stays available, and exactly
  this residual bit in practice (a reviewer ran `git checkout` and discarded
  uncommitted work). The guard is instruction-level; tests pin its presence
  in the installed output for both harness targets.
- README now states the posture honestly: tool-level for the edit tools,
  instruction-level for Bash, with marker/verdict-style enforcement named as
  harness territory outside this kit's scope. A docs-consistency test pins
  the wording.

## [0.7.1] - 2026-06-24

### Security

- The installed `reviewer` subagent now carries the same read-only tool posture
  as the explorer: `disallowedTools: Edit, Write, NotebookEdit` (Claude Code) and
  `permission: edit: deny` (opencode). Previously only the explorer was
  tool-restricted and the reviewer was restrained by prose alone ("Do not rewrite
  the change yourself"), so a misled or prompt-injected reviewer could edit files
  through the edit tools. The reviewer's job is to judge work without changing it,
  so it is now installed read-only on both harnesses, matching the explorer.
  (Bash is intentionally not restricted by this posture on either read-only role,
  unchanged from before.)

## [0.7.0] - 2026-06-22

### Added

- Machine-readable solution-acceptance status markers in the run templates:
  `06-handoff.md` carries a `<!-- solution-acceptance: final-status = TODO -->`
  line and `05-review-findings.md` carries a
  `<!-- solution-acceptance: acceptance-recommendation = TODO -->` line. The
  orchestrator replaces the `TODO` sentinel with the chosen enum value when
  finalizing the handoff/review. This is the run-gate contract the harness
  solution-acceptance gate reads, so a freshly-copied run is non-accepting by
  construction (fail-closed). SKILL.md documents the finalization step.

## [0.6.0]

### Changed

- Portable opencode model resolution (#62).

## [0.5.0]

### Added

- Instruction trust boundary for the workflow, policy, and agent prompts (#55).

## [0.4.0]

### Added

- Read-only explorer/discovery role (#52).

## [0.3.0]

### Added

- Proportionality rule for delegation (#51).

## [0.2.0]

### Added

- Target-directory transparency and an `uninstall` command (#50).

## [0.1.0]

### Added

- Initial `orchestrator-workflow` package: `.ai/` run state, an `AGENTS.md`
  policy section, and per-harness subagent definitions (#47).
