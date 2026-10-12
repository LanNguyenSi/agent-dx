# `patch`

Replace exact text in one or more files, all or nothing. Part of the [agent-primitives](../README.md) CLI.

An agent that edits files through a shell tends to write a small
read-replace-write script or a `sed -i` call for every change. Those
scripts replace the first match when the text occurs twice, write the
first file before finding out that the edit for the second file does not
match, rewrite line endings, and leave backup files behind. `patch` takes
the same old/new pairs and does the checks once, in one place.

```bash
agent-primitives patch --plan edits.json
agent-primitives patch --plan edits.json --dry-run
agent-primitives patch --file src/a.ts --old 'return 1;' --new 'return 2;'
agent-primitives patch --file src/a.ts --old-file old.txt --new-file new.txt
```

Global options (`-f`, `-C`, `-m`, `-l`, `--json`) go before the
subcommand. `--file` is long-only, since the global `-f` is `--format`.

## Input

A plan is a JSON object with one key, `edits`:

```json
{
  "edits": [
    { "file": "src/a.ts", "old": "return 1;", "new": "return 2;" },
    { "file": "src/b.ts", "old": "foo(", "new": "bar(", "replaceAll": true }
  ]
}
```

- `file`, `old` and `new` are strings; `replaceAll` is an optional
  boolean. Any other key, a missing field, a field of the wrong type or an
  empty `edits` list is a usage error (`reason: "plan_invalid"`), so a
  misspelled key never does nothing silently.
- An empty `old` is refused (`reason: "empty_old"`). An empty `new`
  deletes the matched text.
- `file` paths resolve against the `-C` directory (default: the process
  cwd), not against the plan file's directory.
- `--plan -` reads the plan from stdin.

The one-shot form is one edit: `--file <path>` plus `--old <text>` or
`--old-file <path>`, and `--new <text>` or `--new-file <path>`, and
optionally `--replace-all`. `--old-file`/`--new-file` take the file's
content verbatim, including a trailing newline, which then has to match
too; they avoid shell quoting for text with quotes, `$` or backticks
(`-` reads stdin, for one of the two). `--plan` cannot be combined with
any one-shot flag (`reason: "option_conflict"`).

CRLF in `old` and `new` is read as LF; see "Line endings and bytes" for
how the file's own endings are kept.

## How edits are resolved

Nothing is written until every edit of the plan has been resolved
against the current content of every file it names. Any edit that is
missing, ambiguous or overlapping, any refused path and any file that
cannot be read or decoded refuses the whole plan: nothing is written, and
the result reports every edit's own status.

Several edits of one file are all matched against that file's original
content, never against the output of an earlier edit. Their matched
ranges must not overlap; when they do, every edit involved is reported as
`overlap` with `overlaps_with` naming the others. Edits naming one file
by two spellings (`a.txt`, `./a.txt`, or a symlink to it) are grouped as
one file.

Each edit is matched in tiers, and a later tier is tried only when the
earlier ones found nothing:

1. `exact`: the text as given.
2. `trailing_whitespace`: trailing whitespace stripped from every line of
   both the file and `old`.
3. `unicode`: the `trailing_whitespace` view plus NFKC normalisation,
   typographic quotes and dashes as their ASCII forms, and special spaces
   (no-break, narrow and other Unicode spaces) as a plain space.

The tier that matched is reported per edit. Ambiguity is counted in that
tier: more than one match without `replaceAll` is `ambiguous`, with the
match lines in `match_lines`, and is never resolved by taking the first.
An edit that matches once exactly is not refused because a fuzzier tier
would see more matches.

A fuzzy-tier match rewrites the lines it touches from that tier's
normalized text: on those lines trailing whitespace is dropped, and under
`unicode` typographic punctuation and special spaces become ASCII and
NFKC applies. Every other line keeps its bytes. The result carries a
warning whenever a fuzzy tier matched. Because such a match covers whole
lines, another edit on one of those lines is reported as `overlap`.

`replaceAll` replaces every non-overlapping occurrence in the matching
tier; `occurrences` and `line_ranges` list them all.

## Line endings and bytes

- Matching works on a view of the file with CRLF read as LF. Untouched
  bytes are written back exactly, including the endings of untouched
  lines in a file that mixes CRLF and LF. Line breaks an edit inserts use
  the file's first line ending (LF for a file without one).
- A UTF-8 byte-order mark is kept. A missing trailing newline stays
  missing unless an edit's own text changes the end of the file.
- A file containing a NUL byte is refused (`reason: "binary"`), and so is
  a file that is not valid UTF-8 (`reason: "not_utf8"`).
- The file mode is kept. A file is written to a temporary file in its own
  directory, given the original mode, and renamed over the target, so no
  backup or temporary file is left behind. A rename replaces the file's
  inode: a hard link to the old file keeps the old content.
