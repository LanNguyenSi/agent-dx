# Lint

`spec-gate lint <spec-dir>` checks a spec directory and prints one JSON
report line. It is deterministic: the same files give the same report, byte
for byte, and the report holds no absolute path and no time. The engine
reads files only; it never runs a command and never reads the repository.

```
spec-gate lint <spec-dir> [--strict] [--final] [--profile <light|full>]
spec-gate lint-ack <spec-dir> <rule> <id> --reason <text>
```

## What is read

| File | Required | Read as |
|---|---|---|
| `spec.md` | yes | the spec grammar in [formats.md](formats.md) |
| `testplan.yaml` | yes | the test-plan format |
| `bindings.yaml` | no | the bindings format |
| `questions.json` | no | the questions format |
| `triage.json` | no | the triage format; decides the profile |
| `source/meta.json` | no | the source line list (`lines[]`, each `{ id, kind }`) |
| `acks.yaml` | no | acknowledged warnings, see below |

Every read refuses a symlink and anything that is not a regular file (a file
below a directory that is a link counts), refuses a file over 4 MiB, and
decodes UTF-8 strictly. Each problem is an error finding, never an
exception and never exit 2:

- rule `file`: the file is missing (only for a required file), or its code is
  one of `input-missing`, `input-unreadable`, `input-not-regular`,
  `input-too-large`, `input-not-utf8`.
- rule `format`: the file does not parse. The format error's `code` and
  `path` are carried through, and `id` is set when the path starts with an ID.

A file that did not parse is skipped by every rule that needs it. A broken
`testplan.yaml` gives its format errors and no "AC is uncovered" findings.

## Report

One line on stdout, format `spec-gate-lint/1`:

```json
{"format":"spec-gate-lint/1","spec":"<frontmatter id or null>","mode":"lint","profile":"full","profile_source":"triage","status":"draft","ok":true,"errors":[],"warnings":[],"acked":[],"skipped":[],"counts":{"errors":0,"warnings":0,"acked":0}}
```

| Field | Meaning |
|---|---|
| `spec` | the frontmatter `id`, or `null` when `spec.md` did not parse |
| `mode` | `lint`, or `final` with `--final` |
| `profile` | `full` or `light` |
| `profile_source` | `triage`, `flag` or `default` |
| `status` | the frontmatter `status`, or `null` |
| `ok` | no error, and with `--strict` no unacknowledged warning |
| `errors`, `warnings` | findings |
| `acked` | acknowledged warnings, each a finding plus `reason` |
| `skipped` | the rules not evaluated in this run, each `{ rule, reason }`, sorted by rule id |
| `counts` | the length of `errors`, `warnings` and `acked` |

A finding is `{ rule, level, file, path, id?, line?, code?, message }`:

- `file` is relative to the spec directory. A finding about a repository file
  outside it names `repo:<path relative to the repository root>` instead.
- `path` is dotted like the format layer: `$`, `AC-2`, `TP-1.kind`, `[0].rule`.
- `id` is the spec or test-plan ID the finding is about, or a target the rule
  defines (`triage` for `profile-default`).
- `line` is the 1-based line where the file is line oriented.
- `code` is the stable code of the underlying problem for `file` and `format`
  findings.
- `level` comes from the rule registry, never from the rule.

`skipped` names every rule that was not evaluated, with one reason: `profile`
(the rule does not run in the active profile), `gate` (a gated rule while the
status gate is closed), `input-absent` (an input the rule needs is not there),
`input-failed` (an input the rule needs or uses did not parse or could not be
read) and `no-git` (the rule needs a repository and none was given). A rule
that was evaluated and found nothing is not listed. Reasons are checked in the
order `profile`, `gate`, `no-git`, `input-failed`, `input-absent`; the first
that applies is the one named. `skipped` is sorted by rule id.

`errors`, `warnings` and `acked` are each sorted by `file`, `line` (a finding without a line first),
`path`, `rule`, `id` (none first) and `message`; strings compare by UTF-16 code
unit. Usage errors go to stderr as text, never into the report.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | no error finding, and with `--strict` no unacknowledged warning |
| 1 | the report has an error, or with `--strict` an unacknowledged warning |
| 2 | a usage error (unknown option, missing argument, a bad `--profile` value), a spec directory that is missing or not a directory, or an unexpected exception |

Help and version exit 0. `lint-ack` exits 0 when it wrote an entry and 2 on any
refusal.

## Profiles

The profile comes from `triage.json`: its stored `class`, or, when there is
none, the class derived from the fields in memory (the file is never written).
`--profile` only fills in when `triage.json` gives no usable profile.

| `triage.json` | `--profile` | Profile | `profile_source` | Finding |
|---|---|---|---|---|
| usable, class gives `light` or `full` | absent or equal | the class's profile | `triage` | none |
| usable, class gives `light` or `full` | different | the class's profile | `triage` | `profile-mismatch` |
| usable, class gives no spec | any | the flag, else `full` | `flag` or `default` | `profile-no-spec` |
| absent | given | the flag | `flag` | none |
| absent | absent | `full` | `default` | `profile-default` (warning) |
| unparsable | given | the flag | `flag` | the `format` errors |
| unparsable | absent | `full` | `default` | the `format` errors |

So `triage.json` wins over the flag. The light profile runs `file`, `format`,
the profile and acknowledgement rules, and the three form rules. The full
profile runs every rule.

## Status gating

A rule marked gated applies only when the frontmatter `status` is `proposed`
or the run is `--final`; `--final` rates a spec as if it were proposed. Every
other rule always applies. No rule gated on status is registered yet.

