# Formats

This page describes the files `spec-gate` reads and writes, how each one is
parsed, and which revision of each input a step reads. The parsers live in
`src/formats/`. They are pure: text (or an already decoded value) in, a
result out, with no file system or network access, and they never throw on
bad input. A parse returns either `{ ok: true, value }` or
`{ ok: false, errors }`. Every error has a stable `code`, a dotted `path`
(`TP-1.kind`, `AC-2.owner`, `[3].phase`; `$` is the document itself), a
human-readable `message` that names the field, row and kind, and, for line
oriented formats, a 1-based `line`.

## Layout

A spec lives in `specs/<id>/` of the target repository, a directory exactly
one level below the top-level `specs/`. `propose` refuses a spec directory
anywhere else (the top level, another directory, one deeper inside `specs/`),
and the `bindings-log` lint rule reports one as `spec-off-layout` at
`proposed` and under `--final` (see [lint.md](lint.md)); the name of the
directory is not compared with the `id`. Repo-wide settings live in
`.spec-gate/`.

| File | Content |
|---|---|
| `specs/<id>/source/ticket.md` | the raw request, unedited |
| `specs/<id>/source/meta.json` | where it came from, a hash, the base and command-set commits |
| `specs/<id>/triage.json` | the triage fields and the derived class |
| `specs/<id>/spec.md` | goal, acceptance, non-goals, defaults, decisions, residuals, source ledger |
| `specs/<id>/testplan.yaml` | the normative checks |
| `specs/<id>/bindings.yaml` | the binding of each check to a concrete test |
| `specs/<id>/bindings.log` | the record of every binding change after `proposed`, written by `propose` and `bind` |
| `specs/<id>/questions.json` | questions and their answers |
| `specs/<id>/evidence/` | evidence envelopes written by a runner |
| `.spec-gate/config.yaml` | repo-wide settings |
| `.spec-gate/commands.yaml` | the only commands a runner may execute |

## Reference states

Every input is read at a named revision. One rule governs all of them: a
reference revision is set by a code step, never by a model role. A model may
write the content of a spec file; it never decides which commit a check is
read at. Repo-wide inputs are read on the default branch (for a pull request,
at its base), never at the head of a spec pull request.

<!-- BEGIN generated: reference-states -->
| Input | Revision read | Set by | Step | Stored in | Ancestry check |
|---|---|---|---|---|---|
| `spec.md` | the head of the spec pull request for lint, digest and propose; the merged default-branch tip once approved | translator writes the content; `propose` sets `status` only | translate, propose | `specs/<id>/spec.md` | none; the approval check compares the digest at the head with the digest at the approving review's commit, and again on the default branch after the merge |
| `testplan.yaml` | as `spec.md` | translator | test plan | `specs/<id>/testplan.yaml` | none; same digest comparison as `spec.md` |
| `bindings.yaml` | the head of the pull request; after `proposed`, compared with the binding reference | translator until `proposed`, then only `bind` | test plan, bind | `specs/<id>/bindings.yaml` | see binding reference |
| `triage.json` | the head of the pull request | discoverer writes the fields; `triage` derives the class | triage | `specs/<id>/triage.json` | none |
| `questions.json` | the head of the pull request | translator writes questions; `answer` writes answers | translate, answer | `specs/<id>/questions.json` | none |
| `.spec-gate/config.yaml` | the default-branch tip; for a pull request its base commit; never the head of a spec pull request | a person, in a pull request of its own | every step that reads it (lint, approval check) | `.spec-gate/config.yaml` | none; a spec pull request that changes any file under `.spec-gate/` is a lint error and is never approved |
| `.spec-gate/commands.yaml` | the file at `commands_ref`; the runner, lint and digest all read this one revision | a person, in a pull request of its own; the translator may only draft a proposal that never runs | every step that reads it (runner, lint, digest) | `.spec-gate/commands.yaml` | the revision is `commands_ref`; see `commands_ref` |
| `source/meta.json` | the head of the pull request | `intake` | intake | `specs/<id>/source/meta.json` | none; it holds `base_commit` and `commands_ref`, and lint checks that the `spec.md` frontmatter matches |
| `base_commit` | the head of the fetched remote default branch at intake; every discovery and baseline check runs there | `intake`; `propose` only verifies and sets nothing | intake | `source/meta.json` and the `spec.md` frontmatter | must be an ancestor of the default branch: of the fetched remote default branch while no pull request exists, of the pull request base afterwards; otherwise a lint error and the runner stops. A spec pull request whose target is not the default branch stops the runner and is never approved |
| `commands_ref` | the head of the fetched remote default branch at intake, the same commit as `base_commit` | `intake`; `propose` only verifies and sets nothing | intake | `source/meta.json` and the `spec.md` frontmatter | must be an ancestor of the default branch, checked as for `base_commit`; the approval check resolves the argv lists at this commit itself and prints them |
| binding reference | `bindings.yaml` at the commit `propose` ran at; once the log is on the default branch and the propose commit is no ancestor of the head (a squash or rebase merge), `bindings.yaml` at the diff base, read from git | `propose`, as the hash of `bindings.yaml` in the first `bindings.log` entry | propose | `specs/<id>/bindings.log` (outside the digest) | the propose commit must be an ancestor of the head; after a squash or rebase merge it may not be, and then the diff base must hold the log of the spec at the same path with the same propose entry, the log at the head must extend it, and only the bind entries after it are checked and replayed; otherwise a lint error |
| start commit | the commit the implementation work started from; closing evidence is compared there | the host, passed as `closure --start <commit>` | closure | not stored; an argument of the closing check | must be a descendant of the merged spec commit; otherwise the closing check stops |
| evidence envelopes | the commit each envelope names in its `commit` field, which the runner reads from its own checkout | the host runner; never a model role | evidence (phase `baseline`) and closure (phase `closure`) | `specs/<id>/evidence/*.json` | `baseline`: the commit must equal `base_commit`, else `stale-evidence`; `closure` (which includes per-slice evidence): the commit must be the start commit or a descendant of it; after a squash merge an envelope stays valid if its commit is reachable from the default branch, otherwise only if it was on the PR branch before the squash and the PR's CI run references it |
<!-- END generated: reference-states -->

