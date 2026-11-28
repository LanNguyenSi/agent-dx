# Closing check

`spec-gate closure` answers, for every row of a proposed spec's test plan,
whether the committed evidence proves the row at or after the start commit of
the work, and why. It is read-only and offline: it reads the spec directory
from disk the way `lint` does, and the history and the command set from git
through the same hardened calls (see "Git inputs" in [lint.md](lint.md)). It
never writes, never fetches and makes no network request.

It counts only evidence it can attribute to the work. An envelope that it
cannot tie to a commit on `start..head`, to the row's one command and to the
row's binding is listed and never counted.

## CLI

```
spec-gate closure <spec-dir> --repo <dir> --default-ref <ref> --start <commit> [--head <commit>]
```

| Flag | Meaning |
|---|---|
| `<spec-dir>` | the spec directory inside `--repo`; `spec.md`, `testplan.yaml`, `bindings.yaml` and `evidence/` are read from it on disk |
| `--repo <dir>` | the trusted checkout root, as for `lint`; never discovered from the spec directory |
| `--default-ref <ref>` | the full ref name of the fetched default branch (for example `refs/remotes/origin/main`), resolved offline |
| `--start <commit>` | the full id of the start commit, given by the host: the commit the implementation work started from |
| `--head <commit>` | the full id of the commit the work is evaluated at; default: `HEAD` of the checkout |

`.spec-gate/commands.yaml` is read at the spec's `commands_ref`, never at the
head or the tip of the default branch, as the `stale-evidence` lint rule reads
it.

## Preconditions

Each of these is a refusal: one line on stderr, `spec-gate: closure: <code>:
<message>`, nothing on stdout, exit 2.

| Code | When |
|---|---|
| `start-invalid`, `head-invalid` | `--start` or `--head` is not a full commit id (40 or 64 lower-case hex digits) |
| `spec-dir-invalid` | the spec directory is a symbolic link, not a directory, or a path that cannot be read from a commit |
| `input-missing` and the loader's codes | `spec.md`, `testplan.yaml` or `bindings.yaml` is missing or does not load |
| the loader's codes | a file under `evidence/` does not load (no row is judged from half-read evidence; `lint` names the findings) |
| `git-input-invalid` | `--repo` or `--default-ref` does not resolve, as for `lint` |
| `start-not-a-commit`, `head-not-a-commit` | the id is no commit of the repository |
| `spec-not-merged` | no commit on `--default-ref` changed `<spec-dir>/spec.md` or `<spec-dir>/testplan.yaml` |
| `spec-not-proposed` | `spec.md` at the merged spec commit is missing or its status is not `proposed` |
| `start-before-spec` | `--start` is not the merged spec commit or a descendant of it |
| `start-not-on-default` | `--start` is not an ancestor of (or equal to) the `--default-ref` commit |
| `head-before-start` | `--head` is not `--start` or a descendant of it |
| `commands-ref-untrusted` | `commands_ref` is not a commit or not an ancestor of the `--default-ref` commit |
| `commands-file-missing`, `commands-file-invalid` | the command set at `commands_ref` is missing, not a regular file, not UTF-8 or does not parse |
| a git code (`git-failed`, ...) | git could not be read |

The merged spec commit is the last commit along the first parents of the
`--default-ref` commit whose change touches `<spec-dir>/spec.md` or
`<spec-dir>/testplan.yaml`: for a merge commit the merge, for a squash or
rebase merge the commit that landed. A later change on the work branch does
not move it.

## Counted envelopes

An envelope of `evidence/TP-<n>.jsonl` counts for row `TP-<n>` only when all
of these hold. The first condition it fails is its reason, in this order:

| Reason | The envelope does not count when |
|---|---|
| `phase-baseline` | its phase is `baseline` (baseline evidence is informative; `stays-green` is decided at the start commit) |
| `before-start` | its commit is held by the head but is not the start commit or a descendant of it |
| `not-on-head` | its commit is not in the repository, or is not an ancestor of (or equal to) the head |
| `dirty` | it was gathered on a dirty work tree |
| `command-unknown` | the row has no determinable command: a `static` row whose `check_command_ref` names no command of the set, a row that is not `static` and whose binding has no selector, or a selector-bound row while no command of the set carries `{selector}` |
| `digest-mismatch` | its `commands_digest` is not `expectedCommandsDigest` of the row's one command at `commands_ref`, with `{selector}` left unsubstituted |
| `selector-mismatch` | its `selector` is not the row's binding selector (`null` for a `static` row) |

