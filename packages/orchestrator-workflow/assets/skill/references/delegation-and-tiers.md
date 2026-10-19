## Delegation, tiers, and models

AGENTS.md states who orchestrates, the run modes, and that review is never
skipped. This reference holds how the orchestrator picks effort tiers, names a
review method, uses the advisor, and treats models. Read it before spawning a
subagent whose tier you choose, before naming a `review_method` in a reviewer
briefing, before spawning the advisor, and before changing a model.

### Effort tiers

- When tier variants are installed (manifest `tiers: true`), the orchestrator
  picks the effort tier per task by complexity and risk, at its own judgment.
  The unsuffixed default subagent is the normal case; `-high`/`-xhigh` fit
  high-risk changes, hard problems, or repeated failed attempts. Record a
  non-default tier choice with a one-line reason in `03-decisions.md` when
  the task is non-trivial.
- For the implementer specifically, `-low` is spawned only when none of the
  following hold: an acceptance criterion demands a test, typecheck, lint, or
  build run; the task assignment names mutation probes to run; or the task
  slicer's `suggested_tests` came back non-empty. This is checkable against
  the task contract rather than a judgment about how hard the task looks: any
  one of those three excludes `implementer-low`, and the task runs on the
  unsuffixed implementer or higher, even when the change looks mechanical (a
  bugfix included); when it is unclear whether a criterion demands a run,
  exclude `implementer-low`. This rule is anchored by an A/B measurement; the
  data and the model caveat are recorded in the orchestrator-workflow
  CHANGELOG (0.23.0).
- For the explorer and the task-slicer, a `-low` variant still suits
  narrowly scoped, mechanical work; no equivalent measurement exists for those
  two roles, so their rule is unchanged.
- Not every role gets every tier: `-xhigh` exists only for the implementer,
  the reviewer, and the advisor. The reviewer's downshift is `-medium` rather
  than `-low`, since its default already sits at high. The advisor has no
  downshift at all: its default `high` is already its only non-`-xhigh` tier.
  Spawn only variants that are actually installed. Tier choice is a conscious
  decision, not a ritual; when unsure, use the default.
- Every unsuffixed default subagent carries its own pinned default effort
  baked into its own file, not inherited from the orchestrator session:
  medium for the explorer, the task-slicer, and the implementer; high for
  the reviewer and the advisor. This holds whether or not tier variants are
  installed; it is not gated on `--tiers`.

### Review method and reviewer tier by risk class

Every reviewer briefing names a `review_method`: `normal | rigorous |
adversarial`, an obligation set orthogonal to the effort tier. This section is
the one place that maps a change class to a method and a reviewer tier; every
other file points here.

- `adversarial`, on the unsuffixed reviewer (high) or `reviewer-xhigh`:
  security judgment, sandbox or isolation code, installers and install or
  deploy scripts, hand-edited lockfiles, cross-major overrides, a change to
  the safety rules the repository declares as its core, and anything the
  operator flags high-risk.
- `rigorous`, on `reviewer-medium`: all other code changes, tests and CI or
  configuration that changes behaviour included, and all other changes to
  instruction, prompt, template, or policy files.
- `normal`, on `reviewer-medium`: a delta that contains only explanatory
  documentation, comments, or citations and contains no source- or test-file
  edits and no semantic change to executable commands, configuration, policy,
  instructions, or behavior. Explanatory prose in an instruction file that
  changes no instruction semantics counts as documentation; a change to what
  an instruction demands is an instruction change and takes the row its
  content belongs to.

The rules that apply to the three rows:

- Never pair `adversarial` with the `-medium` reviewer tier, a budget mismatch
  that names probes without the effort to run them; tiers themselves are
  unchanged by this axis.
- Where tier variants are not installed, the unsuffixed reviewer runs with the
  same method mapping.
- The orchestrator classifies the delta and records the class in the
  briefing. A delta that spans classes takes the method and tier of its
  highest class, and a doubt between two classes goes to the higher one.
- Fix and delta rounds of a task keep the task's class: a round never drops
  below the highest class an earlier round of the task was given, whatever
  its own delta contains.
- The operator's high-risk flag can only raise a class to `adversarial`; it
  never lowers one.
- The safety core is declared per repository, as Pinned-prose changes in
  [review and recovery](review-and-recovery.md) says. The rules this kit
  installs for the instruction trust boundary (runbook authority included),
  outward actions, the review gate, and the reviewer's read-only rule belong
  to that core wherever the kit is installed.

### Advisor

Under the `full` profile, an advisor subagent is available for escalation
only: architectural uncertainty, requirements that contradict each other,
multiple valid solution paths where committing to one is expensive to
reverse, repeated implementation failures on the same task, a review
deadlock, or a high-risk decision. The orchestrator spawns it only at one
of these triggers, never as a standard pipeline step; using it is a
judgment call, the same discretion already used for tier choice. The
advisor returns a recommendation with options, pros, cons, and risk; the
orchestrator still decides, and a critical risk still goes to the
operator. When tier variants are installed, pick the advisor tier by the
same complexity-and-risk judgment, defaulting to the unsuffixed subagent
(already effort `high`) when unsure.

### Models

- The orchestrator runs on the session's main model. Use the strongest
  reasoning model available.
- Per-role and per-tier model/effort selections (explorer, task slicer,
  implementer, reviewer, advisor) are recorded in
  `.ai/workflow/manifest.json` and in the harness subagent definitions. The
  manifest also records the installed kit version, the chosen harnesses, and
  the legacy model preferences.
- Preserve recorded routing choices across re-installs. Change a model only
  through a deliberate role/tier override; never treat a newer model as an
  automatic upgrade. The prior routing is the rollback input.