The table is exported as `REFERENCE_STATES`; a test fails when this page and
the constant differ. The ancestry checks and the git reads they need are
performed by later steps (lint, propose, approval check, closure); the format
layer only names them.

## IDs

Normative lines carry stable IDs. IDs are never reused: an ID that was
retired stays retired.

<!-- BEGIN generated: id-prefixes -->
| Prefix | Form | Meaning |
|---|---|---|
| `GOAL` | `GOAL` | goal (exactly one per spec) |
| `AC` | `AC-<n>` | acceptance criterion |
| `NG` | `NG-<n>` | non-goal or must-not-change line |
| `DF` | `DF-<n>` | default (an answer set by the translator, with reason) |
| `DC` | `DC-<n>` | decision (an answer given by a person) |
| `RS` | `RS-<n>` | residual (an open point carried into the spec) |
| `SL` | `SL-<n>` | source-ledger entry |
| `TP` | `TP-<n>` | test-plan row |
| `QN` | `QN-<n>` | question |
<!-- END generated: id-prefixes -->

`<n>` is a positive integer without leading zeros. Gaps are allowed.

Outside a spec folder (exports, ticket comments) an ID is qualified with the
spec ID: `<spec-id>#AC-1`. A spec ID is lower-case letters and digits in
hyphen-separated groups, at most 64 characters. `parseQualifiedId` and
`formatQualifiedId` convert both ways.

**Retired IDs.** `retired_ids` in the `spec.md` frontmatter lists every
numbered ID that was once used and has been withdrawn. It lives there
because it belongs to the spec's normative text, is reviewed in the same
diff as the lines it retires, and is the only place a later check can read
it without another file. The parser rejects a file in which a retired ID is
also a live line. A later lint step compares the list with the version on
the base: a retired ID that disappears from the list, or a live ID that was
retired on the base, is reuse.

**Duplicate IDs** within a file are rejected by the parser.

**Source line IDs.** The source ledger refers to lines of the original
request by `L<position>-<hash>`.

- A request is split into units. Line breaks are `\n`, `\r\n` or `\r`. A
  fenced code block (three or more backticks or tildes, up to the matching
  fence or the end of the text) is one unit, even when empty. As in
  CommonMark, a backtick fence opener has no backtick after its opening run,
  so a line such as "```npm test``` runs" is an ordinary line. A Markdown image
  `![alt](target)` is one unit of its own, cut out of its line; the rest of
  the line is a unit if anything is left, and comes before the images.
  Every other line is a unit. Indented code blocks are not recognised. A
  request over 1 MiB is refused with an `input-too-large` error, and image and
  link recognition is a linear scan.
