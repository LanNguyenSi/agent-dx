# `guard`

Run one command under a wall-clock timeout and a memory cap, in a process
group of its own, and leave nothing of it running. Part of the
[agent-primitives](../README.md) CLI.

Use it for any run that can hang or grow without bound: a repro against an
adversarial fixture, a hang probe, a fuzz loop, a test of code that spawns
children. A plain `timeout` kills only the direct child; whatever that child
started keeps running and a runaway allocation can exhaust the host. `guard`
replaces the per-run shell script that otherwise gets copied between runs.

```bash
agent-primitives guard <timeout-s> <max-rss-MiB> -- <cmd> [args...]
agent-primitives guard 60 512 -- npm test
agent-primitives guard 20 256 --poll-ms 100 -- node fuzz.js --seed 7
```

The command goes after `--`, as an argument list (no shell; use `-- sh -c
'...'` for a pipeline). Its output goes to a log file, its stdin is empty.
Global flags (`-f`, `-C`, `-m`, `-l`, `--json`) come before `guard`.

## Limits

- **Timeout** (`<timeout-s>`, a positive number of seconds): at the bound the
  whole group is ended with `SIGKILL`, with no `SIGTERM` grace.
- **Memory cap** (`<max-rss-MiB>`): checked by polling the process table with
  `ps -A` every `--poll-ms` (default 200, 20 to 60000), because `ulimit -v`
  does not bind children on macOS. At the cap the whole group is ended with
  `SIGKILL`.

### The cap is the sum over the tree, not per process

The compared figure is the summed resident set size of the command's process
group plus every process found below it by parent pid. A per-process cap would
let a command that forks N workers use N times the cap, and the point of the
cap is to protect the host. The sum counts a page shared between forked
processes once per process, so it over-counts a forking command; read the cap
as a conservative backstop and give a forking command headroom. The envelope
reports both `peakRssMiB` (summed) and `peakProcessRssMiB` (largest single
process) so the headroom can be set from a measured run.

### What polling cannot do

A process that allocates faster than one poll interval can overshoot the cap
before the next sample sees it; the kill then lands late, not never. Keep
`--poll-ms` short (about 200 ms is the default) and use a lower cap for a
fixture known to be memory-hungry. A command whose whole run is shorter than
one interval is never sampled.

The timeout is a separate timer, but it runs on the same thread as the `ps`
reads, which are synchronous: a read in progress when the timer is due, and
the read that `guard` makes when the limit fires, each delay the kill. That is
milliseconds on a healthy host and at most 5 s per read (each is bounded at
5 s), so the kill can land up to two reads late. The group is not stopped
first: that would also stop the watcher that ends the group when `guard`
itself is killed, and a `guard` killed in that window would leave a stopped
group behind.

`guard` puts no bound on the number of processes the command starts (that
would be a pid limit of the host or container, outside this command). A
command that forks without end can leave no room to start `ps` at all; see
the next section for what is reported then.

## Leftovers

After the command ends on its own, `guard` looks at the process table once
more. Anything still alive in its process group or below it (a background
child, a worker the command forgot to wait for) is listed under `leftovers`,
killed, and makes the run exit `122`, even when the command itself exited `0`.
A zombie is dead and is not counted. If something is still alive after the
kill sweeps it is listed under `survivors` and in `warnings`.

### When `ps` cannot be read

`ps` can fail exactly when it matters: under fork pressure there is no pid
left to start it with. A failed read is tried again up to four times in all,
with a pause of 50, 100 and 200 ms between tries. When the table still cannot
be read after the command ended, `guard` ends the process group anyway (that
needs no table), looks once more once the group is gone, and reports an
**error, never a pass**: `status: "error"`, `reason: "leftover_check_failed"`,
exit `2`, `leftoverCheckFailed: true`, and a warning. Exit `2` is the "could
not conclude" code of the CLI; `122` would claim that leftovers exist, which
is the thing that is not known. The same flag is set, whatever the reason,
when the table could not be read at a limit or during the kill sweeps, so
the lists in the envelope may be incomplete; if processes that had left the
group were found anyway they are reported as leftovers as usual. At a limit
the group is ended with the first failed read, before it is tried again.

### A child that calls `setsid`

