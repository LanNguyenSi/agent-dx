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
- A writable file in a directory the process may not write is refused in
  the same path phase (`status: "not_editable"`,
  `reason: "dir_read_only"`), under `--dry-run` too and before any file of
  the plan is written: the temporary file is written next to the target,
  and a read-only directory refuses it.
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
     `GIT_OBJECT_DIRECTORY`, `GIT_CEILING_DIRECTORIES` and
     `GIT_DISCOVERY_ACROSS_FILESYSTEM` removed from its environment, so
     that git's discovery runs over the layout as it is on disk, each
     line taken as git spells it and resolved by the filesystem from the
     root), compared by device and inode, so under any name or spelling. A line
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
  directory, or the directory its `.git` file names (`gitdir: <path>`,
  read as git reads it: up to 1 MiB, ended by a NUL, and a path that is
  not UTF-8 names nothing; resolved by the filesystem from the root, so
  a symlink in it is followed before a `..` after it applies, and a
  path that does not resolve names nothing),
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
  is not valid UTF-8. A large configuration in a file git reads while it
  sets up: the repository's `config`, a file its `include.path` names, or
  `config.worktree` under `extensions.worktreeConfig`. A single value of
  gigabytes (a sparse file counts; a NUL stops git only where it expects
  a section or key, not inside a value) or many small entries grow git
  at its parser's pace, which reached about 1 GiB per second for many
  small entries on a current Mac. The bound is the 3 seconds of the
  identity lookup, so a few gigabytes of memory before git is stopped.
  And the window between the check and the write.
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
  limit and resolved by the filesystem as git resolves it, a symlink
  before a `..` followed first, never by folding the path lexically,
  then the directory itself as a bare repository) and ends it no
  earlier than git 2.39 or a newer git does: at the first directory
  that passes git's test of a git directory, or at any `.git` file; not
  at a `.git` entry that is neither a file nor a directory (git 2.39
  looks further up past one), and not at a filesystem boundary. It does
  not run git when a `commondir` met on the way is not a regular file
  of at most 64 KiB, or a `.git` file names its directory by a path
  that is not UTF-8 or that the filesystem cannot resolve (the check
  cannot follow it; git itself stops at such a file). git then runs for
  at most 3 seconds (a FIFO it opens makes it wait), with at most 64 KiB
  of output, its stdout and stderr counted together, in a process group
  of its own; when it does not end by itself (the time or output
  bound, a signal), that whole group is killed, so no process of it
  outlives the command. The lookup is bounded the way `worktree` bounds
  its git calls (`bounded-spawn.ts`): git is started through a `/bin/sh`
  wrapper whose watcher waits on a pipe the patch process holds and
  kills git's group when the kernel closes it, which happens when the
  patch process dies even if nothing reaps it, so a patch ended by
  SIGKILL or SIGHUP while git hangs leaves no git behind. A git that a
  signal ends is reported with the shell's status for it (128 plus the
  signal number), and one the wrapper cannot find or run with 127 or
  126; both are failed lookups, never an empty answer. On Windows,
  which has no process groups, git itself is killed and there is no
  wrapper.
- When the identity lookup cannot be made, the name and layout checks
  still apply and the result carries a warning that the identity check
  was skipped, with the cause: git was not run (the `commondir` or `.git`
  file above, named), `git` cannot be run (not installed or not on
  `PATH`), it did not finish in time, wrote more than its bound, or was
  ended by a signal, whatever the root; or the root is a git work tree
  but `git rev-parse` fails there (a broken `.git` file, a repository git
  refuses as unsafe, a damaged repository). Outside any work tree, git
  failing is read as "git names no directory here", with no warning,
  except for a status the wrapper reports for a signal or for a git it
  cannot run (126, 127, above 128): those warn wherever the root is. A
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

## Branch guard

A shell call of `patch` is not seen by a hook that judges only the editor
tools, so `patch` guards the branch itself: it refuses to write while any
repository that holds a target sits on a protected branch.

```bash
agent-primitives patch --plan edits.json                       # tracked target refused on main
agent-primitives patch --plan edits.json --allow-protected     # writes anyway, recorded
agent-primitives patch --plan edits.json --protected release --protected develop
agent-primitives patch --plan edits.json --protect-detached
```

**Which repositories.** Every distinct repository that holds a target is
judged once, and so is the one at `-C` when `-C` is in a work tree. A
target's repository is the work tree whose `.git` entry is the nearest one
at or above the directory of the file as it resolves (a symlink is
followed, so a link in one repository to a file in another is judged by the
other). So `patch --file proj/a.txt` from a workspace directory that is no
repository judges `proj`; a target reached with `--allow-outside` in a
second repository, a nested repository and a submodule are judged by their
own branch, besides the one at `-C`. The plan is refused when any of them
is protected or cannot be resolved; one repository on a task branch does
not outweigh another on `main`. Nothing is written in either.

