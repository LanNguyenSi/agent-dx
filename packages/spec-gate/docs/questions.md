# Questions, answers and status

The three state verbs for `questions.json`. The file format (a `questions`
list and an optional `answers` list, at most one answer per question,
`recommended` only on a `divergence` question) is in
[docs/formats.md](docs/formats.md); the lint rules that read answers
(`residual-open`, `dc-unanswered`, `dc-self-reported`, `question-budget`) are
in [docs/lint.md](docs/lint.md). All three verbs read every file through the
lint's hardened reader, so a link, a non-regular file, a file over 4 MiB or
non-UTF-8 text is refused as a named error (`input-missing`,
`input-not-regular`, `input-too-large`, `input-not-utf8`).

## The frontier: every unanswered question

The format has no field by which one question depends on another, so the
frontier of a spec is exactly its unanswered questions: a question is open
until it has an answer, whatever else is open. `questions` lists them in
numeric ID order (`QN-2` before `QN-10`), each with the fields exactly as the
file holds them, and counts them.

## `spec-gate questions <spec-dir>`

Prints one JSON line (`spec-gate-questions/1`) and writes nothing:

- `spec`: the `spec.md` frontmatter id; `spec.md` is required.
- `questions`: the unanswered questions, numeric ID order.
- `counts`: `total`, `answered`, `unanswered` and `blocking_unanswered`.

A `questions.json` that is absent is no questions. Exits 0 with no unanswered
question, 1 with at least one listed, and 2 on a usage error or a file that
does not load.

## `spec-gate answer <spec-dir> <question-id> ...`

Appends one answer to `<spec-dir>/questions.json`. It refuses, writing
nothing, unless the spec directory is `specs/<name>`, `questions.json` loads,
and the `spec.md` status is `draft`: an answer is recorded only while the
spec is a draft (see the digest note in [docs/digest.md](docs/digest.md),
which keeps `questions.json` out of the digest). The file is replaced through
a temporary file renamed into place, keeping an existing file's permission
bits.

One answer of `--answer <text>` or `--accept-recommended` exactly, plus
`--channel <file|chat|comment>` and `--author <login>`:

- `--answer <text>` is the free answer; `--option <label>` says which option
  label it chose and must be a label of that question.
- `--accept-recommended` answers with the question's `recommended` label
  (the `option` field carries the same label). It is refused on a question
  with no recommendation; it never takes the first option.
- `--comment-url <url>` records the comment that carries the answer; it is
  only allowed with `--channel comment` and must be an `https:` URL.

Provenance is set by code, never typed: `channel` and `author` come from the
flags, and `time` comes from the clock, as a UTC second with a trailing `Z`.
There is no flag or environment override for the time. `--accept-recommended`
on an answer that keeps no `comment_url` is still reported by
`dc-self-reported`: a decision backed only by a self-reported answer has
nothing checkable behind it.

A refusal exits 2 and names its reason: an unknown question, an already
answered one, an `--option` that is not a label, `--accept-recommended`
without a recommendation, both or neither of `--answer` and
`--accept-recommended`, an empty answer or author, a `--comment-url` without
`--channel comment` or not `https:`, a missing, non-regular or invalid
`questions.json`, a status that is not `draft`, or a directory that is not
`specs/<name>`.

### Serialization

`answer` rewrites the whole file deterministically: a fixed key order,
two-space JSON and a trailing newline, so `parseQuestions` of the written text
deep-equals the document that produced it and two runs on one document give
byte-identical files.

## `spec-gate status <spec-dir>`

Prints one offline JSON line (`spec-gate-status/1`), reads no git, writes
nothing: the id, the `status`, the `path` as given, the triage class as the
file stored it and as `src/triage/` derives it with its `profile`, the
question counts, the open residuals, the bindings counted by status together
with the test-plan rows that hold no binding, the `bindings.log` entry count
and propose commit, and the ack count.

A file that does not load is reported as `null` and names its code in an
`errors` list. An optional file that is simply absent is not an error: a
draft with no `triage.json` reads as no class, and a spec not yet proposed
with no `bindings.log` reads as zero entries. Exits 0 for a report and 2 on a
usage error or a directory that is not one.

## Exit codes

| verb | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `questions` | no unanswered question | at least one listed | usage error or a file that does not load |
| `answer` | the answer was written | (none) | any refusal |
| `status` | a report | (none) | usage error or a directory that is not one |

The code lives in `src/state/answer.ts`, `src/state/questions.ts` and
`src/state/status.ts`.