Every ignored envelope is listed under its row as `{ "line": <n>, "reason":
<code> }`, `line` being its 1-based line in the file.

Producers: `host` counts as external. `local` counts and marks the row
`self_reported: true`. `ci` counts and marks the row `ci_unverified: true`:
the CI run it names is not checked with the host yet.

Order: the counted envelopes of a row are ordered by commit ancestry (an
envelope at an ancestor commit is earlier), at one commit by `time`, then by
line. When two counted envelopes lie at commits neither of which is an
ancestor of the other (two branches merged into the head), the row is
`not-decidable` with reason `unordered-evidence`.

## Per-kind rules

| Kind | `proven` | `failed` | `unproven` | otherwise |
|---|---|---|---|---|
| `stays-green` | a counted `pass` at the start commit itself, and the latest counted envelope is a `pass` | the latest counted envelope is a `fail` or an `error` | no counted envelope, the latest is a `skip`, or no `pass` at the start commit | |
| `red-first` | a counted `fail` followed by a counted `pass`, and the latest counted envelope is a `pass` | no `pass` follows the last `fail`, or an `error` is latest after the green | no counted `fail` (green without red; an `error` or a `skip` is not red), nothing counted, or a `skip` latest after the green | |
| `static` | the latest counted envelope is a `pass` with `exit: 0` | the latest is a `fail` or an `error` | nothing counted, the latest is a `skip`, or a `pass` with another exit | |
| `measurement`, `manual`, `runtime` | | | | `not-decidable`, reason `kind-needs-review` |
| `post-deploy` | | | | `pending-post-deploy` |

A row of the first three kinds without an evidence file is `unproven`
(`no-evidence-file`). The envelopes of a `measurement`, `manual`, `runtime` or
`post-deploy` row are listed as counted or ignored but decide nothing. The
`reason` codes are `pass-at-start-and-latest-pass`, `red-then-green`,
`latest-pass-exit-zero`, `latest-fail`, `latest-error`, `latest-skip`,
`no-pass-at-start`, `no-red`, `no-green-after-red`, `pass-exit-not-zero`,
`no-counted-evidence`, `no-evidence-file`, `unordered-evidence`,
`kind-needs-review` and `post-deploy`.

## Report

One JSON line, `spec-gate-closure/1`, fields in this order:

| Field | Meaning |
|---|---|
| `format` | `spec-gate-closure/1` |
| `spec` | the spec id |
| `start`, `head` | the start commit and the evaluated head |
| `spec_commit` | the merged spec commit |
| `ok` | true when no row is `failed` or `unproven` |
| `rows` | one entry per test-plan row, in test-plan order |
| `counts` | the number of rows per state: `proven`, `failed`, `unproven`, `not-decidable`, `pending-post-deploy` |
| `unknown_rows` | the TP IDs of well-named evidence files that are no test-plan row (`lint` reports them as `evidence-unknown-row`), in numeric order |

A row holds `id`, `kind`, `state`, `reason`, `self_reported`,
`ci_unverified`, `counted` (the number of counted envelopes) and `ignored`;
a `stays-green` row adds `probe: "not-checked"`, a `red-first` row
`red_reason: "not-checked"`, and a `measurement`, `manual` or `runtime` row
`evidence_location` (the row's field, `null` when it has none).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | a report with `ok: true`; `not-decidable` and `pending-post-deploy` rows do not make `ok` false |
| 1 | a report with a `failed` or `unproven` row |
| 2 | a usage error, a refusal (see "Preconditions") or an unexpected exception; no report |

## What is not checked

- The probe of a `stays-green` row: an envelope says whether the check passed,
  not whether a probe was run against it.
- The red reason of a `red-first` row (`red_reason`, `fail_match`): the
  envelope holds no output.
- The squash rule (`evidenceSurvivesSquash`): it needs facts about the merge
  and the pull request's CI run that no host adapter reports yet. Until it
  does, an envelope at a commit the head does not hold, such as a commit of a
  pull request branch before a squash merge, never counts.
- The CI run of a `producer: ci` envelope: the row is marked `ci_unverified`
  and the envelope counts.
- Measured values, manual and runtime evidence: those rows are for review.
- Whether `testplan.yaml` and `bindings.yaml` on disk equal the merged copies:
  they are read from the spec directory as `lint` reads them.
