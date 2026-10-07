# `hygiene`

Mechanical commit-hygiene check for a git range or the index. Part of the [agent-primitives](../README.md) CLI.

An agent that edits files with `sed -i` can leave backup files behind
(on BSD/macOS, `sed -i -E ...` takes `-E` as the backup suffix and writes a
`<file>-E` copy), and an agent asked to extend a file can rewrite it
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

- `backup_file`: a file the range adds or changes whose basename ends in
  `-E`, `.bak`, `.orig` or `~`. Deleted files are never reported.
- `extend_only_rewrite`: a path listed with `--extend-only` (repeatable) or
  `--extend-only-file` (one path per line, blank lines and `#` comments
  ignored; paths are relative to the repository root) that loses more than
  `--max-delete-percent` (default `20`) of its base line count. A deleted
  file counts as 100%. A file that does not exist at `--base` is skipped.
  Carries `baseLines`, `removedLines` and `removedPercent`.
- `test_cases_dropped`: a changed test file (a path under `test/`,
  `tests/` or `__tests__/`, or named `*.test.*`, `*.spec.*`, `test_*.py`,
  `*_test.py`, `*_test.go`, `*Test.java`) whose count of test-case markers
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
