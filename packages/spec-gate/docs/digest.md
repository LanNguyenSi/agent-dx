# Digest

`spec-gate digest <spec-dir> [--repo <path>]` prints one line, `sha256:<64
lower-case hex digits>`, the digest of the normative layer of a spec. The
digest is not stored in any file. A pull request, a cold read and the
implementation workflow refer to a spec by this value, and a later step
recomputes it to find out whether the normative layer changed.

The code lives in `src/canonical/`. `computeSpecDigest` is the whole
operation; `buildDigestInput` and `computeDigest` are its pure parts.

## What goes in

All of it is read through the parsers in `src/formats/`; nothing is parsed a
second time.

From `spec.md`:

- the frontmatter's `base_commit`, `commands_ref` and `retired_ids`
  (retired IDs are normative: adding, removing or changing one changes the
  digest);
- `GOAL`;
- every `AC` with its text, `source` and `owner`;
- every `NG` with its text and `paths`;
- every `DF` with its text, `reason` and `affects_behavior`;
- every `DC` with its text, `question` and its whole `provenance` block
  (`channel`, `author`, `time`, and `comment_url` when present);
- every `RS` with its text, `class`, `status` and `question` when present;
- the source-ledger assignment: for every `SL` its source line ID, its
  targets, whether it is `out`, and the reason of an `out` entry.

From `testplan.yaml`: every field of every row whose layer is `normative`
in the field-to-layer table (`FIELD_LAYERS`, see `formats.md`). The digest
code asks that table; a field added there as normative joins the digest
without a change to the digest code.

From the repository: the argv list of each command that a normative
test-plan field refers to. Today that is `check_command_ref`. The entry is
looked up by name in `.spec-gate/commands.yaml` as it is at the commit
`commands_ref` names, read from git's object database with
`git cat-file`. The file in the work tree, the head of any branch and any
later commit are never read. The package starts `git` with an argument list
and without a shell, and never runs anything the repository holds.

Not referenced by a normative field, and so not in the digest as an argv
list: the `discovery` command and the command that uses `{selector}`, which a
runner picks without a reference. They are still bound to the digest through
`commands_ref`, the commit they are read at.

## What stays out

- `status` and `superseded_by` (so `propose` does not change the digest),
  and the frontmatter `id` and `source`;
- the title line and the whole Context section, which the parser does not
  expose;
- line numbers and the order of lines, attributes and keys;
- `bindings.yaml`, `bindings.log` and `acks.yaml`, which are never opened;
- every informative field (`notes`) and every binding field;
- the cold read;
- everything under `source/`, `questions.json`, `triage.json` and `evidence/`;
- every command entry that no normative field refers to, and every later
  version of the commands file.

A change to any of these leaves the digest as it was. The golden fixtures
under `test/fixtures/golden-digest/` pin each of them.

## Canonical form

The digest input is one JSON value, written by one function per section, then
serialised and hashed.

1. **Layout.** An object with the keys `format` (the constant
   `spec-gate-digest/1`), `base_commit`, `commands_ref`, `retired_ids`,
   `goal`, `acceptance`, `non_goals`, `defaults`, `decisions`, `residuals`,
   `source_ledger`, `test_plan` and `commands`. A missing optional field is
   left out, never written as `null`; a missing `GOAL` is `null`.
2. **Rows sorted by ID.** Rows of a section are sorted by the prefix of their
   ID in code-unit order, then by the number in the ID as an integer, so
   `AC-2` comes before `AC-10`. The same order applies to lists that are sets
   of IDs: `retired_ids`, an `AC`'s `source`, a source-ledger entry's
   `targets` and a test-plan row's `covers`. The `paths` of an `NG` are a set
   too and are sorted by code units. `steps` of a runtime row is a sequence
   and keeps its order; so does every argv list.