A descendant that starts a session or group of its own (`setsid`, or `detached`
in Node) leaves the process group, so the group kill cannot reach it. `guard`
therefore also follows the parent chain at every poll, from the group and from
every process it saw earlier: such a process is counted against the cap and
killed by pid at a limit or as a leftover (reported with `inGroup: false`),
provided a poll saw it while its parent chain was intact, and even after its
parent exited. One that was started and cut loose from its parent within a
single poll interval is not found. That gap is not closed; a command that
needs a stronger guarantee needs a host-level container or cgroup, which is
outside this command. A process's identity is its pid plus its start time, so
a pid the system reused for something unrelated is never killed.

If `guard` itself is killed (`SIGKILL`, `SIGHUP`, a harness timeout), a
watcher started in the command's group ends the group. That covers the group
only, not an escaped descendant.

## Exit codes

| Code | Meaning | `reason` |
| --- | --- | --- |
| `124` | wall-clock timeout (the same code coreutils `timeout` uses) | `timeout` |
| `123` | memory cap exceeded | `rss_cap` |
| `122` | the command ended and left processes running | `leftover` |
| `130` | `guard()` was aborted through its `signal` and killed the group (API only; the CLI never reports it, see below) | `aborted` |
| `2` | `guard` could not run, or could not check for leftovers: usage error, `ps` unusable, command could not be started, `ps` unreadable after the command ended | `usage_error`, `ps_unavailable`, `spawn_failed`, `unsupported_platform`, `leftover_check_failed` |
| any other | the command's own exit code, passed through (`128` plus the signal number for a command a signal ended) | `child_exit`, or `none` for `0` |

The CLI itself ends with `130` on SIGINT and `143` on SIGTERM, with no output
and no envelope, like every command of this CLI (see
[worktree](worktree.md)): it first ends the command's group and every escaped
process it has tracked, then exits. `aborted` is therefore only seen by a
program that calls `guard()` with an `AbortSignal`.

If more than one thing happened the order is timeout, memory cap, leftover,
`leftover_check_failed`, then the command's own code: a leftover wins over the
command's own failure code, because the leftover is the part nobody would
otherwise see. A wrapped command that itself exits `2`, `122`, `123`, `124`
or `130` is indistinguishable by exit code alone; the envelope's `reason`
tells them apart (`child_exit` against `usage_error`, `ps_unavailable`,
`spawn_failed`, `leftover_check_failed`, `timeout`, `rss_cap`, `leftover`; a
`130` from a signal to the CLI has no envelope at all).

## Result

One envelope, `command: "guard"`. `status` is `pass` (the command exited `0`
and left nothing), `fail` (anything else that ran) or `error` (it could not
run, or its leftovers could not be checked). Besides the common fields:

- `reason`, `exitCode` (what `guard` exits with) and `childExitCode`.
- `limits`: `timeoutMs`, `maxRssMiB`, `pollMs`.
- `peakRssMiB`, `peakProcessRssMiB`, `polls`, `failedPolls` (polls where `ps`
  could not be read; the cap was not checked at those, and `warnings` says so).
- `killed` / `killedCount`: the tree that was alive when a limit fired.
- `leftovers` / `leftoverCount`, `survivors` / `survivorCount`. Each entry is
  `{ pid, pgid, rssMiB, inGroup, command }`; a list is cut at 20 entries and
  the count says how many there were. The trampoline that starts the command
  and its watcher are not listed; they are recognised by their place (the
  group's leader and its direct child in the group), so a process that merely
  shows the same command line is reported.
- `leftoverCheckFailed`: `true` when the process table could not be read
  after the command ended or during the sweeps (see above); the lists may be
  incomplete.
- `outputTail`: the last lines of the command's output; the whole output is
  the log named in `logs`.

The command's output is written to that log without a size bound: a command
that prints without end is stopped by the timeout, not by `guard`.

## Platforms

macOS and Linux (the process table is read with `ps -A -o
pid=,ppid=,pgid=,rss=,stat=,lstart=,command=`, which both accept). Windows
needs a job object and is not supported; `guard` reports `unsupported_platform`
there. A `ps` that rejects those columns (some minimal busybox builds) is
reported as `ps_unavailable` before anything is run.
