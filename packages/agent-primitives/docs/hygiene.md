# `hygiene`

Mechanical commit-hygiene check for a git range or the index. Part of the [agent-primitives](../README.md) CLI.

An agent that edits files with `sed -i` can leave backup files behind
(on BSD/macOS, `sed -i -E ...` or `sed -i -e ...` takes the flag as the
backup suffix and writes a `<file>-E` or `<file>-e` copy), and an agent asked to extend a file can rewrite it
instead. Both are easy to miss in a long diff. This command checks for
them from git alone, so it works in any repository without installing a hook.

```bash
agent-primitives hygiene --base <rev>
agent-primitives hygiene --base <rev> --staged
agent-primitives hygiene --base <rev> --worktree
agent-primitives hygiene --base <rev> --extend-only docs/log.md --extend-only-file extend-only.txt
agent-primitives hygiene --base <rev> --intended-deletion test/dropped.test.ts --intended-deletion-file intended.txt
```

`--base` is the revision the task started from. Both `--base` and `--head`
(default `HEAD`) are resolved to commits once, and the comparison starts at
their merge-base, so a base that moved after the branch point (an
`origin/master` that gained commits since) gives the same result as the SHA
the branch started from, and the base side's later changes (test cases it
added, say) are not counted against the head. When the two have no merge-base
(unrelated histories, or a shallow clone missing the history), the two trees
are compared directly and a warning names the cause. With `--staged` the
comparison is from the merge-base of `--base` and `HEAD` against the git
index, so it covers every commit since the branch point plus what is about to
be committed; run it before `git commit` to refuse a bad commit, and again
without `--staged` before handing back. The envelope names the resolved
commits as `base_sha`, `head_sha` (`null` with `--staged` or `--worktree`)
and `merge_base`. Renames are followed, so a moved test file is compared
with its old content, not reported as a deletion plus an addition.

## Modes

| Mode | What is compared | What the uncommitted-changes warning covers |
| --- | --- | --- |
| default (`--head <rev>`, default `HEAD`) | the merge-base of `--base` and the head commit against the head commit | every tracked file with staged or unstaged changes: the comparison never looked at it |
| `--staged` | the merge-base of `--base` and `HEAD` against the git index | tracked files with unstaged changes (the staged part is the comparison); `--head` is ignored |
| `--worktree` | the merge-base of `--base` and `HEAD` against the working tree: tracked files, staged and unstaged changes alike | tracked files whose staged version differs from both `HEAD` and the working tree (the working-tree comparison never looks at the index); untracked files that match a test or backup pattern are named in a separate warning |

`--worktree` is for a handback with uncommitted changes: it checks the work
as it stands on disk. It cannot be combined with `--staged` or `--head`
(a usage error naming both flags, exit `2`); `head` is `(worktree)` and
`head_sha` is `null`. Between the other two, `--staged` wins over `--head`:
the head revision is not read at all, even an unresolvable one.

### Uncommitted changes the comparison did not look at

`hygiene` never reports a silent ok while tracked files have changes it did
not compare. In the default and `--staged` modes it runs `git status
--porcelain -z --untracked-files=no` (renames count once; paths with spaces
stay whole) and, when there are such files, adds a warning of the form
`N tracked files have uncommitted changes not covered by this comparison;
commit them, or use --staged / --worktree (<up to five paths>)`. With
`--staged` the remedy reads `stage and commit them, or use --worktree` and
only unstaged changes count. The result stays what the comparison found:
the warning changes neither `status` nor the exit code. It also feeds:

- `counts.uncommitted`, the exact number of such files, and `uncommitted=N`
  on the `--summary` totals line (`0` on a clean tree);
- `uncommitted_files` (also accepted by `--print`), the paths, capped at 50
  entries; `counts.uncommitted` still holds the full number.

With `--worktree` the warning covers the one case the working-tree
comparison cannot see: a tracked file whose index version differs from both
`HEAD` and the working tree (status `MM`, `AM` and the like). It reads `N
tracked files have a staged version that differs from both HEAD and the
working tree; stage the working tree (git add) or check with --staged
(<paths>)`, and the file counts in `counts.uncommitted` and
`uncommitted_files` like in the other modes.

Untracked files never count as uncommitted. In `--worktree` mode, untracked
files whose path matches a test pattern (as for `test_cases_dropped`) or a
backup pattern (as for `backup_file`) are named in a separate warning (`N
untracked files match a test or backup pattern and are not compared; git
add them to include them`) because adding them would put them in range;
other untracked files are ignored. If `git status` (or, with `--worktree`,
`git ls-files`) fails, a warning says so and the result, status and exit
code stay as the comparison found them.

`hygiene` never writes the index in any mode: the status query runs as
`git --no-optional-locks status`, and `--worktree` compares with `git
diff-index` instead of `git diff`, which would refresh the index and write
`.git/index` back (a concurrent `git add` or `git commit` could then find
`index.lock` held). The consequence: `--worktree` never refreshes the
index, so a file whose stat data is merely stale can be listed as modified;
its content equals the base, so it yields no finding.