- Text is normalised by: Unicode NFC; stripping leading block markers
  (block quote `>`, heading `#` to `######` plus a space, list bullets `-`,
  `*`, `+`, `<digits>.`, `<digits>)`, task boxes `[ ]`, `[x]`); turning a link
  `[text](url)` into `text url`; removing the inline markers `*`, `_`,
  `` ` ``, `~` and the table pipe `|`; collapsing whitespace to single
  spaces; and trimming. A line left with only `-`, `=`, `:` and spaces
  (a rule, a table separator row) is empty. A code unit's text is `code:`
  plus its content with whitespace collapsed; an image unit's text is
  `image:` plus its target. Case is kept.
- Empty units are dropped and the rest numbered from 1: that is the position.
- The hash is the SHA-256 of the UTF-8 bytes of the normalised text, and the
  ID uses its first 12 lower-case hex characters, for example
  `L3-64ec88ca00b2`.

A line keeps its ID while its text does not change, wherever the formatting
changes; inserting a line above it changes the position part only.

## source/meta.json

Written by `intake`. A file adapter records a local ticket file:

```json
{
  "adapter": "file",
  "origin": "ticket.txt",
  "fetched_at": "2000-01-31T12:00:00.000Z",
  "sha256": "<sha256 of the raw bytes>",
  "trust": "untrusted",
  "sections": [{ "name": "body", "author": null, "sha256": "<same hash>" }],
  "attachments": [],
  "raw": true,
  "lines": [{ "id": "L1-64ec88ca00b2", "kind": "text" }],
  "base_commit": "<40 or 64 hex>",
  "commands_ref": "<40 or 64 hex>"
}
```

The keys appear in exactly this order, the file is 2-space JSON with a
trailing newline. `origin` is the source path as given on the command line,
informative only. `fetched_at` is the wall-clock time of the intake in ISO
8601 UTC. `sha256` is the hash of the raw bytes of the file. `trust` is
always `untrusted`: intake never vouches for content. `sections` for the
file adapter is exactly one entry, `{ "name": "body", "author": <--author
or null>, "sha256": <hash of the raw bytes> }`. `attachments` holds one
entry per `--attach` in command-line order: `{ "name": <basename>,
"sha256": <hash>, "size": <bytes>, "type": <type from the extension> }`;
the extension table is small and fixed, an extension outside it becomes
`application/octet-stream`, and the attachment file itself is never copied
into the repository. `raw` is `false` with `--no-raw`, when
`source/ticket.md` is not written. `lines` is always present, with and
without raw: `{ "id", "kind" }` per non-empty unit of `splitSourceLines`,
with the ID from `formatSourceLineId`, so the ledger works either way.
`base_commit` and `commands_ref` are the same commit: the head of
`refs/heads/<default branch>` on the remote, 40 hex characters (SHA-1) or 64
(SHA-256), and nothing else. Only code sets them; no option and no input file
sets or overrides them. The default branch is read from the remote's own HEAD
symref and must be a valid branch name under `refs/heads/` that does not start
with `-`; otherwise intake stops with `bad-default-branch`. The remote is named
by `--remote` and must be a configured remote (a plain name; a URL, a path or
`.` is refused with `bad-remote`, an unknown name with `no-remote`). Intake
fetches the full ref `refs/heads/<default branch>` only, so a tag of the same
name is never picked; it writes no local ref, fetches no tag, prunes nothing,
reads the commit id from the one line `FETCH_HEAD` holds and peels it to a
commit. Every git call runs without a shell, without any `GIT_*` variable of
the caller, without a terminal prompt and with a timeout that kills the whole
process group; an error message never carries a command line, a URL or git's
own output. The fetch passes `--write-fetch-head` explicitly, so a repo-local
`fetch.writeFetchHEAD=false` cannot leave a stale FETCH_HEAD standing in for
the fetch.

The remote is trusted as configured: its URL and the repository-local git
config (a `url.<base>.insteadOf` rewrite, a remote whose URL is a local path)
are used as given, so a configured remote whose URL is a local path yields
that repository's default-branch head. Integrity against the shared upstream
is checked later by lint, not by intake.

Before anything is written the raw bytes are scanned for secret patterns: a
private key header (also `PRIVATE KEY BLOCK`), an AWS access key id, a GitHub
token (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), a Slack token,
and a generic assignment whose key contains `password`, `secret`, `token`,
`api_key`, `api-key` or `apikey` anywhere (`DB_PASSWORD`,
`AWS_SECRET_ACCESS_KEY`, `access_token`, `apiKey`) with an optional closing
quote after the key (`"password": "..."`) and a quoted value of 12 characters
or more. A value without quotes is not caught by the generic pattern. A match
is an error that names the pattern and the line and never prints the value,
and nothing is written. Input that is UTF-16 (a byte order mark) or holds a
NUL byte is refused with `source-encoding`, because the scan reads UTF-8 text.

`intake file` writes `specs/<id>/source/` with `ticket.md` first and
`meta.json` last, each through a temporary name and a rename. `source/` is
created without overwriting anything: an existing one (also a dangling
symlink) is `source-exists`. A `specs` or `specs/<id>` that already exists as
a symlink (to anywhere) is refused as `source-not-in-repo` before anything is
created, so nothing is written outside the repository through it. If a write
fails, everything the command created is removed again. `meta.json` is written
last, so a `source/` directory without a `meta.json` is the leftover of a run
that was killed.

Exit codes of `intake file`: 0 on success, 2 on an error (a named code on
stderr, nothing on stdout, nothing written). A usage error of this command (a
missing `--id` or `<path>`, an unknown option) and an unexpected exception
also exit 2. `--help` and `--version` exit 0. With `--check`: 0 when the file
is unchanged, 1 on drift, 2 on an error (no recorded `meta.json`, a
`meta.json` that is not strict JSON, not an object, or without a `sha256`
string and a `lines` array of `{ id, kind }`). `intake file --check` reads the
existing `meta.json` and the file again, fetches nothing and writes nothing:
same hash exits 0 with `{ "status": "ok" }`, a different hash exits 1 with
`{ "status": "source-drift", "changed_lines": [...], "added": [...],
"removed": [...] }`, where the diff aligns the recorded `lines` with the
current ones by position and `changed_lines` lists `{ "old", "new" }` IDs
of positions whose ID changed, `removed` old IDs of positions no longer
present and `added` new IDs of new positions, each in position order. A
different hash can come with three empty lists: a change that the line
normalisation does not see (extra blank lines, for example) still exits 1,
because the bytes changed.

## spec.md

Markdown with YAML frontmatter, read by a line grammar. A model can write it,
a person can read it in a diff, and no Markdown engine is involved.

```markdown
---
id: password-change-logout
source: source/meta.json
base_commit: <40 or 64 hex characters>
commands_ref: <40 or 64 hex characters>
status: draft
retired_ids: []
---

