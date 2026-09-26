# Role profile reference

Detail behind the `--profile` table in the [package README](../README.md):
what the advisor role is for, and exactly what happens on a profile or tier
change across re-runs.

## Advisor (escalation)

The fifth `full`-profile role, `advisor`, is read-only and consulted only
when the orchestrator hits one of a defined set of triggers: architectural
uncertainty, requirements that contradict each other, multiple valid solution
paths where committing to one is expensive to reverse, repeated
implementation failures on the same task, a review deadlock, or a high-risk
decision. It is not a standard pipeline step; like tier choice, spawning it
is the orchestrator's own judgment call. The advisor lays out the options
with their pros, cons, and risk, and gives a recommendation; it recommends,
never decides, and never writes code; the orchestrator still decides, and a
critical risk still goes to the operator. `minimal` never installs it, the
same as explorer and task-slicer.

## Re-runs and profile changes

A plain re-run (no `--profile` flag) keeps the profile recorded in
`.ai/workflow/manifest.json` from the previous install, the same
override-vs-persist rule already used for `--harness` and `--models`.
Passing `--profile` explicitly always overrides the recorded value,
immediately switching which per-role files the next run installs and
updating the manifest to match. Switching profiles follows the same
precedent already in place for dropping a harness from `--harness` on a
re-run: files for roles no longer in the profile are simply no longer
installed or tracked in the manifest; they are not automatically deleted
from disk. `init` detects a `full` -> `minimal` downgrade and prints a note
naming the now-untracked `task-slicer.md` / `explorer.md` / `advisor.md`
agent files and how to remove them. For a fully clean switch, run
`orchestrator-workflow uninstall` first, or remove those files by hand.
Uninstalling a `minimal` install that has never been downgraded from `full`
is always clean on its own: it only ever removes what it actually installed,
so there is nothing to report as missing for the roles that were never
written. A `minimal` install reached via a `full` -> `minimal` downgrade is
not clean in that sense: the downgrade's now-untracked
`task-slicer.md` / `explorer.md` / `advisor.md` files are not in the
manifest's file ledger, so uninstall leaves them on disk without reporting
them at all.

The same override-vs-persist and downgrade-note rules apply to `--tiers`
(rendering the additional `<role>-<tier>.md` variant files); see [Model
routing reference: Effort tiers](model-routing-reference.md#effort-tiers)
for the full role/tier table.
