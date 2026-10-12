# `worktree`

Creates and (in later releases) manages linked git worktrees for task branches. Part of the [agent-primitives](../README.md) CLI. This page covers `worktree create`.

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

The result lists `links.made` (`path`, `target`, `exclude`: `added`, `already_ignored` or `failed`) and `links.skipped` (`path`, `reason`, `detail`).

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
| `target_inside_worktree` | The target lies inside another working tree of the repository: the linked worktree `--repo` points into, or any registered worktree whose directory still exists (a stale, prunable entry does not count). `details.worktree` names it. |
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

## Related

`worktree remove` and `worktree list` are planned as the next subcommands and will reuse the helpers in `src/worktree/git.ts`.