## Goal

- GOAL: After a password change, every existing session ends.

## Context

Free prose. Nothing in it is normative.

## Acceptance

- AC-1: A token issued before a password change is rejected with HTTP 401.
  - source: SL-1, SL-2
  - owner: alice
```

Frontmatter: `id`, `source` (always the literal `source/meta.json`),
`base_commit`, `commands_ref`, `status`
(`draft`, `proposed` or `superseded`) are required. `superseded_by` is
required with `superseded` and not allowed otherwise. `retired_ids` is
optional. Unknown keys are rejected; in particular there is no `approved`:
approval is derived, never stored. The frontmatter is YAML parsed with the
rules under "YAML and JSON input" below.

Sections are `## ` headings with these exact titles, each at most once, in
any order: `Goal`, `Context`, `Acceptance`, `Non-goals`, `Defaults`,
`Decisions`, `Residuals`, `Source ledger`. A section may be absent, which
reads as empty. Any other `## ` heading is an error, so no normative line can
hide behind an unknown heading. A line before the first section must be blank
or a `# ` title line.

Context is free prose. It ends at the next line that starts at column 0 with
`## ` (two hashes and a plain space), and at nothing else. Code fences,
indented headings and setext headings do not end it: a line that renders as a
heading or opens a code block is prose here. A `## ` line inside what looks
like a code block does end Context, so it is a section start or an
unknown-section error; both fail closed. `###` and deeper headings are only
allowed there. The parser reads a Context line for three things only: whether
it is such a `## ` line, the character rule, and the lookalike rule. Apart from
that, the result of parsing never depends on what Context says.

**Heading lookalikes.** A Context line that reads like the heading of a known
section is an error (`context-heading-lookalike`, at `section.<title>` with
the line number). A reader would take the lines below it for that section,
while the parser reads them as prose. So an indented or underlined heading is
prose only as long as its words are not a known title. The test reduces a
line: Unicode NFKC, then everything but ASCII letters and `#` is removed, then
lower case. Two shapes are refused:

- One to six `#`, a known title reduced the same way, and optionally closing
  `#`. This covers a heading that is indented, has a tab, a no-break space or
  an invisible character before, between or after the hashes, has no space
  after them, is written in fullwidth forms, or differs in case or
  punctuation: ` ## Acceptance`, `#Defaults`, `### goal:`.
- A known title, reduced the same way, above an underline: after NFKC and
  without whitespace and other characters that are neither printable ASCII nor
  a letter or digit, the underline is one or more `-` or one or more `=`. The
  title may span lines (`Source`, then `ledger`, then `---`): the line above
  the underline is reduced alone and together with the lines directly above
  it, up to a blank line or another underline, and each of these texts is
  compared. The error is at the line the title starts on.

A third shape is refused whatever its text: a Context line that holds the
opening tag of an HTML heading, `<h1>` to `<h6>`, in any case, with or without
attributes, anywhere in the line, also when the tag breaks off at the end of
the line and goes on in the next. Such a tag renders as a heading. The error
is the same `context-heading-lookalike`, at `$`, because it names no section.
A closing tag alone is not refused.

A heading with any other words stays prose (` ## notes on goals`, `### Open
points`), and so does a known title with no underline below it. The rule also
refuses a sub-heading in Context whose only words are a known title, such as
`### Decisions`; word it differently. It does not apply outside Context, where
such a line is already an error, and it does not change what a column-0 `## `
line is.

Not recognised, and so still prose:

- a heading with an unknown title, indented or not at column 0, such as
  ` ## Acceptance criteria`;
- a known title spelled with a letter of another script that looks the same
  (the Cyrillic letter U+0435 for the `e` in `Defaults`), or with an ASCII
  character that looks the same (a capital `I` or the digit `1` for a small
  `l`): the rule compares ASCII letters after NFKC and nothing else;