`--worktree` reads each changed file from the working tree under the same
rules the index path follows: a path must stay inside the repository root
and its directory must not resolve outside it through a symlink; a symlink
is read as its target text (what the index stores for it), never followed;
a directory or submodule is unreadable and skipped like an unreadable index
entry; a file deleted in the working tree counts as deleted.

## Findings

Each finding is `{ kind, path, detail, ... }`. Any finding makes the result
`status: "fail"` (exit `1`); no finding is `ok` (exit `0`); an unusable
argument or revision is a usage error (exit `2`).

- `backup_file`: a file that newly acquires a backup-style basename in the
  range: one the range adds, or renames or copies from a name that did not
  match. The basename endings are `.bak`, `.orig`, `~`, and the BSD
  flag-as-suffix family `-e`, `-E`, `-n`, `-r`, `-s` (BSD `sed -i` uses the
  argument after `-i` as the backup suffix, so any bare `sed -i -<flag>`
  leaves `<file>-<flag>`). A legitimately named file that ends this way
  (for example a `notes-e` document) is reported when the range adds it;
  there is no allow list, so rename it or explain it in the report. A
  tracked file that already had such a name at `--base` and is only
  modified, or renamed to another such name, is not reported, and neither
  is a deleted file.
- `extend_only_rewrite`: a path listed with `--extend-only` (repeatable) or
  `--extend-only-file` (one path per line, blank lines and `#` comments
  ignored; the file itself is resolved against the `-C` directory like
  `--plan`, the paths inside it are relative to the repository root) that
  loses more than
  `--max-delete-percent` (default `20`) of its base line count. A deleted
  file counts as 100%. A path that does not exist at the comparison start (the merge-base, which is
  `--base` itself when the base has not moved) is skipped with a
  warning that names the merge-base. When the removed-line count cannot be measured (for example a
  binary file, which numstat reports as `-` instead of a count, or no
  numstat row at all), the path is not
  checked and a warning says so. Carries `baseLines`, `removedLines` and `removedPercent`.
- `test_cases_dropped`: a changed test file (a path under `test/`,
  `tests/` or `__tests__/`, or named `*.test.<ext>` or `*.spec.<ext>` with
  a JavaScript or TypeScript extension (`js`, `jsx`, `ts`, `tsx`, and the
  `m`/`c` variants), `test_*.py`, `*_test.py`, `*_test.go`, or an
  alphanumeric `*Test.java`, or `*Test.php`) whose count of test-case
  markers is lower at the head than at the base. A marker is a line
  starting with `it(` or `test(` (including `.skip`, `.only`,
  `.each(...)` forms), `def test_`, `func Test`, or `@test`/`@Test`. In a
  `.php` file only PHPUnit methods count: a method named `test*`, or one
  carrying an `@test` docblock tag or a `#[Test]` attribute (short or fully
  qualified), each method once; the attribute or a single-line
  `/** @test */` docblock may also sit on the method's own line. The
  invariant: a line matching the method pattern is always counted when its
  name starts with `test` or a marker is pending; no comment, string or
  attribute state can hide a method line. `@test` marks only on docblock
  lines (`/**`, ` *` or `*/`) and on the method's own line, never in a
  `//` or `#` comment or in code. A marker still waiting for its method is
  dropped at the first later line that is neither blank nor a docblock,
  comment or attribute line, and by every counted method. An attribute
  group that closes on a later line is followed until its brackets balance
  (counting `[` and `]` plainly): it only keeps a pending marker alive and
  sets it when the group names `Test`, it never hides a method line, and
  it ends at the first method line or the first line that closes it.
  Documented limits: a method-like line inside a `/* */` block comment or
  a heredoc/nowdoc body is counted (an over-count, never a hidden method),
  a bracket misread inside an attribute can keep or drop one marker, a
  docblock or attribute that follows the modifiers on the method line is
  not read, a docblock line without a leading `*` (for example `  @test`)
  neither sets nor keeps a marker, and a same-line attribute whose
  arguments contain `]` is not seen through, so the method on that line
  counts only by its `test` name. Inside an open attribute group a `Test`
  name is read from two consecutive lines at a time, so one split over more
  lines is missed, and a bare `Test` argument elsewhere in the group (for
  example `DataProvider(Test)`) can mark the next method. An over-count (method-like lines in
  block comments or heredocs) can offset a real deletion in the same file.
  The count is a text heuristic, not a
  parser: it can miss a case written in an unusual shape, and it cannot
  tell a deliberately removed case from an accidental one, so a flagged
  drop is a prompt to explain it, not proof of a mistake. Carries
  `baseCases` and `headCases`. A drop the caller declares with
  `--intended-deletion` is allowed instead of reported; see "Intended
  deletions".

## Options

| Option | Meaning |
| --- | --- |
| `--base <rev>` | Required. The revision the task started from. |
| `--head <rev>` | Head revision, default `HEAD`. Ignored with `--staged`; a usage error with `--worktree`. |
| `--staged` | Compare the merge-base of `--base` and `HEAD` with the index. A usage error with `--worktree`. |
| `--worktree` | Compare the merge-base of `--base` and `HEAD` with the working tree (tracked files). A usage error with `--staged` or `--head`. |
| `--extend-only <path>` | A path the task may only extend; repeatable. |
| `--extend-only-file <file>` | A file listing extend-only paths. |
| `--intended-deletion <spec>` | Declare a test file's case drop intended; repeatable. |
| `--intended-deletion-file <file>` | A file listing intended deletions, one per line. |
| `--max-delete-percent <n>` | Threshold from `0` to `100`, default `20`. |

