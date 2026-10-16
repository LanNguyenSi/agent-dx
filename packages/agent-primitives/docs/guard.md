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

### How late `guard` itself can be

The timeout is a separate timer, but it runs on the same thread as the `ps`
reads, which are synchronous. A poll's read is bounded by the time left until
the timeout (never less than 250 ms, never more than 5 s), so a slow or
hanging `ps` holds the timer back by about 250 ms at most. At the limit,
`guard` reads the table once and kills; that read, and any further tries,
stop after about 1 s, and when the read fails the group is killed at once
without it. With a healthy `ps` the kill lands milliseconds after the
timeout; with a `ps` that hangs it lands about 1.25 s after it at most, plus
whatever else the host delays. At the memory cap the poll that saw the cap
kills from its own table, without another read.

From the first terminal event on (a limit, an abort, or the command's exit)
every read of the table shares one budget of about 2 s: each `ps` call is
bounded by what is left of it, a failed read is tried again only while the
budget leaves room, and the one read a decision needs is still made once
(for at least 250 ms) when the budget is spent. So `guard` returns about
2.3 s after the first terminal event at most, however long `ps` hangs; with
a healthy `ps`, as soon as the kill sweeps find nothing left. The group is
not stopped first: that would also stop the watcher that ends the group when
`guard` itself is killed, and a `guard` killed in that window would leave a
stopped group behind.

`guard` puts no bound on the number of processes the command starts (that
would be a pid limit of the host or container, outside this command). A
command that forks without end can leave no room to start `ps` at all; see
the next section for what is reported then.

## Leftovers

After the command ends on its own, `guard` looks at the process table once
more. Anything still alive in its process group or below it (a background
child, a worker the command forgot to wait for) is listed under `leftovers`,
killed, and makes the run exit `122`, even when the command itself exited `0`.
Each kill sweep is followed by another look, up to ten sweeps within the
budget; a process found by a later look is killed and listed too. A zombie
is dead and is not counted. If something is still alive at the last look it
is listed under `survivors` (and in `warnings`), killed once more, and not
looked at again.

### When `ps` cannot be read

`ps` can fail exactly when it matters: under fork pressure there is no pid
left to start it with. `guard` therefore never tries a read again before it
kills. The timeout, an abort before the command ended, and the command's exit
each read the table once (at the memory cap the poll's own table serves);
when that read fails, the group is killed at once without it (that needs no
table), and the further tries only look for processes that had left the
group. A failed read is tried up to four times in all, with a pause of 50,
100 and 200 ms before the next try, as long as the budget above leaves room.

What is reported then:

- **At the timeout or an abort before the command ended**: the group's
  members were killed unseen and are not listed. If a later try answers,
  the processes outside the group it shows are killed and listed under
  `killed`. If none answers, the processes outside the group that the last
  readable table showed are killed by pid, and those the kill reached are
  listed under `killed`, with a warning that names the age of that table.
  The members of the group that table showed and that now lead a process
  group of their own (`setsid` or `setpgid(0, 0)` called in place, which keeps
  the pid) are killed by pid too, since the group kill missed them; a member
  that joined another existing group is not reached. They are not listed, because
  the table does not say whether they were still alive. `leftoverCheckFailed`
  is `true`.
- **After the command ended on its own**: the group is killed unseen, so what
  was alive in it cannot be listed. The run is an **error, never a pass**:
  `status: "error"`, `reason: "leftover_check_failed"`, exit `2`,
  `leftoverCheckFailed: true`, and a warning. Exit `2` is the "could not
  conclude" code of the CLI; `122` would claim that leftovers exist, which is
  the thing that is not known. Processes outside the group found by a later
  try, or, failing that, taken from the last readable table as above, are
  listed under `leftovers`, and the run then ends with `122` and the same
  flag.
- **After a kill sweep**: when the read that should show the kill worked
  fails, `leftoverCheckFailed` is `true` and a warning says it is not known
  whether everything is gone; nothing is claimed as a survivor.

Killing by pid from an earlier table has one limit: a process that ended
after that table was read, and whose pid the system gave to an unrelated
process since, would be hit. A process outside the group is killed by pid on
the table's word. A member of the group is killed by pid only when a process
group with its pid exists at that moment (`kill(-pid, 0)`), which is what a
member that left the group in place (`setsid`, `setpgid`) looks like; a member
without such a group was reached by the group kill or is gone, and nothing is
signalled by its pid. The limit that remains: a member that joined another
existing group is not reached, and a freed pid that has become the leader of a
group of its own would still be hit. The group's leader is never killed by
pid: the group kill ends it, and once the command's exit is seen `guard` has
reaped it, so its pid may be anyone's. The table is usually the last poll's,
older when polls were failing too; the warning names its age, which is
counted from the start of the read that produced the table (`ps` may have
taken its snapshot at any point of the read). A table older than 10 s is not
used for it, for members of the group as well as for the processes outside it:
the group is still killed, but the processes outside it, and the members of
the group that left it, are left alive, `leftoverCheckFailed` is `true`, and
a warning names the processes outside (pid and command) and says they were not
killed. Each process is aimed at by pid once per run, and warned about once,
however many of the fallbacks above a run goes through (at the timeout and
again after the command ended, for example).

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
a pid the system reused for something unrelated is not taken for a process
seen earlier; the one exception is the kill without a fresh table described
above.

If `guard` itself is killed (`SIGKILL`, `SIGHUP`, a harness timeout), a
watcher started in the command's group ends the group. That covers the group
only, not an escaped descendant.

## Abort and signals

An abort (the `signal` of `guard()`, or SIGINT and SIGTERM to the CLI) is
honoured until `guard` returns, and its kills are done synchronously, before
the abort call returns:

- **Before the command ended** it is a limit like the others: one read of the
  table (about 1 s at most), then the group and every process outside it
  that the table shows are killed; without a table, as described above.
- **After the command ended**, while `guard` is still looking for leftovers,
  there is no time for a read: the group, and every process outside it that
  the last readable table showed, are killed by pid at once, and no further
  read is made. The result's `reason` is `aborted`, and what was found and
  killed after the exit is listed under `killed`.

Reads are synchronous, so an abort or a signal takes effect between two
reads, up to one read late: a poll's read is bounded at 5 s (and by the time
left to the timeout), a read at a limit at about 1 s, and a read after the
command ended by the rest of the budget. A process outside the group that no
table ever showed is not reached by an abort.

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
[worktree](worktree.md)): the signal aborts the run, whose kills (see
[Abort and signals](#abort-and-signals)) are done before the CLI exits.
`aborted` is therefore only seen by a program that calls `guard()` with an
`AbortSignal`.

If more than one thing happened the order is: the first of timeout, memory
cap and abort (an abort after the command ended included), then leftover,
then `leftover_check_failed`, then the command's own code. A leftover wins
over the command's own failure code, because the leftover is the part nobody
would otherwise see. A wrapped command that itself exits `2`, `122`, `123`,
`124` or `130` is indistinguishable by exit code alone; the envelope's `reason`
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
- `killed` / `killedCount`: every process ended because of a limit or an
  abort, as a table showed it: the tree at the limit, and whatever later
  looks found and killed.
- `leftovers` / `leftoverCount`: every process ended after the command ended
  on its own, as a table showed it. A process is listed in exactly one of
  these two lists.
- `survivors` / `survivorCount`: still alive at the last look after the kill
  sweeps; each is also in one of the two lists above.
- Each entry is `{ pid, pgid, rssMiB, inGroup, command }`; a list is cut at
  20 entries and the count says how many there were. The trampoline that
  starts the command and its watcher are not listed. They are known by
  identity (pid and start time) once two tables have shown the watcher as
  the trampoline's one child with its command line, so the watcher stays
  recognised after the command kills the trampoline and the watcher loses its
  parent. Before that, they are recognised by their place (the group's
  leader, and its direct child in the group, with the trampoline's command
  line); and when the trampoline died of a signal before any table showed
  the two together, the one group member whose parent is outside the tree
  and whose command line is exactly the trampoline's (as an earlier table
  showed it, else: starts like it and ends with the program and arguments
  `guard` handed to it) is taken for the watcher. A process that merely
  shows the same command line elsewhere, or only its first words, is
  reported. `ps` does not print every character of an argument as it is
  (a newline is `\012` on macOS and a space on Linux, a byte outside ASCII is
  `M-C` and the like on macOS and `?` on Linux), so in that last comparison
  each run of characters outside printable ASCII in the arguments stands for
  whatever `ps` printed for it: any characters (printable ones too), none or
  up to four per byte. The limit of that: an impostor whose command line
  differs from the trampoline's only in such characters is taken for the
  watcher too, and a `ps` that prints an argument in some other way than
  those two (or cuts a very long command line) leaves the real watcher
  unrecognised, so it is listed as a leftover. The comparison takes time
  linear in the length of the command line and of the arguments, however
  long and however non-ASCII they are: it looks at the last 32 such runs
  (and the text between and after them) and at the end of the command line
  they can reach, so a difference only before those is not seen.
- `leftoverCheckFailed`: `true` when a read of the process table that
  `guard` needed failed for good: at a limit, after the command ended, or
  after a kill sweep (see above). The group was killed anyway; the lists may
  be incomplete, and the run is never a pass.
- `outputTail`: the last lines of the command's output; the whole output is
  the log named in `logs`, which is there whenever the command ran (also for
  `leftover_check_failed`).

The command's output is written to that log without a size bound: a command
that prints without end is stopped by the timeout, not by `guard`.

## Platforms

macOS and Linux (the process table is read with `ps -A -o
pid=,ppid=,pgid=,rss=,stat=,lstart=,command=`, which both accept). Windows
needs a job object and is not supported; `guard` reports `unsupported_platform`
there. A `ps` that rejects those columns (some minimal busybox builds) is
reported as `ps_unavailable` before anything is run.
