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
agent-primitives hygiene --base <rev> --extend-only docs/log.md --extend-only-file extend-only.txt
```

`--base` is the revision the task started from. Without `--staged` the range
is `--base`..`--head` (`--head` defaults to `HEAD`). With `--staged` the
comparison is `--base` against the git index, so it covers every commit since
the base plus what is about to be committed; run it before `git commit` to
refuse a bad commit, and again without `--staged` before handing back.
Renames are followed, so a moved test file is compared with its old
content, not reported as a deletion plus an addition.

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
  file counts as 100%. A path that does not exist at `--base` is skipped with a
  warning. When the removed-line count cannot be measured (for example a
  binary file, which numstat reports as `-` instead of a count, or no
  numstat row at all), the path is not
  checked and a warning says so. Carries `baseLines`, `removedLines` and `removedPercent`.
- `test_cases_dropped`: a changed test file (a path under `test/`,
  `tests/` or `__tests__/`, or named `*.test.<ext>` or `*.spec.<ext>` with
  a JavaScript or TypeScript extension (`js`, `jsx`, `ts`, `tsx`, and the
  `m`/`c` variants), `test_*.py`, `*_test.py`, `*_test.go`, or an
  alphanumeric `*Test.java`) whose count of test-case markers
  is lower at the head than at the base. A marker is a line starting with
  `it(` or `test(` (including `.skip`, `.only`, `.each(...)` forms),
  `def test_`, `func Test`, or `@test`/`@Test`. The count is a text
  heuristic, not a parser: it can miss a case written in an unusual shape,
  and it cannot tell a deliberately removed case from an accidental one,
  so a flagged drop is a prompt to explain it, not proof of a mistake.
  Carries `baseCases` and `headCases`.

## Options

| Option | Meaning |
| --- | --- |
| `--base <rev>` | Required. The revision the task started from. |
| `--head <rev>` | Head revision, default `HEAD`. Ignored with `--staged`. |
| `--staged` | Compare `--base` with the index. |
| `--extend-only <path>` | A path the task may only extend; repeatable. |
| `--extend-only-file <file>` | A file listing extend-only paths. |
| `--max-delete-percent <n>` | Threshold from `0` to `100`, default `20`. |

The result also carries `counts` (`files`, `backupFiles`,
`extendOnlyRewrites`, `testCaseDrops`), which is kept whole when the
envelope is reduced to fit `--max-chars`.
