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
missing, ambiguous, overlapping or would change text outside its match
(`fuzzy_side_effect`), any refused path, any file that is not editable
as is (`not_editable`) and any file that cannot be read or decoded
refuses the whole plan: nothing is written, and the result reports every
edit's own status.

Several edits of one file are all matched against that file's original
content, never against the output of an earlier edit. Their matched
ranges must not overlap; when they do, every edit involved is reported as
`overlap` with `overlaps_with` naming the others. Files are told apart
by device and inode, not by spelling: edits naming one file as `a.txt`,
`./a.txt`, `A.txt` on a case-insensitive filesystem, another Unicode
normalisation of the name, a symlink to it or another hard link of it
are grouped as one file, checked for overlap together and written once.

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
would see more matches. When the last line of `old` ends in whitespace,
a fuzzy tier matches only where the match ends at a line end, so
`"computeTotal "` does not match the middle of `computeTotal(x)`.

A fuzzy-tier match replaces the text of the file it matched and keeps
every other character, including the trailing whitespace after the match
on its last line (unless `old` itself ended that line in whitespace,
which then counts as part of the match). This works only when the rest
of the touched lines reads the same before and after the tier's
normalisation. When it does not, for example a typographic quote, a
superscript or a fullwidth letter elsewhere on a line the match touches,
the edit is refused as `fuzzy_side_effect` instead of rewriting those
characters, and nothing is written; the edit's `side_effect` names the
lines and characters and, when it can find it, the `exact_text` of the
file to use as `old` for an exact match. Rarely, an edit is refused this
way although its match could be placed: when two fuzzy matches on one
line have no literal text between them and the first ends in combining
marks that are not in canonical order. The result carries a warning
whenever a fuzzy tier matched. A fuzzy match covers whole lines, so
another edit on one of those lines is reported as `overlap`.

`replaceAll` replaces every non-overlapping occurrence in the matching
tier, taken from left to right among the matches the tier counts (after
the line-end rule above, so a dropped match never hides an overlapping
one that counts); `occurrences` and `line_ranges` list them all. An edit
that would replace nothing is `missing`.

## Line endings and bytes

- Matching works on a view of the file with CRLF read as LF. Untouched
  bytes are written back exactly, including the endings of untouched
  lines in a file that mixes CRLF and LF. Line breaks an edit inserts use
  the file's first line ending (LF for a file without one).
- A UTF-8 byte-order mark is kept. A missing trailing newline stays
  missing unless an edit's own text changes the end of the file.
- A file containing a NUL byte is refused (`reason: "binary"`), and so is
  a file that is not valid UTF-8 (`reason: "not_utf8"`).
- The file mode is kept, including setuid, setgid and sticky bits. A
  file is written to a temporary file in its own directory, given the
  original mode exactly (not filtered by the umask), and renamed over the
  target, so no backup or temporary file is left behind.
- The rename gives the file a new inode. A file with more than one hard
  link is therefore refused (`status: "not_editable"`,
  `reason: "hard_link"`), since its other names would keep the old
  content; `--break-hard-links` edits it anyway, and then only the named
  path gets the new content.
- A file the process may not write is refused (`status: "not_editable"`,
  `reason: "read_only"`) rather than replaced through its directory.
- Right before a file is written, its resolved path must still resolve to
  itself and every spelling the plan used must still name the same file
  (a directory on the path swapped for a symlink, for example), or it is
  not written (`reason: "path_changed"`); then its bytes are compared with
  what was read, and a file that changed in between is not overwritten
  (`reason: "changed_since_read"`).
- Not covered: the rename does not carry extended attributes, ACLs or a
  different owner over to the new inode; and a change to the file or its
  directory between that last check and the rename is not detected (a
  lost update in that window is possible).

## Paths

- The root is the git work tree containing the `-C` directory, or the
  `-C` directory itself outside a git work tree. A path whose resolved
  target lies outside the root is refused (`reason: "outside_root"`)
  unless `--allow-outside` is passed.