## Rules

The table is generated from the registry in `src/lint/registry.ts`, and a test
fails when it drifts. A rule is added by registering it there; the report shape
does not change. Every registered rule needs a positive and a negative fixture
under `test/fixtures/lint-<rule>/`, and a test checks that they exist.

<!-- BEGIN generated: rules -->
| Rule | Level | Profiles | Gated | Ackable | Checks |
|---|---|---|---|---|---|
| `file` | error | light, full | no | no | A required file is missing, or a file is a link, not a regular file, over the size limit, not UTF-8 or unreadable. |
| `format` | error | light, full | no | no | A file does not parse; carries the format error's code and path. |
| `profile-no-spec` | error | light, full | no | no | The triage class leads to no spec (unsuitable, decision, split, clarify). |
| `profile-mismatch` | error | light, full | no | no | `--profile` disagrees with the profile the triage class gives. |
| `profile-default` | warning | light, full | no | yes | No `triage.json` and no `--profile`: the full profile is used. Acknowledge with id `triage`. |
| `ack-invalid` | error | light, full | no | no | An ack names an unknown rule, an error rule or a rule that cannot be acknowledged, or repeats an earlier ack. |
| `ack-unused` | warning | light, full | no | no | A valid ack for a rule that ran in this run matches no current warning. |
| `goal-count` | error | light, full | no | no | Exactly one GOAL line (form rule 1). |
| `ac-coverage` | error | light, full | no | no | Every AC is covered by at least one test-plan row; required fields per kind are checked by the format layer (form rule 2). |
| `non-goals-empty` | error | light, full | no | no | The Non-goals section is not empty; a non-goal needs no test-plan row (form rule 3). |
<!-- END generated: rules -->

The form rules:

- one GOAL: a missing GOAL is an error; a second GOAL is a `format` error
  (duplicate ID) and is not reported twice.
- every AC is covered by at least one test-plan row through `covers`. The
  required fields of each kind are checked by the format layer. A row may also
  cover a non-goal, but a non-goal needs no row.
- the Non-goals section is not empty.

## Acknowledgements

`acks.yaml` sits next to `spec.md` and stays out of the digest. It is a YAML
list of `{ rule, id, reason }`: all strings, each one line and not empty, and
no other key.

```yaml
- rule: "profile-default"
  id: "triage"
  reason: "triage runs later in this flow"
```

An ack matches a warning by `(rule, id)`. A matched warning moves from
`warnings` to `acked` with its reason and is counted there; an acknowledged
warning does not fail `--strict`.

- An ack for an error rule, an unknown rule, a warning that cannot be
  acknowledged (`ack-unused`), or a repeat of an earlier `(rule, id)` is an
  `ack-invalid` error. It acknowledges nothing.
- A valid ack that matches no current warning is an `ack-unused` warning, but
  only when its rule was evaluated in this run. An ack for a rule listed in
  `skipped` (inactive profile, closed gate, a missing or failed input, no
  repository) is kept silently, because the warning could not have been
  raised. A rule that ran and did not fire still gives `ack-unused`: a
  `profile-default` ack while `--profile` is given is unused.
- An `acks.yaml` that does not parse is a `format` error; the other rules still
  run, without acks. An empty or comment-only file holds zero acks and is not
  an error.

`spec-gate lint-ack <spec-dir> <rule> <id> --reason <text>` appends one entry,
and creates the file when it is absent. It accepts only a registered warning
that can be acknowledged, refuses a duplicate `(rule, id)`, and refuses a
reason or id that is empty, has a line break or has a control character. It
does not need the warning to be present now. The existing text is kept byte for
byte (a leading byte-order mark is the one exception: the reader decodes it
away, so it is dropped) and the entry is added after it, with a line feed first when the file did
not end in one. The result is parsed again. A file that cannot take an item
that way, such as a list written in flow style (`[]`) or a document closed by
an end marker, is rewritten as a block list, which drops its comments, and
the verb then prints one line on stderr saying so; that result is parsed again
too, and nothing is written when it does not hold exactly the old entries plus
the new one. An empty or comment-only file takes the entry after its text.

The write is atomic: a temporary file next to `acks.yaml`, created exclusively
and renamed over it, so a reader sees the old or the new file whole. The
permission bits of an existing file carry over, never a setuid, setgid or
sticky bit. A symlink at `acks.yaml`, or at the spec directory itself, is
refused; so is an existing `acks.yaml` that is not valid. Any refusal is a
message on stderr and exit 2, and nothing is written.

`lint-ack` does not lock the file: do not run it in parallel on one spec
directory, or one of two concurrent entries can be lost.

## Writing a rule

A rule is a registry entry with a `check` that returns `RuleFinding`s; the
engine adds `rule` and `level` from the registry, last, so a rule cannot
change either. A finding of an ackable rule must carry an `id`, because an ack
matches on it; the engine throws an internal error (exit 2) when it is missing.

Declare the inputs the check reads:

- `needs`: inputs that must have parsed. The rule is skipped when one is
  absent (`input-absent`) or failed (`input-failed`), so a broken file gives
  its own `file` or `format` errors and no follow-up findings.
- `uses`: inputs the check reads when they are there. The rule runs when one
  is absent and is skipped only when one failed.

A skip is not a pass and not a finding: the rule did not look. It shows in
`skipped` with its reason, and acks for it stay quiet. A rule that reads the
repository sets `needsGit` and is skipped with `no-git` when the run has no
repository.
