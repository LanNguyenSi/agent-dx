# `worktree`

Creates, reports and removes linked git worktrees for task branches. Part of the [agent-primitives](../README.md) CLI. This page covers `worktree create`, `worktree remove` and `worktree list`; everything above the `## remove` heading documents `create`.

Before delegating a task, an orchestrator typically makes a worktree on a fresh branch, points it at the run directory, links the dependency directories that are too big to reinstall, and checks that the result runs. Done by hand that is a dozen commands, and each has a known way to go wrong: a relative path resolved against `git -C <repo>` puts the worktree inside the repository, a branch started from `origin/<default>` inherits that branch as its upstream (a bare `git push` then aims at the default branch), and the run pointer gets written where git does not ignore it. `worktree create` does the whole sequence, refuses what is unsafe, and reports everything a run record needs in one envelope.

```bash
agent-primitives worktree create --repo ~/src/app --branch fix/login --run ~/work/runs/login-fix
agent-primitives worktree create --repo ~/src/app --branch fix/login --base origin/develop \
  --path ~/wt/app-login --links-from ~/.config/app-links.txt \
  --setup 'composer dump-autoload' --smoke 'vendor/bin/phpunit --testsuite smoke' --pass-regex '^OK \('
```

## What it does

In this order:

1. Validates the options and every precondition below. A refusal changes nothing.
2. Fetches `origin` (unless `--no-fetch`). This updates remote-tracking refs only.
3. Resolves the base: `--base`, or `origin/<default branch>`.
4. Runs `git worktree add --no-track -b <branch> -- <path> <base>` from the main checkout.
5. Writes the `.ai/run` pointer (with `--run`), when git ignores that path.
6. Creates the dependency links and excludes them.
7. Runs `--setup`, then `--smoke`.

Steps 5 to 7 never undo the worktree: what did not work is reported in the envelope, and the worktree stays.

The main checkout is never switched, reset or stashed, and `git stash` is not used at all. Its HEAD, index, working tree and stash are the same before and after (the test suite asserts this on a checkout that has all four in use).

## Options

| Option | Meaning |
| --- | --- |
| `--branch <name>` | Required. The new branch. It must not exist yet. |
| `--repo <path>` | Repository to branch from. Defaults to the invocation directory (`-C`). May be the main checkout, a subdirectory, or a linked worktree; the main checkout is found through git. |
| `--base <rev>` | Start point of the branch: any revision that names a commit (`origin/develop`, a tag, a sha). Default: `origin/<default branch>`, read from `origin/HEAD`, else `origin/main`, else `origin/master`. An explicit local branch name is used as it is, not fetched ahead of time. |
| `--path <dir>` | Exact worktree directory. |
| `--root <dir>` | Directory to create `<branch>` in; the directory is named after the branch with every character outside `A-Za-z0-9._-` replaced by `-` (`feat/one` becomes `feat-one`). Exclusive with `--path`. |
| `--run <dir>` | Run directory. Its absolute path is written, followed by a newline, to `.ai/run` in the worktree, but only when `git check-ignore --no-index` says `.ai/run` is ignored there. The directory must exist. |
| `--link <rel>` | Repository-relative path to symlink from the main checkout into the worktree. Repeatable, and comma-separated values are split. |
| `--links-from <file>` | File with one link path per line; blank lines and `#` comments are ignored. It is operator configuration and must live outside the repository. Merged with `--link`; duplicates are made once. |
| `--setup <cmd>` | Shell command run in the worktree after the links exist (`sh -c`). A non-zero exit makes the result `fail`. |
| `--smoke <cmd>` | Readiness check run in the worktree after setup. Its result is `ready` or `not_ready`. Skipped, as `not_run`, when setup failed. |
| `--pass-regex <regex>` | With `--smoke`: the verdict comes from the pattern instead of the exit code, exactly as in [`verify`](verify.md): a match on the combined stdout and stderr is `ready` and no match is `not_ready`, whatever the exit code says. The pattern gets the `m` flag, so `^` and `$` anchor per line. A run that never concluded (timeout, exit 126 or 127, a kill) is `not_ready` and the pattern is not consulted. |
| `--no-fetch` | Do not fetch `origin`; branch from the refs as they are. |