**Per target.** On a protected branch (or a detached HEAD under
`--protect-detached`) the guard decides for each target, because no edit to
a file that git ignores or does not track can reach the branch through this
command: `git add` of such a file is a separate, deliberate action the guard
does not police. In the repository root, with the absolute real path of the
file (so git relates it to the work tree whatever the volume's letter case),
`git check-ignore -q` asks whether the file is ignored (a tracked file is
never reported as ignored, whatever the ignore rules say) and, if not,
`git ls-files --error-unmatch` whether it is tracked, with pathspecs taken
literally (`--literal-pathspecs`; a name with `[` or `*` is that name). A file
that does not exist yet is untracked; a file below an ignored directory is
ignored. So a run file such as `.ai/runs/<run>/notes.md` in a checkout that
stays on `master` can be edited without `--allow-protected`, and a tracked
file of the same plan cannot.

| Target | Status in `targets` |
| --- | --- |
| ignored (`check-ignore` exit 0) | `allowed_ignored` |
| untracked and not ignored | `allowed_untracked` |
| tracked | the repository's refusal: `refused`, `would_refuse` or `allowed_protected` |
| classification failed (git failed, timed out, answered unexpectedly) | counted as tracked (fail closed), `tracking: "unknown"`, and a warning `branch guard: could not tell whether "<file>" is tracked (<why>); treated as tracked` |

The plan stays atomic: one tracked target in a protected repository refuses
the whole plan, the untracked and ignored files of it included (nothing is
written, their edits are `refused` with `the plan is refused as a whole`),
and the refusal's detail names the tracked targets. `--allow-protected`
lifts the tracked targets only; the others keep `allowed_untracked` or
`allowed_ignored`, and `allowed_protected` is set only when a tracked target
needed the override. Under `--dry-run` a tracked target reads `would_refuse`.
A repository with no classifiable target (every file of it already refused
by a path check, or `-C` in a repository none of the targets lie in) is
judged as a whole, as before, and so is a branch that cannot be resolved
(`protected_branch_unresolved`): no per-target allowance there. On an
unprotected branch nothing is classified and `targets` is absent. Each
classified target costs up to two git calls, each bounded like the branch
read.

**Protected names.** The set is the union of three sources, compared
without regard to letter case (`Master` is `master`); each repository's
entry in `branch_guard.repos` lists the `sources` that contributed and the
`protected` names, each once:

| Source | Names |
| --- | --- |
| `flag` | every `--protected <name>` (repeatable; empty, padded or control-character names are a usage error, `reason: "protected_invalid"`) |
| `origin-head` | the branch `refs/remotes/origin/HEAD` points to, when that is a plain `refs/remotes/origin/<name>`; any other target, or an unset one, adds nothing |
| `builtin` | `main` and `master`, always |

No configuration file is read. A harness that protects a longer list
passes it as `--protected` flags; nothing else tells `patch` about it.

**What is judged.** In each repository, `HEAD` is read with `git
symbolic-ref --quiet HEAD` (it works on an unborn branch, and an exit
status of 1 with no output means a detached HEAD) and origin's default with
`git symbolic-ref --quiet refs/remotes/origin/HEAD`, two calls per
repository, each bounded like the identity lookup (3 s, 64 KiB, a process
group of its own, stdin closed, in the repository root). The full ref is
read and `refs/heads/` is cut off here: `--short` answers `heads/main` when
a tag `main` exists too, and that spelling would match nothing. git's
repository-selecting variables (`GIT_DIR`, `GIT_WORK_TREE`,
`GIT_COMMON_DIR`, `GIT_NAMESPACE`, the ref storage format variables,
`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` and its key and value pairs, and
the ones the identity lookup drops) are removed from git's environment
first, so the answer is the one for the repository.

**Outcomes.** `branch_guard.status` is the overall outcome, the first of
this table's order that any repository has, and `branch_guard.repos` has one
entry per repository (`root`, `status`, `branch`, `protected`, `sources`,
`reason` for a `refused`, `would_refuse` or `allowed_protected` entry, not
for the others, and `targets` where the per-target rule applied) with its
own status from the same list; a repository's status is the first of that
order that any of its targets has. Each `targets` entry is `path` (as the
edits name it), `status`, `tracking` (`tracked`, `untracked`, `ignored` or
`unknown`) and, for a refused, would-refuse or overridden one, the `reason`.
The
guard carries no free text: the wording is in `message` and in the edits'
`detail`, which name the repository's root.

| Status | When | Effect |
| --- | --- | --- |
| `refused` | a repository is on a protected branch, or under `--protect-detached` on a detached HEAD (`branch: "HEAD"`), and holds a tracked target (or, with no classified target, any) | `status: "usage_error"`, `reason: "protected_branch"`, exit `2`; every edit and file `refused`, nothing written |
| `would_refuse` | the same, under `--dry-run` | the dry run as without the guard (edits `would_write`, the diff), plus a warning; exit `0` |
| `allowed_protected` | `--allow-protected` overrode a refusal of a tracked (or unclassifiable) target, or of the whole repository | writes; `allowed_protected: true` at the top level of the envelope too |
| `detached` | HEAD is detached, without `--protect-detached` | writes |
| `allowed_untracked` | a protected branch (or a detached HEAD under `--protect-detached`), and every target of the repository is untracked or ignored, at least one untracked | writes; each target in `targets` |
| `allowed_ignored` | the same, and every target is ignored | writes; each target in `targets` |
| `allowed` | HEAD is on an unprotected branch | writes |
| `not_a_repo` | a target lies in no work tree: no `.git` entry at or above its directory (this includes a bare repository, or a git directory outside any work tree). `-C` inside a work tree's own `.git` is judged as that work tree | writes, as before the guard existed; one entry without a `root` stands for all such targets |

`--allow-protected` lifts every refusing repository at once: each lifted
one reads `allowed_protected` in `repos`, which is the list of the roots it
lifted. `allowed_protected` is set only when an override was needed:
`--allow-protected` on unprotected branches leaves `allowed` and no
`allowed_protected`. A refusal by the guard outranks the other findings of
a plan (a `missing` edit, a read-only file), which are reported again once
the guard is passed; a path refusal found first (`git_dir`,
`outside_root`) keeps its own reason, and the rest of the plan is still
refused. `--allow-protected` does not lift a `git_dir` refusal. A target in
no repository does not lift the refusal of one beside it.

**Fail closed.** Inside a repository, anything but a clear answer is a
refusal with `reason: "protected_branch_unresolved"` (exit `2`, hint
`--allow-protected`): git not on `PATH`, a layout the identity lookup must
not run git on (a `commondir` that is no small regular file), a timeout, a
signal, an unexpected exit status, an exit status of 1 that prints
something, HEAD naming something outside `refs/heads/` or more than one
line, or an `origin/HEAD` call that fails. A hand-written `.git` directory
that git does not accept is refused, unless an enclosing repository answers
in its place, which is then the one judged; one laid out like a repository
is judged as that repository. This is separate from the identity lookup,
which still only warns when it cannot run. Under `--dry-run` the same cases
are `would_refuse`.

**Limits.** A linked worktree is judged by its own branch, not by the main
checkout's. A target is judged by the repository that holds the directory
it resolves to; a repository git would discover differently from the
nearest `.git` entry (a stub, see above) is judged as git answers. The
override flag is available to whoever runs the command, so the guard stops
a slip, not a caller that passes `--allow-protected`; `allowed_protected`
in the envelope is the record that it did. Under a tight `-m` budget
`branch_guard` is reduced like any other payload object, and `counts`,
`written_files`, `allowed_protected`, `status` and `reason` are kept only
while the fixed fields leave room for them; below that only the fixed
fields remain. The warnings are fixed fields: one line each names a refusal
(`branch guard: refused in N repositories ...`), a dry run that would be
refused and an override, whatever the budget.

## Result shape

```json
{
  "command": "patch",
  "status": "written",
  "dry_run": false,
  "root": "/abs/repo",
  "branch_guard": { "status": "allowed", "repos": [ { "root": "/abs/repo", "status": "allowed", "branch": "task/x", "protected": ["main", "master"], "sources": ["builtin"] } ] },
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
| `not_editable` | finding | `1` | A target has more than one hard link (`hard_link`), is not writable (`read_only`), or sits in a directory that is not writable (`dir_read_only`). |
| `usage_error` | cannot conclude | `2` | A refused path (`outside_root`, `git_dir`), a refusal of the branch guard (`protected_branch`, `protected_branch_unresolved`) or a bad invocation or plan. |
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
  usually means the edit was applied before. Only a distinctive `new`
  counts: it must not occur in `old` (an exact comparison) and must have at least 8
  non-whitespace characters, since a short text such as `x` occurs
  almost anywhere.
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
