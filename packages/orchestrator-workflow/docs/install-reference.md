# Install reference

Details behind the install commands in the [package README](../README.md):
what the agent-led installer's conflict check does, the exact rules for
`--harness none` (templates-only mode) on a re-run, the optional
`knowledge` manifest field for a repository whose bundle is not at the
default location, and the file-ownership rules a re-run follows.

## Agent-led installation: bundle and conflict handling

The compact skill entrypoint and its routed references form one installed
bundle. On a reinstall, the installer checks the core and every required
reference for local conflicts before activating a new core; it leaves the
current coherent bundle intact unless an explicitly authorized `--force` run
replaces the affected files.

## Templates-only mode (`--harness none`)

`--harness none` (the literal word `none`, on its own) installs only
`.ai/workflow/**` and `.ai/runs/.gitkeep`: no `AGENTS.md`, no `CLAUDE.md`, no
harness-specific directory, and a manifest recording `harnesses: []`. Use it
for a repo that wants the run-state templates and the workflow itself, but no
per-harness subagent files yet (e.g. no harness has been chosen, or the files
were dropped by hand). `none` combined with a real harness name
(`--harness none,claude`) is rejected as ambiguous rather than silently
picking one. A plain **non-interactive** re-run (no `--harness` flag) after a
templates-only install stays templates-only, for `init` and `apply` alike,
even when `apply`'s own operator-defaults name a harness or the target has
harness files on disk from something else; add a harness back with an
explicit `--harness <list>` on a later run, the same explicit-flag-wins rule
`--profile`/`--models`/`--tiers` use, applied to the no-harness case. An
**interactive** re-run is different: it still prompts, with nothing forced
pre-selected, instead of silently skipping straight back to templates-only
without asking; deselect every checkbox to stay templates-only. `init` and
`apply` both pre-check nothing at all on this prompt, and both still
annotate what is detected on disk with a " (detected)" label; select a
harness to install it.

```bash
npx orchestrator-workflow init --harness none --yes
```

## The `knowledge` manifest field

`manifest.json` may also carry a `knowledge` list of `{ path, repoRoot }`
entries, for a repo whose knowledge bundle is not at the default location (a
workspace-level bundle with sources in a sub-repo, a bundle elsewhere, or
several bundles). `path` is the bundle directory and `repoRoot` (default
`"."`) the root of the repository the bundle's sources live in. Each is a
relative path resolved against the worktree top level on its own (`path` is
not nested under `repoRoot`), so a workspace bundle for a sub-repo's sources
reads `{ "path": "kb/app", "repoRoot": "app" }`. Entries are stored
normalised (`./kb/app/` becomes `kb/app`); an empty or absolute path
(POSIX, or a Windows form such as `C:/x`), any other path starting with a
Windows drive letter (the drive-relative `C:x` or `C:..`), a `path` of `.`, a
path escaping the worktree top level, and any path containing a backslash are
invalid (use `/` as the separator on every platform). The absolute, drive and
escape rules apply both as written and to the normalised value that is stored,
so `./C:x` and `docs/../C:/x` are invalid too. The CLI has no flag for the
field: edit it in the manifest by hand, and every re-install preserves its
valid entries (the programmatic `runInit` option `knowledge` writes it and
refuses an invalid entry). A hand-edited invalid entry is ignored on read
and reported by `doctor`; a re-install that rewrites the manifest removes it
from disk and prints a note naming its index and reason. The field carries no
check argv; the concrete bundle-check command still lives in the
repository-bound verification set (see the README's Verification sets
section), so there is one source of argv truth. When `knowledge` in
`.ai/workflow/manifest.json` is absent or an empty list, the default
`docs/okf/` applies, today's behaviour. `doctor` prints a `knowledge:`
detail line (the `knowledgeWarnings` key in `--json`) for a configured
`path` or `repoRoot` that is not a directory, for each ignored invalid
entry, and when a non-empty list omits an existing default bundle directory.
These warnings never change the status or the exit code.

## Ownership and re-runs

`init` is idempotent: a second run changes nothing. `apply` installs
through that same `runInit` path and is subject to the same
conflict/`--force`/ownership rules; on the repository side it changes
nothing either, but it refreshes this target's entry in the operator
manifest on every run. The rules:

- `AGENTS.md` and `CLAUDE.md` belong to you. The installer only appends its
  fenced section or the import line, and on re-run replaces only the content
  between its own markers. A broken or duplicated marker fence is reported as
  a conflict and left alone.
- Templates, skills, and subagent definitions are kit-owned. The manifest
  records a hash of each file as installed, so a re-run after a kit upgrade
  updates files you never touched and reports files you edited as conflicts
  instead of overwriting them; `--force` overwrites those too.
- `.ai/workflow/manifest.json` is the kit's state file. It records the applied
  version, harnesses, role profile, models, the `--tiers` flag, the optional
  kit-version pin, and file hashes, and is rewritten whenever that state
  changes; do not edit it by hand.