Relative `--path`, `--root`, `--run`, `--links-from` and `--repo` values resolve against the invocation directory (`-C`, or the process directory), never against the repository. The reported worktree path is always absolute.

Defaults when neither `--path` nor `--root` is given: `<parent of the main checkout>/<repo>-worktrees/<branch dir>`.

The fetch has a fixed two-minute limit. `--setup` and `--smoke` have none; SIGINT and SIGTERM stop them.

## Links

Each link is a symlink at `<worktree>/<rel>` pointing at the absolute path `<main checkout>/<rel>`. A link entry must be relative, must not climb out with `..`, and must not be `.git` or below it; such an entry is a `link_invalid` refusal, before anything is created.

Per entry, after the worktree exists:

- The source must exist in the main checkout, else the entry is skipped as `source_missing`.
- The destination must not exist (`destination_exists`, for instance a tracked path) and no existing parent of it may be a symlink or a non-directory (`parent_is_symlink`, `parent_not_directory`), so nothing is ever written through one link into the main checkout. Missing parent directories are created.
- Once the link exists, git is asked whether it ignores the path (`git check-ignore --no-index`). If it does not, `/<rel>` (glob characters escaped) is appended to `info/exclude` of the repository's common git directory, which every worktree shares. A directory-only pattern such as `vendor/` does not cover a symlink, which git treats as a file, so the line is added in that case too.

The exclude line lives in the common git directory, not in the new worktree, so it also applies to the main checkout and stays in place after the worktree is removed.

### Link manifest

When at least one link was made, `create` records them in
`agent-primitives-links.json` inside the new worktree's git administration
directory (`<common git dir>/worktrees/<id>/`), never in the working tree: a
JSON object with `version` (`2`), `toolVersion` and `links`, each link
carrying its repository-relative `path`, the absolute `target` it points at,
`createdAt`, and the resolved identity of the target as `create` saw it
(`resolved`, its `realpath`, and its device and inode as `dev` and `ino`).
The file is created exclusively with mode 0600. [`probe`](probe.md) run in
that worktree reads it and treats each link that still stands as recorded
like a `--link`, so a plan from the run directory needs no extra flag; a
link that has been replaced or retargeted since, or whose target now leads
to a different directory (the main checkout swapped what the path resolves
to), is not trusted; the recorded device and inode may miss a directory
deleted and recreated at the same path where inode numbers are reused. The trust rule, the checks on the file (`O_NOFOLLOW`
where the platform supports it, owner and mode on POSIX only) and why it
lives outside the working tree are in probe.md under "Links recorded by
`worktree create`".

`git worktree remove` deletes the administration directory, and the manifest
with it. Nothing is written when no link was made. A failed write is a
warning and `links.manifest.status: "failed"`; the worktree and its links
stay, and `probe` then needs `--link` for them. A link whose path the
reader would reject (for example one containing a backslash) is still made
but left out of the manifest, listed under `links.manifest.unrecorded` with
a warning, and the other links are recorded as usual.

A link whose target does not resolve (a dangling symlink in the main
checkout) is made but not recorded either. It is listed under
`links.manifest.unrecorded` when the other links are written; when no link
can be recorded, the manifest status is `failed` and nothing is recorded.
Probe refuses a missing source, so create the target in the main checkout
first and then pass `--link`.

The result lists `links.made` (`path`, `target`, `exclude`: `added`, `already_ignored` or `failed`), `links.skipped` (`path`, `reason`, `detail`) and `links.manifest` (`status`: `written`, `not_needed` or `failed`, with `path` or `reason`, and `unrecorded`: `path` and `reason` of each link left out of a written manifest).

## Result

The usual [envelope](output-shape.md) with `command: "worktree create"`, plus:

| Field | Meaning |
| --- | --- |
| `worktree` | `path` (absolute), `branch`, `repo` (basename of the main checkout), `mainCheckout`, `head` (sha the worktree is at). |
| `base` | `ref` as passed to git, `sha`, `source` (`flag` or `default`), and for a default base `detail` naming where it was read from. |
| `fetch` | `status` `fetched` or `skipped`, with `reason` (`--no-fetch`, or no `origin` remote). |
| `upstream` | `null` when the branch tracks nothing, which is the expected value. A warning is added otherwise. |
| `runBase` | A ready-made line for a run record: `run-base[<repo>] = <sha>`. |
| `pointer` | `status` `written`, `skipped` (with `reason`) or `not_requested`, and the `path`. |
| `links` | `made` and `skipped`, as above. |
| `setup` | `status` `ok`, `failed` or `not_requested`, with `command`, `exitCode`, `timedOut`, `durationMs`, `logPath`; a failure adds `reason` and `outputTail`. |
| `smoke` | `status` `ready`, `not_ready`, `not_run` or `not_requested`, with the same fields and `passRegex` when set. |

`status` is `ok` (exit 0), or `fail` (exit 1) when setup failed or the smoke check is `not_ready`. In both cases the worktree exists.

## Refusals

A refusal is `status: "usage_error"` (exit 2) with a `reason`, a `message`, and for some reasons `details`. Nothing was created or changed, except that a `fetch_failed` or `worktree_add_failed` reports git's own failure.

| `reason` | Cause |
| --- | --- |
| `not_a_git_repo` | `--repo` does not exist or is not inside a git working tree. |
| `bare_repository` | The repository is bare; there is no main checkout to branch from. |
| `branch_invalid` | The name is not a valid branch name. |
| `branch_exists` | The branch already exists. This command only creates branches. |
| `branch_checked_out` | The branch is checked out in a worktree (the main checkout included); the message and `details.worktree` name it. A stale entry is marked `prunable`. |
| `target_exists` | The target path exists, whatever it is. |
| `target_inside_checkout` | The target lies inside the main checkout, however its path is spelled (symlinks and letter case on a case-insensitive volume included). |
| `target_inside_worktree` | The target lies inside another working tree of the repository: the linked worktree `--repo` points into, or any registered worktree that git does not list as prunable (a locked entry counts even when its directory is missing). `details.worktree` names it. |
| `path_and_root_conflict` | Both `--path` and `--root` were given. |
| `base_not_found` | `--base` does not name a commit (or starts with `-`). |
| `default_branch_unresolved` | No `--base`, and `origin/HEAD`, `origin/main` and `origin/master` all fail to resolve. Pass `--base`. |
| `fetch_failed` | `git fetch origin` failed. Pass `--no-fetch` to go on with the refs as they are. A repository with no `origin` remote skips the fetch with a warning instead. |
| `run_dir_missing` | `--run` is not an existing directory. |
| `link_invalid` | A link entry is unusable (see Links). |
| `links_file_unreadable` | `--links-from` cannot be read. |
| `links_file_inside_repo` | `--links-from` lies inside the repository, however its path is spelled (as for `target_inside_checkout`). |
| `option_invalid` | `--pass-regex` without `--smoke`, or an empty `--setup` / `--smoke`. |
| `worktree_add_failed` | `git worktree add` itself failed; the message carries git's error. |

## remove

```bash
agent-primitives worktree remove ~/wt/app-login
agent-primitives worktree remove ~/wt/app-login --delete-branch --require-merged
```

One positional `<path>`: the worktree to remove. A relative value resolves against the invocation directory (`-C`), never against the repository.