- A path inside a git directory is refused (`reason: "git_dir"`),
  `--allow-outside` or not, by three checks; the edit's `detail` names the
  one that applied.
  1. Its name: a `.git` component in the part of the path below the root,
     or anywhere in the path of a target outside the root. A component
     counts when its name, lower-cased, is `.git` (`.GIT`, `.Git`), or
     when it is the same directory entry (device and inode, a symlink
     not followed) as the one the filesystem finds as `.git` in its
     parent directory: whatever spelling the filesystem folds or
     normalises to `.git` counts, and so does a hard link of a `.git`
     file in the same directory. It is checked both in the path as given
     (resolved against the `-C` directory, before following symlinks, and
     taken below the root as found from `-C`) and after resolving
     symlinks, where each component is read as it is stored on disk. A
     `.git` component in the root's own path is not part of this check;
     the directories above the root are covered by the next two.
  2. Its layout: a directory above the resolved target that is laid out
     like a git directory. That is git's own test of one
     (`is_git_directory` in git's `setup.c`): a `HEAD` that is a symlink
     into `refs/`, or a file holding `ref:` and a name under `refs/`, or
     starting with a hexadecimal object id; plus `objects` and `refs`, in
     that directory or in the one its `commondir` file names (a linked
     worktree's administrative directory, `<git dir>/worktrees/<name>`,
     names the repository that way). The `commondir` path is resolved as
     git resolves it, by its real path, so a symlink on it is followed
     before a `..` after it applies; it is taken as written only when it
     does not resolve, and a `commondir` file that is empty or cannot be
     read counts as none. `GIT_OBJECT_DIRECTORY` set in the environment makes
     `objects` optional and `GIT_COMMON_DIR` adds the directory it names
     as a second place for `objects` and `refs`, as git looks there;
     neither variable narrows the test. A directory holding both a
     `gitdir` and a `commondir` file (a linked worktree's administrative
     directory) counts as well. This check runs no git, so it holds
     whatever git's configuration or environment says: a bare repository
     git declines to open (`safe.bareRepository`, `safe.directory`), a
     `GIT_CEILING_DIRECTORIES` setting, a repository git cannot read. A
     `HEAD` or `commondir` that is a FIFO is read without waiting for a
     writer, as an empty file.
  3. Its identity: a directory above the resolved target that is the git
     directory or common directory git names from the root
     (`git rev-parse --absolute-git-dir --git-common-dir`, run in the root
     with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
     `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM`
     removed from its environment, each line taken as git spells it),
     compared by device and inode, so under any name or spelling. A line
     of git's answer counts only when the directory it names is laid out
     like a git directory, like a linked worktree's administrative
     directory, or like a common directory (`objects` and `refs`).
- Which directories are checked: every directory from the target's own
  up to the filesystem root, for every target. There is one exception,
  for a target inside the root: a directory above the root is passed over
  when it is the root's own git directory or that directory's common
  directory, unless the root lies in one of git's own directories there:
  `objects`, `refs`, `hooks`, `info`, `logs`, `worktrees`, `modules`,
  `branches`, `remotes`, `rr-cache`, `reftable`, `rebase-merge`,
  `rebase-apply` or `sequencer`. That is decided by the filesystem: each
  of these names is looked up in that directory (a symlink there
  followed), and the root lies in one when the root or a directory above
  it is that entry (same device and inode). So a spelling the filesystem
  folds to one of these names counts (on a case-insensitive APFS volume
  `Hooks`, and `hook` followed by U+017F, are `hooks`), and so does an
  entry that is a symlink to the root or to a directory above it. The
  root's first path component below that directory is also compared by
  name, lower-cased; on a case-sensitive filesystem that only adds
  refusals (`Hooks` there is another directory than git's `hooks`). The
  root's own git directory is its `.git`
  directory, or the directory its `.git` file names (`gitdir: <path>`),
  and only when git would open it: it passes git's own test as git
  applies it, without the `GIT_*` variables above, with `objects` and
  `refs` that can be searched, `HEAD` whitespace as git reads it (space,
  tab, line feed, carriage return) and a `commondir` git can read and
  resolve. Git's own answer is not used for the exception: from a `.git`
  directory that fails git's test, git looks further up and names the
  repository around it. So:
  - a work tree checked out inside its own bare repository (`git -C
    repo.git worktree add main`) is editable from a `-C` anywhere inside
    it, and so is a linked worktree placed inside a `.git` directory;
  - a work tree inside another repository's git directory is refused,
    from a `-C` inside it too: a bare repository nested in a work tree,
    a `-C` inside one, and a `<repo>/.git/hooks` or `<bare>/hooks` that
    `git init` made a repository of its own;
  - a work tree in one of git's own directories of its own repository (a
    `.git` file in `<repo>/.git/hooks` naming `..`, or `git worktree add
    hooks` in a bare repository whose `hooks` was removed) is refused;
  - a `.git` git would not open (an empty `.git` directory, one without a
    valid `HEAD`, a `.git` file with no path or one naming no git
    directory) gives the root no git directory of its own, so the
    repository around it is refused;
  - for a target outside the root, and for any target when the root has
    no git directory of its own (a `-C` inside a bare repository, such as
    `repo.git/hooks`), nothing is passed over: the repository around a
    work tree is refused as an outside target.
- Not covered: a directory git reads only because configuration or a
  tool names it (`core.hooksPath` pointing into a git directory, a tool's
  directory such as `lfs`), when a work tree of the same repository is
  checked out there, and one of git's own directories that is a symlink
  to a directory inside the work tree (a `hooks` linked to
  `main/githooks` leaves the work tree `main` editable, as in any
  repository whose `hooks` links into its work tree); setting either up
  takes a write into the git directory first. A directory
  that git opens as a git directory although it passes neither the layout
  test nor the identity lookup: the layout test is git's own, wider where
  it differs, and the one known case is a `commondir` file whose content
  is not valid UTF-8. A configuration file git reads while it sets up
  (or one it includes) holding a value of many gigabytes: the bound on
  git is then only its 10 seconds. And the window between the check and
  the write.
- Refused although git would not object: a `-C` inside a submodule (or
  another repository) nested in a work tree that is checked out inside
  its bare repository, since the submodule's own git directory is not
  that bare repository (a `-C` at the work tree root edits the same
  file); a directory above the target that holds files named `gitdir`
  and `commondir`.
- The identity lookup is bounded. git reads a `commondir` file whole
  while it looks for the repository, so one that is a device, a FIFO or
  a large (also sparse) file makes it wait or grow without bound, faster
  than a timeout can stop it. Before git runs, patch follows git's own
  discovery from the root (in each directory from the root up: a `.git`
  directory, the directory a `.git` file names, read up to git's 1 MiB
  limit, then the directory itself as a bare repository, ending where
  git ends: at the first git directory, at any `.git` file, at a `.git`
  entry that is neither a file nor a directory) and does not run git
  when a `commondir` met on the way is not a regular file of at most 64
  KiB, or a `.git` file names its directory by a path that is not UTF-8.
  git then runs for at most 10 seconds, with at most 64 KiB of output,
  in a process group of its own; when it does not end by itself (the
  time or output bound, a signal), that whole group is killed, so no
  process of it outlives the command.
- When the identity lookup cannot be made, the name and layout checks
  still apply and the result carries a warning that the identity check
  was skipped, with the cause: git was not run (the `commondir` or `.git`
  file above, named), `git` cannot be run (not installed or not on
  `PATH`), it did not finish in time, wrote more than its bound, or was
  ended by a signal, whatever the root; or the root is a git work tree
  but `git rev-parse` fails there (a broken `.git` file, a repository git
  refuses as unsafe, a damaged repository). Outside any work tree, git
  failing is read as "git names no directory here", with no warning; a
  bare repository git declines to open is then refused by its layout.
  A line of git's answer naming a directory that cannot be stated, or
  one laid out like none of the three above, is left out with a warning
  that names it; and an answer with more lines than the two asked for
  (a line break inside a name, which splits it into pieces that may name
  unrelated directories) always carries a warning.
- A symlink is followed: its resolved target is checked against the root
  and edited in place, and the link stays a link. A symlink whose target
  lies outside the root is refused like any other outside path.
- A path that does not exist (`reason: "not_found"`, with the message
  "file does not exist; patch only edits existing files (it never creates
  one)") or is not a regular file (`reason: "not_a_file"`) is an error.

## Write phase

Changed files are written one by one, in the order the plan first names
them. When a write fails, the write phase stops: the result is
`status: "error"`, `reason: "write_failed"` (the file itself carries
`write_failed`, `path_changed` or `changed_since_read`), its `message`
names the failing file and the files already written, and `written_files` lists
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
  "counts": { "edits": 2, "files": 2, "files_written": 2, "written": 2, "would_write": 0, "unchanged": 0, "missing": 0, "ambiguous": 0, "overlap": 0, "fuzzy_side_effect": 0, "not_editable": 0, "refused": 0, "errors": 0 },
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
`side_effect` (fuzzy_side_effect), `reason` and `detail`. Each file carries its `status`, the indices of its
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
| `fuzzy_side_effect` | finding | `1` | A fuzzy-tier match would change text outside the matched text. |
| `not_editable` | finding | `1` | A target has more than one hard link (`hard_link`) or is not writable (`read_only`). |
| `usage_error` | cannot conclude | `2` | A refused path (`outside_root`, `git_dir`) or a bad invocation or plan. |
| `error` | cannot conclude | `2` | A file could not be read, decoded or written. |

When several apply, the top-level status is the first of `usage_error`,
`error`, `missing`, `ambiguous`, `overlap`, `fuzzy_side_effect`,
`not_editable` that any edit has; for `not_editable` the top-level
`reason` names why. `unchanged`
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

A `fuzzy_side_effect` edit carries `side_effect`:

- `lines`: each touched line the normalisation changes, as `original` and
  `normalized`, with whitespace made visible.
- `changed_characters`: each character the normalisation changes there,
  as `<char> (U+XXXX) -> <replacement>`, and `trailing whitespace`.
- `exact_text`: for a one-line `old`, the text of the file it matched,
  when exactly one such text is on the touched lines; use it as `old`.
- `message`: one line summing up the above (also the edit's `detail`).