- a title over a row of other line-like characters: dash punctuation other
  than `-` (en dash, em dash, U+2010, the minus sign), box drawing,
  underscores;
- a title with a blank line between it and the `---`;
- hashes written as HTML character references, such as `&#x23;&#x23;`.

**Error limits.** A document lists at most 100 `forbidden-character` errors
and at most 100 `context-heading-lookalike` errors. When there are more, one
more error, `too-many-errors` at `$`, states the total for that code. This
holds for `spec.md` and for the raw-text check of a YAML file; no other error
is limited.

**Characters.** Every line of `spec.md` is checked against the rule under
"Forbidden characters" below, before anything else reads the line and with no
exemption: frontmatter lines and their comments, the title line, `## ` heading
lines, Context lines, lines that hold nothing visible, and lines below an
unknown heading are checked like item and attribute lines. Context is included
because a line is a heading only by its first three characters: with a
zero-width space in front of `## Defaults`, or between or after the hashes, a
reader sees a heading and the parser sees prose, and every section below it
would be read as Context. The error names the item or attribute where the line
is one (`AC-1.owner`), `frontmatter` for a frontmatter line and `$` for any
other line, always with the line number, once per line.

In every other section, every non-blank line is an item or an attribute:

- Item: `- <ID>: <text>` at column 0. The text is one line. The ID must
  belong to the section.
- Attribute: `  - <key>: <value>` indented by exactly two spaces below its
  item. One level more, indented by four spaces, exists below `provenance`
  only. Spaces only, no tabs.

| Section | ID | Attributes |
|---|---|---|
| Goal | `GOAL` | none |
| Acceptance | `AC-n` | `source`: `SL-n` IDs, comma separated; `owner`: who stands behind the requirement today (`none` records that nobody does); both required |
| Non-goals | `NG-n` | `paths`: comma separated repo-relative paths or globs, optional; a line without paths describes behaviour and is checked by review only |
| Defaults | `DF-n` | `reason` and `affects_behavior` (`true` or `false`), both required |
| Decisions | `DC-n` | `question`: a `QN-n` ID; `provenance` block with `channel` (`file`, `chat`, `comment`), `author`, `time` (ISO 8601 UTC) and optional `comment_url` |
| Residuals | `RS-n` | `class` (`divergence`, `blind-spot`, `untestable`), `status` (`open`, `resolved`), optional `question` |
| Source ledger | `SL-n` | the item text is `<source line ID> -> <targets>`: targets are `AC`, `NG`, `DF`, `DC` or `RS` IDs separated by commas, or `out`; `out` takes a required `reason`, and no other entry takes one |

The parser rejects: a missing frontmatter or section grammar violation, an
unknown section or attribute, a Context line that reads like a known heading,
a forbidden character on any line, a missing required attribute, an ID of the
wrong shape or in the wrong section, a duplicate ID, an ID listed in
`retired_ids` that is also live, a duplicate attribute, a source line mapped
by two ledger entries, bad indentation.

It does not check what a lint step owns: exactly one `GOAL`, a non-empty
Non-goals section, that every AC is covered by a test-plan row, that the
ledger covers every source line, that a reference such as `SL-9` or `QN-4`
points at something that exists.

## testplan.yaml

A YAML list of rows. Every row has `id` (`TP-<n>`, unique), `covers` (a
non-empty list of `AC`, `DF` or `NG` IDs), `kind` and `claim`. The other
fields depend on the kind. A kind is a way of proving a claim.

<!-- BEGIN generated: kinds -->
| Kind | Required (besides id, covers, kind, claim) | Optional (besides input, expected, oracle, level, seam, notes) | Binding status at `proposed` | Later evidence |
|---|---|---|---|---|
| `red-first` | `red_reason`, `expected`, `oracle` | `fail_match` | new | per slice red for the stated reason, then green |
| `stays-green` | `probe_hint` | none | existing | green at the start commit and afterwards, plus a probe |
| `measurement` | `baseline`, `threshold`, `runs` | none | any | measured values before and after |
| `static` | `check_command_ref` | none | any | exit code 0 of the referenced command |
| `manual` | `verifier`, `evidence_location` | none | none | evidence at the stated location |
| `runtime` | `environment`, `steps`, `expected`, `evidence_location` | `control`, `method` | any | evidence of the steps run in the stated environment, at the stated location |
| `post-deploy` | `check`, `environment` | none | any | evidence after deploy; the row is reported as pending until then |
<!-- END generated: kinds -->

The kind set is a working set. `post-deploy` is documented but not yet
validated by real usage, so its field set may change. `runtime` describes a
check run against a running system: `steps` is a non-empty list, `control`
(`base`, `negative` or `none`) says which control run accompanies it, and
`method` (`browser` or `script`) says how the steps are carried out.
`stays-green` is tied to binding status `existing`: the test it names must
already exist.

