# Re-stamping docs (`restamp`)

`okf-kit restamp <bundleDir>` sets the stamp of every doc that `check` reports `STALE` to the current UTC time, and can add one entry to the bundle's `log.md`. It replaces the hand-written loop over `check --json` that a strict freshness guard otherwise calls for after every source change.

A stamp is the claim "this doc was verified against its `sources` as they are". Run `restamp` only after you have re-verified the stale docs, and after the source changes are committed (see [the order of steps](#the-order-of-steps)).

```bash
# dry run (the default): print which docs would be stamped, write nothing
okf-kit restamp path/to/bundle

# rewrite the stamps
okf-kit restamp path/to/bundle --write

# also add one entry to the bundle-root log.md
okf-kit restamp path/to/bundle --write --log-entry "re-verified after the retry change in src/client.ts"

# the plan as JSON
okf-kit restamp path/to/bundle --json
```

Example output of a dry run:

```text
would re-stamp doc.md: timestamp <previous stamp> -> <new stamp>
would add to log.md under ## <today>: re-verified after the retry change in src/client.ts
1 to re-stamp (dry run, pass --write to rewrite), 0 refused, 0 need manual handling
```

A refused run ends with `0 re-stamped (refused, nothing written), <n> refused, 0 need manual handling` instead, with or without `--write`.

## The order of steps

[`sources-fresh`](staleness.md) accepts a doc as fresh when the doc's own last commit lands at or after the source's last commit and that commit moved the stamp strictly later. So the stamp has to be written after the source change is committed, and the re-stamped docs are committed next:

1. Change the sources and commit.
2. Re-verify every doc `check` reports `STALE` (if citations moved, `repoint --base <ref> --write` first, see [Re-pointing citations](repoint.md)).
3. `okf-kit restamp <bundleDir> --write [--log-entry <text>]`.
4. Commit the docs (and `log.md`).

A stamp is a claim about the sources as they are, so it must not be written while a source still has uncommitted changes: it would vouch for content that is not committed yet, and the commit that lands it can carry a date the stamp does not clear. `restamp` therefore refuses: if any `sources` entry of a doc it would stamp has uncommitted changes (modified, staged, deleted or untracked; a directory entry counts when anything below it is dirty), or git cannot report the work tree state, it prints a `REFUSED` line per doc and source, writes nothing (not even the other docs or the log), prints a summary that says nothing was written (never the dry-run summary) and exits `1`. Every source of the doc counts, not only the one found stale. A dirty source of a doc that is not stale does not block.

When a doc lists a directory that contains the bundle itself (`sources: [docs]` for a bundle in `docs/okf`), the bundle's own docs and its `log.md` do not count as dirty content of that directory: they are what `restamp` writes. Any other dirty file below the directory still refuses, a non-doc file inside the bundle directory included. A dirty file source is never excluded, even when it is a bundle doc.

This differs from [the same-commit advice](staleness.md): committing the source change and a hand-written stamp together lets the re-stamp rule treat the doc as fresh, but `restamp` has no committed source time to measure its stamp against until the source is committed, so it waits for that commit.

## Which docs

The stale set is the verdict of the `sources-fresh` rule itself, the same code `check` runs, not a reading of `check`'s output: a doc is stamped exactly when `check` reports a `STALE:` warning for it. A doc that is fresh, not assessable (shallow clone, untracked source, no valid stamp) or has no `sources` is left alone.

## The new stamp

- The clock reading to the second, in the `YYYY-MM-DDTHH:MM:SSZ` spelling bundles stamp with.
- Never equal to or earlier than the stamp it replaces: when the previous stamp is not in the past, the new one is one second after it. A stamp that stayed the same or moved back would not count as a re-stamp for `sources-fresh`.
- Never earlier than the last commit of the doc's sources (committer time, as `sources-fresh` reads it): a source commit dated after the clock sets the stamp to that commit's time. A stamp equal to the commit time is fresh, `sources-fresh` calls a source stale only when its commit is strictly later.
- At most the future allowance ahead of the clock: 10 minutes by default, `--future-skew-minutes <n>` as for `check`. The comparison is strict like `sources-fresh-future`'s: a stamp exactly the allowance ahead is accepted, one second more would be flagged future-dated. A doc whose smallest valid stamp is further ahead (a previous stamp that is already that far in the future, or a source commit dated that far ahead) is listed as `MANUAL` with the reason and left alone; the other docs are still stamped, and the exit code is `1`. With the default allowance, a previous stamp 599 s ahead of the clock is stamped 600 s ahead; one 600 s ahead is `MANUAL`.
- It is written where the doc keeps its effective stamp: `generated.at` when the doc has one (OKF v0.2), else `timestamp`. A `timestamp` beside a `generated.at` that names the same instant is kept in step; one that names another instant is left alone (`generated-shape` reports the divergence). Quoting, a trailing comment, the rest of the frontmatter and the line endings stay byte for byte.

## The log entry

With `--log-entry <text>` and at least one re-stamped doc, one entry is added to the log at the bundle root, in the position and shape the log already uses (`reserved-files-structure` requires date headings, newest first):

- The log has `## YYYY-MM-DD` headings: the entry goes first under today's UTC heading. When the newest heading is older, a heading for today is created above it. When the newest heading is later than today no position keeps the order: that is a usage error, raised before anything is written.
- The log is a flat bullet list: the entry goes above the first bullet.
- The log has neither: a date heading and the entry are appended.

The entry reads `- <stamp>, <text>`. Entries are separated by a blank line when the existing ones are, and packed when they are not; headings and bullets inside a fenced block or an HTML comment are not read; further lines of a multi-line text are indented by two spaces. A bundle without a root `log.md` makes `--log-entry` a usage error. Without `--write` the entry is only reported.

## Options

| Option | Meaning |
|--------|---------|
| `-w, --write` | Rewrite the docs (and the log). Without it nothing is written. |
| `--log-entry <text>` | Add one entry to the bundle-root `log.md` when a doc is re-stamped. |
| `-r, --repo-root <path>` | Repo root the `sources` resolve against (auto-detected from the bundle dir when omitted). |
| `--future-skew-minutes <n>` | How far ahead of the clock the new stamp may be, in minutes (default 10), as for `check`. A non-negative number; anything else is a usage error. |
| `-j, --json` | Output `{ bundleDir, written, stale, stamped, refused, manual, logEntry }`. |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Nothing is refused or left for manual handling (including: no doc is stale). |
| 1 | A source has uncommitted changes (nothing written), or a doc needs manual handling (the others are still stamped under `--write`). |
| 2 | Usage or tool error: unknown bundle directory, no git work tree, `--log-entry` with an empty text, without a root `log.md`, or with a log whose newest heading is later than today. |
