# Re-pointing citations (`repoint`)

`okf-kit repoint <bundleDir> --base <ref>` rewrites the line numbers of citations whose cited text moved since `<ref>`, after a source edit inserted or removed lines. It is the mechanical half of the `citation-drift` check (`check --base <ref>`, see [Drift since a git ref](citations.md#drift-since-a-git-ref---base)): it uses the same verdicts, so what `check --base` reports as `citation-moved` is exactly what `repoint` rewrites.

```bash
# dry run (the default): print what would change, write nothing
okf-kit repoint path/to/bundle --base origin/main

# rewrite the docs
okf-kit repoint path/to/bundle --base origin/main --write

# the plan as JSON
okf-kit repoint path/to/bundle --base origin/main --json
```

Example output of a dry run:

```text
would re-point doc.md: `src/a.ts:6-8` lines 6-8 -> lines 9-11
would re-point doc.md: `src/a.ts:10 (continuation)` line 10 -> line 13
MANUAL doc.md: `src/a.ts:12`: lines inside the cited range were edited, removed or interleaved with new lines since origin/main
2 to re-point (dry run, pass --write to rewrite), 1 need manual handling, 3 unchanged, 0 skipped (base origin/main)
```

## What it rewrites

Primary citations (`path:N`, `path:N-M`, anchored or not), continuations (`` `:N` ``, `` `:N-M` ``, `` (`N`) ``), extensions (`` `path:N`-`M` ``, only the `M`) and bound short forms (`:N-M`). Only the digits of the line numbers change: an `#anchor`, the surrounding prose, the frontmatter and its `timestamp` or `generated` stamp stay as they are. `repoint` never re-stamps a doc and never writes a `log.md` entry; do both yourself once you have verified the result.

A citation is rewritten only when no hunk of `git diff -U0 <ref>` touches the cited range, so the whole range shifted by the net line change above it, and the text at the new lines equals the text at the old lines at the ref. Anything else is listed as `MANUAL` and left alone: a line inside the range was edited or removed, lines were inserted between the first and last cited line, or the shifted text does not match. What is not judged at all (new file, citation written since the ref, reserved docs, ...) is counted in the summary line and, by reason, under `skipped` in the `--json` output.

## Options

| Option | Meaning |
|--------|---------|
| `--base <ref>` | Required. The git ref (branch, tag or commit) the docs' line numbers were written against. A ref that names no commit is a usage error (exit 2). |
| `-w, --write` | Rewrite the docs. Without it nothing is written. |
| `-r, --repo-root <path>` | Repo root the citations resolve against (auto-detected from the bundle dir when omitted). |
| `-j, --json` | Output `{ bundleDir, base, written, rewrites, refused, skipped, unchanged }`. |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Nothing needs manual handling (with `--write` the rewrites are written; without it the plan was printed). |
| 1 | At least one citation needs manual handling. Under `--write` the re-pointable citations are still written. |
| 2 | Usage or tool error: unknown bundle directory, missing `--base`, a `--base` ref that names no commit, no git work tree. |

`repoint` counts only the citations that reach the drift analysis. A citation that no longer resolves to a file (the cited file was deleted, or the doc still spells the old path of a renamed file) is not counted in the summary and does not make the exit code 1; `okf-kit check` reports it as `missing-file`. A citation whose sentence changed since the ref and which is paired with the ref's citation only by file and numbers is listed as `MANUAL` and never rewritten, because it may already have been fixed by hand.

Run `okf-kit check <bundleDir> --base <ref>` afterwards: a clean re-point leaves only `citation-content-changed` findings, and a second `repoint` run changes nothing.