Value rules: `runs` is a positive integer; `baseline` and `threshold` are a
non-empty string or a number; every integer a format field holds must lie
in the IEEE-754 safe range `-(2^53-1)` to `2^53-1`, because a bigger one
has no exact representation once the document is decoded (two spellings of
it can arrive as one value); a big integer that must stay exact is written
as a quoted string; `check_command_ref` is a command name as in
`commands.yaml`; every other field is a non-empty string, `steps` a list of
them. Evidence is never a field of the plan.

### Field layers

Every field belongs to one layer.

- `normative`: what the approver signs off. It is part of the digest.
- `binding`: ties a row to a concrete test. It lives in `bindings.yaml` and
  may change after the spec is proposed.
- `informative`: notes, never read by a check.

<!-- BEGIN generated: field-layers -->
| Field | Layer | Used by |
|---|---|---|
| `id` | normative | testplan.yaml (every kind) |
| `covers` | normative | testplan.yaml (every kind) |
| `kind` | normative | testplan.yaml (every kind) |
| `claim` | normative | testplan.yaml (every kind) |
| `input` | normative | testplan.yaml (every kind) |
| `expected` | normative | testplan.yaml (every kind) |
| `oracle` | normative | testplan.yaml (every kind) |
| `level` | normative | testplan.yaml (every kind) |
| `seam` | normative | testplan.yaml (every kind) |
| `red_reason` | normative | testplan.yaml (red-first) |
| `fail_match` | normative | testplan.yaml (red-first) |
| `baseline` | normative | testplan.yaml (measurement) |
| `threshold` | normative | testplan.yaml (measurement) |
| `runs` | normative | testplan.yaml (measurement) |
| `check_command_ref` | normative | testplan.yaml (static) |
| `verifier` | normative | testplan.yaml (manual) |
| `evidence_location` | normative | testplan.yaml (manual, runtime) |
| `check` | normative | testplan.yaml (post-deploy) |
| `environment` | normative | testplan.yaml (runtime, post-deploy) |
| `steps` | normative | testplan.yaml (runtime) |
| `control` | normative | testplan.yaml (runtime) |
| `method` | normative | testplan.yaml (runtime) |
| `probe_hint` | normative | testplan.yaml (stays-green) |
| `status` | binding | bindings.yaml |
| `selector` | binding | bindings.yaml |
| `file` | binding | bindings.yaml |
| `fixtures` | binding | bindings.yaml |
| `notes` | informative | bindings.yaml; testplan.yaml (every kind) |
<!-- END generated: field-layers -->

The table is exported as `FIELD_LAYERS`. A row field with no entry is an
error (`unknown-field`) naming the field and the row. A field that has a layer
but belongs to the other file is `wrong-layer-field`, for example `selector`
in `testplan.yaml` or `claim` in `bindings.yaml`. A known field the row's kind
does not use is `field-not-allowed-for-kind`. A missing required field is
`missing-field` naming the kind, the row and the field.

## bindings.yaml

A mapping from `TP-<n>` to a binding. Only `status` is required: `new` (the
test is to be written) or `existing` (the test already exists). Optional:
`selector`, `file` (a repo-relative path), `fixtures` (a list of paths,
default empty) and `notes`. `file` and every `fixtures` entry are
repo-relative paths: no `..` segment, not absolute, not starting with `-`.
A `manual` row has no binding. A selector is
later passed to a test runner as one argument, never through a shell, so the
parser rejects an empty selector (`empty-value`), one with a forbidden
character (`forbidden-character`) and one that starts with `-`
(`invalid-selector`).

## bindings.log

Written by `propose` (its first line) and `bind` (every later line), never by
hand. It records every binding change after the spec became `proposed`, and the
`bindings-log` lint rule (see [lint.md](lint.md)) checks that `bindings.yaml`
at the head is what the log says it is. It lies outside the digest.

The file is JSON lines: one JSON object per line, every line ending in a line
feed (a carriage return anywhere, a blank line or a missing final line feed is
an error), each line strict JSON without duplicate keys. A byte order mark at
the start is removed by the reader, as for every file of a spec directory.

Line 1 is the propose entry, and there is exactly one:

```json
{"seq":1,"kind":"propose","commit":"<40 or 64 hex>","bindings":"sha256:<64 hex>"}
```

`commit` is the full id of the commit `propose` ran at (its `HEAD`), and
`bindings` the SHA-256 of the raw bytes of `bindings.yaml` in that commit: the
binding reference of the reference-state table above. Every later line is a
bind entry:

```json
{"seq":2,"kind":"bind","tp":"TP-1","binding":{"status":"existing","selector":"...","fixtures":[]},"prev":"sha256:<64 hex>"}
```

