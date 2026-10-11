# `doctor`

PATH and environment checks agent-primitives itself and its other commands rely on. Part of the [agent-primitives](../README.md) CLI.

Checks that a list of required and optional binaries are on `PATH`,
captures each found binary's `--version`, and reports a few environment
checks (an installed `node_modules`, whether the cwd is inside a git work
tree, `BASH_MAX_OUTPUT_LENGTH` if set, and a `dist-next-to-src` check,
reported not ok when the cwd has a `src/` directory but no `dist/` beside
it, with a note that a probe on that project may need `--pre` to rebuild
before testing). Version captures share one aggregate deadline
(default 3000ms) across every tool combined; once it is spent, remaining
tools are still checked for presence on `PATH`, but their `--version`
capture is skipped rather than each paying its own timeout, and one
warning names how many were skipped. That one deadline is the bound on
every spawn a `doctor` run makes, not on the `--version` captures alone:
the `python-bytecode-cache` check below asks `python3` for one target's
cache path at a time, so a long `--target` list spends the same budget,
and a target reached after it is spent falls back to the co-located
`__pycache__` guess (a filesystem stat, no spawn) with the deadline
named in that check's own detail. A `git-version` check reads the
installed git against what `probe -i worktree` relies on: it is ok from
git 2.36 on, and below that a warning names what the probe does on that
git (below 2.35 the worktree sync cannot run at all; between 2.35 and
2.36 the worktree listing falls back to its newline-separated form; see the "Isolation" section of [probe.md](probe.md)). The `stale-worktree` check reads the same
listing, with the same fallback; when the listing cannot run in any
form, a warning says that a leftover registered worktree cannot be
reported, rather than the check reading as clean. A scratch worktree a
live probe owns (its `owner.json` names an alive pid and is within 24
hours of the clock) is not a leftover: the check stays ok and a hint
names the worktree, the pid, the record, and the bound; past that
bound the worktree is reported as a leftover with the manual command.
The bound cuts both ways: a probe whose own run outlives it, or a clock
that moves by more than it, can have its worktree removed by a
concurrent probe under another lock directory, and that run then ends
with `baseline_failed` rather than a verdict. Pass `--target
<path>[,<path>...]` (a probe target, repeatable or comma-separated) to
also report a `python-bytecode-cache` check for every `.py` path among
them, naming whatever CPython bytecode cache already exists for that
target, and naming why whenever `python3` cannot be asked or does not
answer and it falls back to a co-located `__pycache__` guess (`python3`
absent from `PATH`, resolving nothing, or doctor's aggregate spawn
deadline already spent); see [non-js-test-runners.md](non-js-test-runners.md)'s
"Python bytecode cache" entry for what the check reports and why it is
informational.

```bash
agent-primitives doctor
agent-primitives doctor -r git,node,npm,rg -o ast-grep,jq,yq,fd
agent-primitives doctor --target path/to/module.py
```

## Options

- `-r, --required <list>`: comma-separated required binaries (default
  `git,node,npm,rg`); a missing one exits `1`.
- `-o, --optional <list>`: comma-separated optional binaries (default
  `ast-grep,jq,yq,fd,codebase-oracle`); `sg` satisfies `ast-grep`.
- `--target <path>[,<path>...]`: probe target paths, repeatable or
  comma-separated; adds the `python-bytecode-cache` check described above.

## Checks

Each entry in `checks` has a `name`, an `ok` flag and a `detail`:

- `node_modules`: ok when the cwd has a `node_modules` directory.
- `git-work-tree`: ok when the cwd is inside a git work tree.
- `BASH_MAX_OUTPUT_LENGTH`: always ok; the detail names the value or says
  it is not set.
- `dist-next-to-src`: not ok when the cwd has a `src/` directory but no
  `dist/` beside it; ok when both exist or there is no `src/`.
- `git-version`: the installed git against what `probe -i worktree`
  needs, as described above.
- `stale-probe-marker`: not ok when an in-flight marker that an
  interrupted `-i inplace` probe left behind (its pid no longer alive)
  points into this repository; the detail says whether the next probe
  will auto-recover it, or names the marker and its backup to inspect.
  See the "Signals, locks and recovery" section of [probe.md](probe.md).
- `stale-worktree`: not ok when a leftover `-i worktree` scratch
  worktree or worktree marker is found, as described above.
- `python-bytecode-cache`: only when `--target` names at least one `.py`
  path, one check covering all of them; always ok.

The checks are informational. Only a missing required binary changes the
result: `status` is then `missing` and the exit code is `1`.