3. **Whitespace.** In every text of the spec and the test plan, each run of
   the ASCII characters space, tab, line feed, carriage return, form feed and
   vertical tab becomes one space, and a space at either end is removed.
   Other Unicode space characters are kept, so a change to one of them
   changes the digest. Commit IDs and argv elements are not normalised: an
   argument with two spaces is another argument. No other normalisation is
   applied (no case folding, no Unicode normalisation).
4. **Keys.** The keys of every object are sorted as RFC 8785 says: by UTF-16
   code units. Files may list their keys in any order.
5. **Numbers and strings.** Numbers (`baseline`, `threshold`, `runs`) keep
   their JSON type: `120` and `"120"` are different values. They are written
   as ECMAScript writes them. Strings are written as JSON does, escaping only
   `"`, `\` and the characters below U+0020.
6. **Canonical JSON.** RFC 8785 (JSON Canonicalization Scheme), implemented in
   `src/canonical/jcs.ts` without a dependency, and tested against the RFC's
   examples. No whitespace between tokens.
7. **Hash.** SHA-256 over the UTF-8 bytes of the canonical JSON, written as
   `sha256:` and 64 lower-case hex digits.

A file that is not valid UTF-8 is an error and is never decoded with
replacement characters, so two different files cannot give one digest.

## Reading the inputs

`<spec-dir>` holds `spec.md` and `testplan.yaml`; both must exist (an empty
plan is written `[]`). A link, a directory or a file over 4 MiB in their
place is an error.

`--repo <path>` is the git repository `commands_ref` is read from. Without
it the repository is the git top level of `<spec-dir>`. When both are
possible, `--repo` wins. `commands_ref` must name a commit in that
repository whether or not a row refers to a command. The commands file is
read only when at least one row refers to a command; a spec without static
rows has a digest even if the file is missing or broken at `commands_ref`.

## Errors

Any error means no digest: nothing is written to stdout, a report goes to
stderr and the exit code is 1. A format error of `spec.md`, `testplan.yaml`
or the commands file is reported with the format layer's own codes, one line
each, behind a line that names the file. A usage error (a missing argument,
an unknown option) is reported by the option parser and exits non-zero too.

| Code | Meaning |
|---|---|
| `spec-dir-invalid` | `<spec-dir>` is not a directory |
| `input-missing` | `spec.md` or `testplan.yaml` does not exist |
| `input-not-regular` | one of them is a link, a directory or another non-file |
| `input-too-large` | one of them is over 4 MiB |
| `input-not-utf8` | one of them is not valid UTF-8 |
| `input-unreadable` | one of them cannot be read |
| `spec-invalid` | `spec.md` does not parse; the format errors follow |
| `testplan-invalid` | `testplan.yaml` does not parse; the format errors follow |
| `repo-not-found` | no `--repo`, and `<spec-dir>` is not inside a git work tree |
| `repo-invalid` | `--repo` is not a git repository |
| `git-failed` | `git` is missing, timed out or could not read an object |
| `commands-ref-unresolvable` | `commands_ref` is not a commit in the repository |
| `commands-file-missing` | a row refers to a command and `.spec-gate/commands.yaml` is not a file at `commands_ref` |
| `commands-file-invalid` | the commands file at `commands_ref` does not parse or is not UTF-8; the format errors follow |
| `command-ref-unknown` | a row refers to a command the commands file at `commands_ref` does not define |

The environment of every `git` call has no `GIT_*` variable of the caller, and
sets `GIT_NO_REPLACE_OBJECTS`, so that a replace ref cannot change what a
commit ID names, and `GIT_NO_LAZY_FETCH`, so that a read never goes to the
network.

## Golden fixtures

`test/fixtures/golden-digest/` holds a base spec directory with every
normative field and every excluded file, the repository content its
`commands_ref` names, and a table of variants. The commit ID in the base spec
is reproducible because the fixture commit is made from fixed inputs. For each
variant the table says whether the digest must change. The digests of the base
and of every changing variant are committed in `expected.json`.
`UPDATE_GOLDEN=1 npm test` writes them again after an intended change of the
digest format; the diff is then the thing to review.