- `seq` is the line number: it starts at 1 and grows by exactly 1 per line.
- `tp` is one `TP-<n>` ID; `binding` is its full new binding, not a change to
  the old one, in canonical form: the bindings format above, its keys in the
  order `status`, `selector`, `file`, `fixtures`, `notes`, an absent optional
  key left out and `fixtures` always there.
- `prev` is the SHA-256 of the UTF-8 bytes of the line before, without its
  line feed. A line that is changed, removed, inserted or moved breaks the
  chain at the line after it.

Each entry has exactly these keys. The replay of a log is `bindings.yaml` at the
propose commit with the binding of every bind entry put in place in order; a
bind entry never adds an ID.

## triage.json

The discoverer's reading of the request. Each of `single_goal`,
`code_related`, `core_is_decision`, `scope_within_request`,
`multiple_repos` and `trivial` is `{ "value": "yes" | "no" | "unknown",
"evidence": "<text>" }`. `blocking_unknowns` is a list of strings.
`class` (`unsuitable`, `decision`, `split`, `clarify`, `no-spec-needed`,
`actionable`) and `rule_version` (a positive integer) are written together
by the triage step: a file has both or neither. The rule that maps the fields
to a class is not part of the format: it is a versioned truth table held in
[docs/triage.md](triage.md) and in `src/triage/`.

## questions.json

```json
{
  "questions": [
    {
      "id": "QN-1",
      "target": "AC-2",
      "class": "divergence",
      "blocking": true,
      "question": "Should old sessions stay valid?",
      "options": [
        { "label": "revoke", "consequence": "all sessions end at once" },
        { "label": "keep", "consequence": "old sessions stay until expiry" }
      ],
      "recommended": "revoke",
      "evidence": "the request says to log out everywhere"
    }
  ],
  "answers": [
    {
      "question": "QN-1",
      "answer": "revoke",
      "option": "revoke",
      "channel": "comment",
      "author": "alice",
      "time": "2000-01-31T12:00:00Z",
      "comment_url": "https://example.com/issues/1#comment-2"
    }
  ]
}
```

`target` is a spec or test-plan ID or a source line ID. `class` is
`divergence`, `blind-spot` or `untestable`. A question has at most four
options; `recommended` exists only for `divergence` and must be one of the
labels. A free answer is always possible: `answer` is free text, `option`
(optional) names the label it chose. An answer must point at an existing
question and each question has at most one answer. `channel` is `file`,
`chat` or `comment`; `comment_url` is optional. `answers` may be absent.

## config.yaml

```yaml
questions:
  warn_above: 7
approvers: [alice, bob]
agent_identities: [spec-bot]
signing_keys: []
```

Every key is optional. Defaults: `questions.warn_above` is 7, the three lists
are empty. An empty file is an error; write `{}` to accept every default.
A person who is both an approver and an agent identity is not a parse error;
the approval check reports it.

## commands.yaml

```yaml
discovery:
  argv: ["npx", "vitest", "list"]
commands:
  unit:
    argv: ["npx", "vitest", "run", "-t", "{selector}"]
  typecheck:
    argv: ["npm", "run", "typecheck"]
```

A command is an argv list and never a shell string; a string where an argv
list belongs is rejected (`shell-string`). `{selector}` is the only
placeholder. It is valid only as a whole argv element (`selector-embedded`
otherwise) and never as the program (`selector-as-program`). `discovery` is
the command whose output lists the valid selectors; it takes no placeholder
and is required once any command uses `{selector}`. At most one command may
use `{selector}` (`multiple-selector-commands`): a binding carries no command
reference, so one selector template is the only one a runner can pick; a
later version may add a binding-layer `command` field and lift this. Any other
whole element of the form `{name}` (braces around an identifier, any case,
optional inner spaces) is rejected (`unknown-placeholder`), and so are case
and spacing variants of `{selector}`. Command names are
lower-case letters, digits, `.`, `_` and `-`, at most 64 characters; a
test-plan row refers to one by `check_command_ref`. The parser does not stop
a person from writing a shell as the program (`["sh", "-c", "..."]`); the
pull request that adds a command is where that is reviewed.

## Evidence

A runner writes one envelope per check. Envelopes are JSON Lines (one object
per line) or one object per file. The schema is shipped as
`schemas/evidence-envelope.json`, a copy of the reference runner's schema; a
test pins the copy byte for byte. Envelopes are validated in code, field for
field, without a schema library.

Evidence has two phases, named by the envelope's `phase`:

- `baseline`: gathered at `base_commit` while the spec is written.
  Informative, and the only phase that can be marked `stale-evidence` (its
  commit, cleanliness, command-set digest or selector no longer match).
- `closure`: gathered at the start commit or later, against the work as it is
  built and finished. Per-slice red and green evidence carries this phase. It
  decides the closing check and is never stale.