- Right before a file is written its bytes are compared with what was
  read; a file that changed in between is not overwritten
  (`reason: "changed_since_read"`).

## Paths

- The root is the git work tree containing the `-C` directory, or the
  `-C` directory itself outside a git work tree. A path whose resolved
  target lies outside the root is refused (`reason: "outside_root"`)
  unless `--allow-outside` is passed.
- A path with a `.git` component, before or after resolving symlinks, is
  always refused (`reason: "git_dir"`), `--allow-outside` or not.
- A symlink is followed: its resolved target is checked against the root
  and edited in place, and the link stays a link. A symlink whose target
  lies outside the root is refused like any other outside path.
- A path that does not exist (`reason: "not_found"`) or is not a regular
  file (`reason: "not_a_file"`) is an error; `patch` never creates files.

## Write phase

Changed files are written one by one, in the order the plan first names
them. When a write fails, the write phase stops: the result is
`status: "error"`, `reason: "write_failed"`, its `message` names the
failing file and the files already written, and `written_files` lists
those (it is held out of the `-m` reduction, like `counts`). Edits of
written files read `written`, the failing file's edits read `error`, and
the rest read `not_written`. There is no rollback of files already
written.

## `--dry-run`

`--dry-run` resolves everything the same way and writes nothing. The
envelope has the same shape; an edit and a file that would change read
`would_write` instead of `written`, and the top-level `dry_run` is
`true`.

## Result shape

```json
{
  "command": "patch",
  "status": "written",
  "dry_run": false,
  "root": "/abs/repo",
  "counts": { "edits": 2, "files": 2, "files_written": 2, "written": 2, "would_write": 0, "unchanged": 0, "missing": 0, "ambiguous": 0, "overlap": 0, "refused": 0, "errors": 0 },
  "written_files": ["src/a.ts", "src/b.ts"],
  "edits": [
    { "index": 0, "file": "src/a.ts", "path": "src/a.ts", "status": "written", "tier": "exact", "occurrences": 1, "line_ranges": [{ "start": 12, "end": 12 }] }
  ],
  "files": [
    { "path": "src/a.ts", "status": "written", "edits": [0], "line_ending": "lf", "bom": false, "diff": "--- a/src/a.ts\n+++ b/src/a.ts\n@@ ..." }
  ]
}
```

Each edit carries `index`, `file` (as given), `path` (root-relative, or
absolute when outside the root), `status`, and, depending on the status:
`tier`, `occurrences`, `line_ranges` (1-based, one per occurrence),
`match_lines` (ambiguous), `overlaps_with` (overlap), `hint` (missing),
`reason` and `detail`. Each file carries its `status`, the indices of its
`edits`, `line_ending`, `bom` and, when it changes, a unified `diff`
preview (three lines of context, endings shown as LF).

### Statuses

| Status | Class | Exit | Meaning |
| --- | --- | --- | --- |
| `written` | ok | `0` | At least one file was written. |
| `would_write` | ok | `0` | Dry run: at least one file would change. |
| `unchanged` | ok | `0` | The plan resolved and yields byte-identical content for every file; nothing is written. |
| `missing` | finding | `1` | An edit's `old` text matches in no tier. |
| `ambiguous` | finding | `1` | An edit's `old` text matches more than once without `replaceAll`. |
| `overlap` | finding | `1` | Two edits of one file overlap. |
| `usage_error` | cannot conclude | `2` | A refused path (`outside_root`, `git_dir`) or a bad invocation or plan. |
| `error` | cannot conclude | `2` | A file could not be read, decoded or written. |

When several apply, the top-level status is the first of `usage_error`,
`error`, `missing`, `ambiguous`, `overlap` that any edit has. `unchanged`
is decided per file: a file whose new content equals its current bytes is
not written, and each of its edits reads `unchanged`; an edit whose
`new` equals its matched text, in a file another edit changes, reads
`written` with that file. An edit that resolved but was not written
because the plan was refused, or because the write phase stopped before
its file, reads `not_written`.

### Hints

A `missing` edit carries `hint`:

- `candidates`: up to three windows of the file closest to `old`, each
  with `line_start`, `line_end`, a `similarity` from 0 to 1 (whitespace
  and typographic punctuation ignored), `whitespace_only` when every
  differing line differs only in whitespace, and `differences`: the
  differing lines with whitespace made visible (a space as `·`, a tab as
  `→`, any other whitespace or invisible character as `⟨U+XXXX⟩`).
- `new_text_at_line`: set when `new` already occurs in the file, which
  usually means the edit was applied before.
- `message`: one line summing up the above.

An `ambiguous` edit lists its `match_lines` and the tier they were
counted in.
