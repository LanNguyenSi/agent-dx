# `doctor`

PATH and environment checks agent-primitives itself and its other commands rely on. Part of the [agent-primitives](../README.md) CLI.

Checks that a fixed list of required and optional binaries are on `PATH`,
captures each found binary's `--version`, and reports a few environment
checks (an installed `node_modules`, whether the cwd is inside a git work
tree, `BASH_MAX_OUTPUT_LENGTH` if set, and whether a `dist/` directory sits
next to `src/`, which hints that a test suite executing built output may
need a rebuild step first). Version captures share one aggregate deadline
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
2.36 the worktree listing falls back to its newline-separated form; see [probe.md](probe.md)'s isolation section). The `stale-worktree` check reads the same
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

Exits `1` when a required binary is missing.

