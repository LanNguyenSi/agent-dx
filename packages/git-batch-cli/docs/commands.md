# Command reference

## `sync`

Checks all repositories on one level, skips dirty repositories by default, switches to the protected branch, and pulls with fast-forward only.

```bash
git-batch sync ~/git
git-batch sync ~/projects
git-batch sync ~/git --only api,worker
git-batch sync --protected main,develop --dry-run
```

Default `sync` flow: `git fetch --all --prune`, detect the protected target branch, switch to it if the worktree is clean, then `git pull --ff-only`. Dirty repositories are skipped unless `--include-dirty` is passed. If `--protected` is given, that explicit branch order takes precedence over `origin/HEAD`; explicitly configured protected branches must exist on `origin` (local-only branches are not selected as pull targets).

## `status`

Shows the current branch, detected target branch, upstream tracking branch, ahead/behind distance, and change counters for every repository.

```bash
git-batch status ~/git
git-batch status ~/git --fetch          # fetch first so distances reflect origin now
git-batch status ~/git --fetch --json   # structured output for scripts / agents
```

Per-repo JSON fields added beyond the base shape:

- `upstream`: the tracking branch name (e.g. `origin/master`), or `null` when the current branch has no upstream configured (new local branch, detached HEAD).
- `ahead`: commits on the current branch not yet on the upstream. `null` when there is no upstream.
- `behind`: commits on the upstream not yet on the current branch. `null` when there is no upstream.

`ahead`/`behind` are computed against the **local** copy of the upstream ref. Without `--fetch` they can be stale, the check is only as fresh as the last `git fetch`. Pass `--fetch` (or run `git-batch fetch ~/git` beforehand) to force a refresh.

### `--fetch` error handling

`--fetch` runs `git fetch --quiet` per repository. If a single repo's fetch fails (network error, unreachable remote, bad credentials), its entry is tagged `outcome: "fetch_failed"` but the batch continues. The remaining status fields still come from whatever refs happen to exist locally, so you get partial information instead of a hard stop.

A repo with no remote configured at all is not a fetch failure: `git fetch --quiet` exits 0 silently, and `outcome` stays `ok`.

### `--fetch` performance

`--fetch` runs repository fetches with a bounded parallel pool (default concurrency: **8**). On large trees this keeps status fresh enough for hook-driven workflows without changing the per-repo result shape.

### Text output shape

The plain-text `status` row inserts the new columns between `target=…` and `clean=…`, it is not a pure append:

```
<repo>: branch=X target=Y upstream=U ahead=D behind=E clean=Z staged=… unstaged=… untracked=… [outcome=F]
```

The `-` sentinel is reused for `upstream=-`, `ahead=-`, `behind=-` when the current branch has no upstream. Scripts using `key=value` parsing are unaffected; scripts that index columns positionally should switch to `--json`.

## `dirty`

Shows only repositories that currently have local changes.

```bash
git-batch dirty ~/git
```

## `fetch`

Runs `git fetch --all --prune` for each repository.

```bash
git-batch fetch ~/git
```

## `branches`

Shows the current branch and the detected protected branch for each repository.

```bash
git-batch branches ~/git
```

## `list`

Lists all discovered repositories on the current level.

```bash
git-batch list ~/git
```

## Options

- `--root <path>`: explicitly set the root folder to scan (defaults to cwd)
- `--protected <a,b,c>`: define preferred protected branches
- `--only <a,b,c>`: include only matching repository names
- `--exclude <a,b,c>`: exclude matching repository names
- `--include-current`: include the current folder if it is a Git repository itself
- `--include-hidden`: scan hidden child directories as well
- `--include-dirty`: allow `sync` to continue even when a repository has local changes
- `--strict`: return a non-zero exit code for actionable problem states
- `--dry-run`: print planned Git commands without executing them
- `--json`: emit JSON instead of plain text
- `--fetch`: for `status`, run `git fetch --quiet` per repo before computing ahead/behind

## Repository filters

`--only` and `--exclude` apply to all commands.

- plain values are treated as case-insensitive substring matches
- regex literals are supported in JavaScript form, for example `'/^api-/'`
- multiple patterns are comma-separated

Examples:

```bash
git-batch status ~/git --only api,worker
git-batch dirty ~/git --exclude legacy,archive
git-batch sync ~/git --only '/^(api|web)-/' --exclude '/-sandbox$/'
```

## Branch detection

Target branch detection uses this order:

1. explicit `--protected` order, if provided
2. `origin/HEAD`
3. first matching branch from `main, master, develop, dev, staging, production, trunk`

## Output model

The CLI reports, per repository: current branch, detected target branch, whether the worktree is clean, and counts for `staged`, `unstaged`, and `untracked`. This makes it easier to spot repositories that would be skipped by `sync`.

## Agent and automation use

The CLI is safe for non-interactive use and keeps repository ordering deterministic.

For agents and CI jobs, prefer:

```bash
git-batch status /path/to/workspace --json --strict
git-batch dirty /path/to/workspace --json --strict
git-batch sync /path/to/workspace --json --strict --dry-run
```

Why this works well:

- `--json` returns structured output with `command`, `root`, `repoCount`, `exitCode`, and `results`
- `--strict` turns actionable states into a non-zero exit code
- no interactive prompts are required
- output order is stable because repositories are sorted by name

Recommended interpretation:

- `status --json --strict`: fail if any repository is dirty
- `dirty --json --strict`: fail if any repository has local changes
- `sync --json --strict`: fail if any repository is skipped or errors

With `--strict`, an empty result set stays exit code `0`. This keeps filtered runs such as `--only` stable for automation.

## Open source files

This repository includes the usual project governance files: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.

## Roadmap

Not yet implemented; no scheduled milestone:

- support for a workspace config file such as `.git-batch.json`
- optional parallel fetch/pull execution with a configurable concurrency limit
- an optional confirmation prompt before batch `sync` without `--dry-run`