The result also carries `counts` (`files`, `backupFiles`,
`extendOnlyRewrites`, `testCaseDrops`, `intendedDeletions`, `uncommitted`), which is kept
whole when the envelope is reduced to fit `--max-chars`.

## Intended deletions

A task that really does mean to delete test cases declares them, and the
declared drops are allowed instead of reported:

```bash
agent-primitives hygiene --base <rev> \
  --intended-deletion test/deleted.test.ts \
  --intended-deletion 'src/trim.test.ts=2' \
  --intended-deletion-file intended.txt
```

A declaration is `<path>`, `<path>=<n>` or `<path>=all`. `--intended-deletion`
is repeatable; `--intended-deletion-file` takes one declaration per line,
ignoring blank lines and `#` comments, resolves the file itself against the
`-C` directory like `--extend-only-file`, and keeps the paths inside it
relative to the repository root. A bare path means `all`. The count is read
after the LAST `=`, so a path whose own name contains `=` must always
carry an explicit `=<n>` or `=all`; the bare form is read as a count and
rejected. `=0`, a negative, a non-integer and an empty path are usage
errors (exit `2`), like an out-of-range `--max-delete-percent`.

The count is an at-most bound in the same units the counter uses: JS/TS
test-case markers in a JavaScript or TypeScript file, PHPUnit methods in a
`.php` file. A drop of at most `n` (any drop, with `all`) is allowed: no
finding, and one entry in `intended_deletions` with `path`, `baseCases`,
`headCases`, `dropped` and the `declared` bound that covered it. A drop
above `n` is reported as before, with the declared bound named in `detail`
(`... (declared 2)`). A renamed test file is matched on the path it has at
head, the path the finding would name.

Only `test_cases_dropped` can be declared away. `backup_file` and
`extend_only_rewrite` never consult the declarations, so an extend-only
file that loses cases is still flagged.

Two declarations of the same path collapse to the one that allows more (the
larger count, `all` above every number), so the flag and the file can be
combined in any order and the larger count is what applies.

A declaration that allowed nothing - its path is not in the range, is not a
test path, or dropped no cases - draws the warning
`intended deletion not used: <path>` and leaves the status alone; a later
version may make an unused declaration a finding, so treat the warning as
a typo to fix. A declaration whose path did drop, but by more than it
allowed, was consulted and is not reported stale.

The declarations are agent input, so they are always visible: the envelope
echoes `intended_declarations` (the normalized, deduplicated set the run
used) and `intended_deletions` (the ones it applied), and
`intended_deletions` is kept whole when `--max-chars` reduction cuts
`findings`.

## Compact views: --summary and --print

`--summary` and `--print <field,...>` print a second rendering of the same
result; they work like the views of [probe](probe.md#compact-views---summary---print-and---report).

`--summary` prints one line per finding, one `warning:` line per warning,
and a final totals line:

```text
<kind> | <path> | <detail>
totals: status=<ok|fail> files=N findings=N backup_files=N extend_only_rewrites=N test_case_drops=N warnings=N intended_deletions=N [fullResult=<path>]
```

`fullResult=` appears when the envelope was reduced to fit `-m` and the
complete result was saved. `-m` is a character budget: rows that do not
fit are replaced by one marker line naming how many were omitted, and the
totals line is always printed.

`--print` prints one JSON object on one line, one key per requested field
in the order given. A name is a top-level envelope field (`status`,
`findings`, `counts`, `base_sha`, `head_sha`, `merge_base`,
`max_delete_percent`, `extend_only`, `base`, `head`, `warnings`, `logs`,
`fullResult` and the other fixed fields); a dotted path descends into
objects (`counts.files`) but not into arrays, so a single finding is not
addressable (`findings.0` prints `null`). Fields are read from the
unreduced result, so `-m` does not shorten a printed field; only the
printed line is bounded by it. A field this run did not produce prints
`null`.

`warnings`, `logs`, `fullResult` and `truncated` are taken from the emitted
envelope (so a "full result not written" warning and the reduction marker
show, and `truncated` agrees with `warnings`), while every other field comes
from the unreduced result. `--summary` builds its `warning:` rows and
`warnings=N` from the same emitted warnings but leaves out the two notices
`-m` adds to the JSON view (`envelope is N characters; requested max-chars
M could not be met` and `result reduced to the fixed fields only: ...`), so
only the command's own warnings are listed and counted.

Both views take precedence over `-f`, are bounded by `-m`, are mutually
exclusive (naming both is a `usage_error` with exit `2` before anything
runs, as is an unknown `--print` field, which lists this command's own
fields), and leave the envelope schema, the exit code and the saved full
result untouched. A usage error prints the JSON `usage_error` envelope as
for every other command.