After a squash merge, the rule is keyed on the commit an envelope names, not
on its phase. An envelope whose commit is reachable from the default branch
after the merge stays valid. Any other envelope stays valid only if its commit
was on the pull request branch before the squash and the pull request's CI run
references that commit; otherwise it does not count. Without a squash merge
the rule does not apply. The three facts are git and host questions: the
closing check answers them and passes them to `evidenceSurvivesSquash`;
nothing in the format layer runs git.

## Forbidden characters

A text may not contain a character of these Unicode general categories:

- `Cc` (control): C0 and C1 controls, DEL, line feed, carriage return, NEL.
  A tab is allowed, except in an argv element.
- `Cf` (format): zero-width and direction marks, bidirectional embeddings,
  overrides and isolates, byte order mark, word joiner, soft hyphen, Arabic
  letter mark, tag characters.
- `Zl` and `Zp`: the line separator and the paragraph separator.
- `Cs` (surrogate): a surrogate without its partner, which makes a string
  ill-formed. Two different lone surrogates become the same UTF-8 bytes, so a
  hash could not tell them apart. A well-formed pair, such as an emoji outside
  the basic plane, is one character of another category and passes.

Such a character makes a text read differently from what a parser or a
reviewer sees. The rule is by category, so a character added to a category
later is caught without a change; `Cn` (unassigned) is not part of it because
its contents depend on the runtime's Unicode version. The function is
`findForbiddenCharacter`, the error is `forbidden-character`, and its message
names the code point.

The rule is applied twice:

- To the raw text, line by line, before anything is parsed: every line of
  `spec.md` (see there), and every line of `testplan.yaml`, `bindings.yaml`,
  `config.yaml` and `commands.yaml`, comments included. A line ends at a line
  feed, alone or after a carriage return, and at nothing else, so any other
  carriage return, a line separator or NEL is a character of its line and is
  refused. A YAML parser drops comments and breaks lines only at a line feed;
  without this check a comment could show a reader a row or a key that the
  parser never reads. In a YAML file the error is at `$` with the line number,
  one per line. One byte order mark at the very start of `spec.md` or of a
  YAML file is accepted and ignored.
- To decoded values: every string field of `testplan.yaml`, `triage.json`,
  `questions.json`, `bindings.yaml` and `config.yaml`, every frontmatter
  value, and every argv element in `commands.yaml`. This finds a character
  written as an escape sequence (`"​"`), which is clean as raw text. The
  error is at the field, once per field. The raw text of a JSON file is not
  checked on its own: JSON has no comments, and outside a string it allows
  only spaces, tabs, line feeds and carriage returns.

**Single-line fields.** Every string field is one line: a line feed is a
control character, so a value that holds one is refused. In YAML this refuses
a literal block scalar (`|`), a folded one that keeps its final line end (`>`,
`>+`), and any block scalar whose value still holds a line feed after folding.
A folded, stripped scalar (`>-`) whose lines fold into one, a stripped literal
scalar (`|-`) of one line, and a plain or quoted scalar continued on the next
line are accepted, because their value is one line.

**What the rule leaves out.** It refuses categories, not everything that
renders as nothing. A character outside the five categories that shows as
blank, or not at all, is accepted: a space separator such as the no-break
space U+00A0, a thin space or the ideographic space U+3000 (`Zs`), a Hangul
filler such as U+3164 (`Lo`), a variation selector or the combining grapheme
joiner (`Mn`), a private-use character (`Co`). In Context, where such a
character at the hashes could make a line read like a heading, the lookalike
rule of `spec.md` refuses the line when the title is a known one. The rule
does refuse the zero-width joiner, so an
emoji sequence joined with it is refused; a single emoji and accented or CJK
text pass. The selector, command and CI run reference of an evidence envelope
and the raw request in `source/ticket.md` are not subject to the rule: a
runner writes the first three, and the request is kept unedited.

## YAML and JSON input

YAML is parsed as YAML 1.2 with the core schema, so `yes`, `no`, `on`, `off`
and timestamps stay strings. Duplicate mapping keys, aliases, anchors and
explicit tags are errors, on every node whatever its type (root, mapping
value, sequence item, mapping key; block or flow; collection or scalar); a
merge key `<<` is not merged and is then an unknown field. As a second, independent
check, a decoded value must hold only plain objects, arrays, strings, numbers,
booleans and null; a `Set`, `Map` or `Date` is refused. A file is exactly one document and must not be empty. Before a YAML
text is parsed, its lines are checked against the rule under "Forbidden
characters". JSON is
parsed strictly, and duplicate object keys are errors (`JSON.parse` would
silently keep the last one). Inputs over 1 MiB are rejected. A collection used
as a mapping key is an error, and keys are compared as the strings they
become in the resulting object. The duplicate check is linear in the number
of keys.

The parsers expect a string (or an already decoded value for the `validate*`
functions). Anything else is a programming error and may throw a `TypeError`;
they never throw on a string, whatever it contains.

None of the files carries a format version. A later version key will treat its
absence as version 1.