| Option | Meaning |
| --- | --- |
| `--force` | Remove the worktree even when it is dirty, has commits no remote branch has, is locked, or (with `--require-merged`) is not merged or its merge state cannot be told. The three structural refusals stand regardless: `not_a_worktree`, `remove_main_checkout` and `default_branch_delete`. |
| `--delete-branch` | Delete the worktree's branch after the worktree is gone. |
| `--require-merged` | Refuse unless the branch is merged into `origin/<default branch>`, by ancestry or by a merged pull request that `gh` reports as merged into the default branch at the worktree's HEAD commit. |
| `--base <rev>` | Run the merge check against a remote-tracking branch instead of origin's default branch, for a branch whose pull request targets another one (`origin/master` for a hotfix in a repository whose default branch is `develop`, say). `<rev>` is `<remote>/<branch>` or `refs/remotes/<remote>/<branch>` of a configured remote; it is resolved once, in the main checkout, to the full ref, and the check runs against that ref. The `gh` lookup uses the branch part after `<remote>/` as the pull request's base (`upstream/master` and `refs/remotes/origin/master` both give `master`). Anything else (`HEAD`, `HEAD~1`, `@{u}`, rev syntax after a valid prefix such as `origin/x@{1}`, `origin/x~1`, `origin/x^` or `origin/x^{commit}`, a local branch, a sha, a tag, an option-like value, a remote's `HEAD`) is a `base_not_remote_branch` refusal, even with `--force`, because a verdict against a local or relative base must never excuse commits no remote has. A remote-tracking `<rev>` that does not exist is `base_not_found`. Both refuse before anything is removed. It only changes the merge check, so it needs `--require-merged` or `--delete-branch`: alone it is an `option_invalid` refusal, because a flag that silently changes nothing hides a mistake. The default-branch protection of `--delete-branch` still names origin's default branch. |

### What it does

In this order, with every check that can refuse before the first change:

1. Resolves `<path>` and finds it among `git worktree list` entries.
2. Refuses the main checkout, and a locked entry without `--force`.
3. Nested worktree check: refuses when another registered worktree of the repository lies inside `<path>`, however its path is spelled, since `git worktree remove` would take that checkout and its uncommitted work with it. A prunable entry whose directory is gone does not count, since it has nothing inside to lose; a prunable entry whose directory is still there does.
4. Submodule check: refuses a work tree that has a `.gitmodules` file without `--force`, which is what git itself cannot remove either. The check runs before the links are unlinked, so nothing is half-changed.
5. Dirty check: `git status --porcelain --untracked-files=all`. Ignored paths are invisible here, which is what lets a worktree with its `.ai/run` pointer and its dependency links be removed without `--force`. A status that fails (non-zero, or a git that could not start) is the `status_unknown` refusal, never a clean reading.
6. Merge check (only with `--require-merged` or `--delete-branch`): `merge-base --is-ancestor HEAD origin/<default>`, and otherwise `gh pr list --state merged --head <branch> --base <default branch> --json number,headRefOid,baseRefName`, where a merged pull request counts only when its `headRefOid` is the worktree's own commit and its `baseRefName` is the default branch.
7. Unpushed check: `git rev-list HEAD --not --remotes` counts the commits no remote branch has, and a rev-list that fails is the `unpushed_state_unknown` refusal, never zero. A branch the merge check called merged is not refused here: its commits are named in `warnings` and treated as safe, so a squash-merged branch whose remote branch was deleted and pruned is removable with `--require-merged` and without `--force`.
8. Branch guard: refuses to delete the branch the default base names, or the branch the main checkout is on.
9. Unlinks the ignored symlinks in the work tree (the dependency links `create` made), each with `unlink`, which removes the link itself and never follows it, so the shared directory in the main checkout is left exactly as it was.
10. `git worktree remove` from the main checkout (`--force` once, or twice for a locked entry, as git requires), then `git worktree prune`.
11. `git branch -D <branch>` with `--delete-branch`. `-D` cannot lose work in the normal path, because an unpushed branch was already refused in step 7 unless `--force` said otherwise or the merge verdict said the work is in the base.

Ignored files and directories inside the worktree (`.env`, build output, a real `node_modules`) are deleted with it, without `--force`, as `git worktree remove` does.

The main checkout is never modified: no `git stash`, `checkout`, `switch` or `reset` is run anywhere, and its HEAD, index, working tree and stash are untouched. Only its administrative directories are written (`worktree remove`, `worktree prune`, `branch -D`). Removing a worktree never deletes its branch unless `--delete-branch` says so.

### Result

The usual [envelope](output-shape.md) with `command: "worktree remove"`, plus:

| Field | Meaning |
| --- | --- |
| `worktree` | `path` (absolute), `branch` when it had one, `head`. |
| `linksRemoved` | Repository-relative paths of the ignored symlinks that were unlinked in step 9. |
| `merged` | The merge verdict, or `null` when neither `--require-merged` nor `--delete-branch` asked for one: `merged` `yes`/`no`/`unknown`, `via` `ancestry`/`gh`/`none`, and a `reason`. |
| `branch` | `deleted` and the `reason` (git's own message, or why the branch was kept). |
| `pruned` | Whether `git worktree prune` ran and succeeded afterwards. |
| `warnings` | What did not work but could not stop the removal (a link that could not be unlinked, a failed prune), and the commits of a merged branch that were not counted as unpushed. |

### Refusals

| `reason` | Cause |
| --- | --- |
| `not_a_worktree` | `<path>` is not an existing directory, or is a directory git does not list as a worktree of its repository. |
| `not_a_git_repo` | `<path>` is not inside a git working tree. |
| `remove_main_checkout` | `<path>` is the main checkout. This command never removes it. |
| `worktree_locked` | The entry is locked (`git worktree unlock` it, or pass `--force`). |
| `nested_worktree` | Another registered worktree of the repository lies inside `<path>`; `details.worktree` names it. Remove that one first. A stale entry whose directory is gone (a prunable one) does not count, since it has nothing inside to lose; a prunable entry whose directory is still there does. |
| `has_submodules` | The work tree has a `.gitmodules` file, which `git worktree remove` cannot handle without `--force`. |
| `worktree_dirty` | Uncommitted or untracked changes; `details.entries` lists the first 20 status lines. |
| `status_unknown` | `git status` failed, so the dirty state could not be read; the message carries git's error. A failed check is never read as clean. |
| `unpushed_commits` | Commits that no remote branch has; `details.commits` counts them. Not raised for a branch the merge verdict called merged: those commits are reported in `warnings` instead. |
| `unpushed_state_unknown` | `git rev-list HEAD --not --remotes` failed, so the unpushed state could not be read; the message carries git's error. A failed check is never read as zero. |
| `base_not_found` | `--base <rev>` has the shape of a remote-tracking branch but no such ref exists. Nothing was removed. |
| `base_not_remote_branch` | `--base <rev>` is not `<remote>/<branch>` or `refs/remotes/<remote>/<branch>` of a configured remote. Nothing was removed. |
| `option_invalid` | `--base` without `--require-merged` or `--delete-branch`. |
| `branch_not_merged` | `--require-merged`, and the branch is neither an ancestor of the base nor the head of a merged pull request. `details.merged` is the verdict. |
| `merge_state_unknown` | `--require-merged`, and neither ancestry nor `gh` could decide, so the state is unknown rather than negative. `details.merged.reason` says which. |
| `default_branch_delete` | `--delete-branch` was asked for the branch the default base names or the one the main checkout is on. |
| `worktree_remove_failed` | `git worktree remove` itself failed; the message carries git's error. |

### The merged rule

Ancestry decides first: `HEAD` is an ancestor of `origin/<default branch>`, which covers a merge and a fast forward. A squash or a rebase merge leaves no ancestry, so `gh pr list --state merged --head <branch> --base <default branch> --json number,headRefOid,baseRefName` is asked next, and one merged pull request is a `yes` with `via: "gh"` only when it was merged into the default branch (`--base <default branch>`) at the worktree's HEAD commit, that is, its `headRefOid` is that commit and its `baseRefName` is the default branch. The commit has to match: a branch that gained commits after the merge, or whose name was reused for new work, is not covered by the pull request that merged an older head of it. The base has to match too: a pull request merged into another branch (a stacked pull request merged into its parent branch, say) says nothing about this base. `details.merged.reason` says so in both cases. `gh` is only consulted when it is installed and only when the answer is needed; when it is absent, or fails, or answers something that is not JSON, the verdict is `unknown`, and `--require-merged` reports `merge_state_unknown` rather than removing the worktree on a guess. `--force` is what overrides both a `no` and an `unknown`.

A branch that is merged into the base, by ancestry or by a merged pull request at the same commit, holds no work the base does not have, so it is not counted as unpushed even when its own remote branch was deleted and pruned; those commits are named in `warnings` instead of stopping the removal.

## list

```bash
agent-primitives worktree list --repo ~/src/app
agent-primitives worktree list --root ~/wt
agent-primitives worktree list --repo ~/src/app --base origin/master
```

Read-only: no git command that writes is run.

| Option | Meaning |
| --- | --- |
| `--repo <path>` | The repository to report: the main checkout, a subdirectory, or a linked worktree. Every worktree git lists is reported, main checkout first. Default: the invocation directory (`-C`). |
| `--root <dir>` | Instead of one repository, report the work trees that are direct children of `<dir>`, sorted by name. A child that is not a work tree top (a plain directory, or a subdirectory of some checkout) is skipped silently. A child that is a work tree but whose repository cannot be described (a work tree of a bare repository, say) is left out with a `skipped <path>` warning, and its siblings are still reported. Exclusive with `--repo`: both together are an `option_invalid` refusal. |
| `--base <rev>` | Measure `ahead`, `behind` and `merged` against a remote-tracking branch instead of origin's default branch (`origin/master` for hotfix branches in a repository whose default branch is `develop`, say); each entry's `base` shows `<rev>` as given. `<rev>` is `<remote>/<branch>` or `refs/remotes/<remote>/<branch>`; it is resolved once per repository, in its main checkout, to the full ref, and every worktree is measured against that ref. A value that is no exact remote-tracking ref name (`HEAD`, `HEAD~1`, `origin/x@{1}`, `origin/x^`, a local branch, a sha, a tag) is a `base_not_remote_branch` refusal. With `--root` the flag applies to every repository, and a repository where `<rev>` is not a remote-tracking branch or does not exist gives that repository's entries `merged: unknown` with a reason, null `ahead`/`behind`, and one warning; the report still completes. The `gh` lookup uses the branch part after `<remote>/` as the pull request's base. Still read-only: nothing is fetched, so a remote-tracking `<rev>` is as fresh as the last fetch. |

Per entry:

| Field | Meaning |
| --- | --- |
| `path`, `repo`, `main` | The directory, the basename of the main checkout it belongs to, and whether this entry is that main checkout (the only `main: true` of a repository). |
| `branch`, `head` | From `git worktree list --porcelain`; `branch` is absent for a detached HEAD. |
| `base` | The base the three fields below are measured against: the `--base` value, or else the default base (`origin/main`, say), absent when no default can be resolved. |
| `runPointer` | Trimmed content of `<path>/.ai/run`, `null` when absent. |
| `dirty` | Whether `git status --porcelain --untracked-files=all` says anything, `null` when git could not answer. |
| `ahead`, `behind` | `git rev-list --left-right --count <base>...HEAD`: commits only on `HEAD`, and commits only on the base. `null` when either could not be told. |
| `merged` | The same verdict as `remove --require-merged` would reach. `merged: yes` means the branch's work is in the base; `remove` still checks dirty and unpushed state. |
| `links` | The ignored symlinks in the work tree: the dependency links `create` made. |
| `prunable`, `locked` | git's own flags for the entry. |

A prunable entry (its directory is already gone) has no work tree to read, so `dirty`, `ahead` and `behind` are `null`, `links` and `runPointer` are empty, and `merged` says `prunable: the directory is gone`.

## Related

`worktree create` writes what `worktree remove` later cleans up: the branch, the `.ai/run` pointer and the dependency links are its three artifacts, and `remove` reports the branch it deleted and each link it unlinked. `list` reads the same fields back, so `create`'s envelope, `list`'s report and `remove`'s report describe one worktree in the same terms.

