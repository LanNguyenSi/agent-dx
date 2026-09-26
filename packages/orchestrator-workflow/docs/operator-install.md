# Operator-level install

See the [package README](../README.md) for the single-repository `init` /
`uninstall` commands this layer sits alongside.

Alongside `init`, which installs the kit into one repository from that
repository's own working directory, an operator who maintains many
repositories can set defaults once and project them onto each target
instead of re-answering the same prompts per repo. This layer adds no new
binary: `setup`, `apply`, `doctor`, and `adopt` below are subcommands of the
same `orchestrator-workflow` CLI `init` and `uninstall` already ship as, and
`init`/`uninstall` remain fully supported and unchanged for a
single-repository install.

```bash
orchestrator-workflow setup --yes
orchestrator-workflow apply --target /path/to/repo
```

**`setup`** writes or updates this operator's default install options
(harnesses, profile, legacy models, routing, tiers) as the baseline for future installs; it
touches no repository. A flag always wins; a flag-less re-run keeps the
previously stored values; a first-ever `setup` falls back to `claude` /
`full` / the kit's default routing / tiers off. `setup` takes the same
option flags as `init` (`--harness`, `--profile`, `--models`, `--routing`,
`--codex-catalog`, `--tiers` / `--no-tiers`, `--opencode-provider`, `--yes`).
The defaults live in
`<operator home>/manifest.json`, where the operator home is
`~/.orchestrator-workflow/` unless the `ORCHESTRATOR_WORKFLOW_HOME`
environment variable names a different directory.

**`apply --target <repo>`** projects the operator's install onto a target
repository and registers that target, by its real resolved path, in the
operator manifest. It requires a prior `orchestrator-workflow setup`;
without one it exits `1` with "No operator setup found". Option resolution
follows one precedence order: an
explicit flag wins, then the target's own previously recorded settings,
then the operator's defaults (harnesses fall back one step further, to
what `init` would have auto-detected) -- except a target whose own
manifest recorded a real `harnesses: []` (a deliberate templates-only
install, see [Install reference](install-reference.md)'s "Templates-only
mode"), which stays templates-only on
a flagless run regardless of the operator's defaults or what is on disk;
an **interactive** re-run on such a target still prompts, with the same
nothing-pre-checked behaviour described there
(it applies identically to `apply`).
Pass `--sync` to invert that for
profile, tiers, legacy models, and routing: the operator's defaults then win over whatever
the target already had recorded. A target pinned to a kit version other
than the one being applied is skipped rather than touched (see the pin
rule below). `apply` also takes the same install options as `init` (`--harness`,
`--profile`, `--models`, `--routing`, `--codex-catalog`, `--tiers` /
`--no-tiers`, `--opencode-provider`, `--force`, `--yes`), which feed the
precedence rule above. An explicit routing file is the highest-precedence
deep patch; leaves it omits retain their resolved baseline values.

**`doctor [--json] [--prune]`** reports every operator-registered target's
status: `clean`, `divergent` (from the operator defaults, including routing), `version-lag`,
`drift` (installed files edited, deleted, or unreadable since install),
`missing`, `no-manifest`, or `unverifiable`. It exits `2` when the operator
manifest is missing or unreadable, or, with `--prune`, when the operator
manifest lock cannot be acquired or the rewrite fails; `1` when any target
is `drift`, `missing`, `no-manifest`, or `unverifiable`; and `0` otherwise.
`--json` prints one JSON object instead
of human output, with one entry per target plus the operator home and
version. `--prune` removes `missing` and `no-manifest` targets from the
registry before reporting (never an `unverifiable` one, since that status
means the check itself was inconclusive, not that the target is confirmed
gone) and rewrites the manifest file in its normalized form.
For a legacy opencode leaf without a recorded provider-qualified model id,
doctor reports `Routing comparison incomplete` and includes
`routingComparisonGaps` in JSON instead of declaring a false routing
divergence. The gap alone does not change the target status.

**`adopt [dir] [--json]`** brings a repository that already has the kit installed,
by hand or by an earlier `init`, under the operator's management without
changing anything in that repository: it registers the repository
verbatim, using the repository's own recorded settings to bootstrap the
operator manifest when none exists yet, records the repository's own
installed version as its baseline, and prints that one target's `doctor`
report. It exits `1` only when the freshly adopted target itself reports
drift, and `2` for a precondition failure (no repo manifest, an unreadable
or foreign manifest, or a lock or write failure).

**The kit-version pin.** A repository's own manifest can additionally
carry an optional `pin`: a kit version that `apply` must match before it
will touch that repository again. `apply` skips (exit `0`) a target pinned
to a different version than the one being applied. `--pin <version>` sets
or replaces the pin and applies regardless of any existing one; `--unpin`
clears it and applies; `--force-pin` advances an existing pin that
differs, but has no effect on a target with no pin recorded (it stays
unpinned). `doctor` reports `version-lag` when the installed version
differs from the running kit version; on a pinned target the pin is
compared against the installed version instead, so a pin equal to the
installed version is `clean` and a pin that no longer matches it is
`version-lag`.

**The registry is implicit**, not a separate command: `apply` and `adopt`
register a target as a side effect of a real run, and `doctor --prune` is
how a registry entry is removed again; there is no bare register or
unregister command. The workspace root of a multi-repo checkout is treated
as an ordinary target, nothing special.

All writes to the operator manifest, by `setup`, `apply`, `doctor --prune`,
and `adopt` alike, go through one advisory lock in the operator home, so
concurrent orchestrator-workflow commands on the same machine cannot
corrupt each other's state.

`apply` shares the file-ownership rules `init` uses; see the [package
README](../README.md)'s Ownership and re-runs section.
