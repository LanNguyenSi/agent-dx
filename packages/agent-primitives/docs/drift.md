# `drift`

Finds prose and comments that still cite an identifier a change deleted or renamed. Part of the [agent-primitives](../README.md) CLI.

After a change deletes or renames an identifier, docs and comments that
still describe the old name as current are drift; this command lists
them. Anchored by a measurement of the real case this prototype is
built from; see this package's own `CHANGELOG.md` for the detail.

```bash
agent-primitives drift --base <rev> --head <rev>
agent-primitives drift --base <rev> --head <rev> --allow 'docs/legacy/**' --strict
```

Given a git range (`--base`..`--head`), collects the identifiers whose
declaration the range removed, then reports every mention of those
identifiers still present at `--head` in a Markdown/plain-text doc or in
a source comment (never a code line). A doc site is any line of a
`.md`/`.mdx`/`.txt` file; a comment site is a `//`, `/* ... */` or
`*`-continuation line in a `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` file,
a `#` line in a `.py`/`.sh`/`.yml`/`.yaml` file, or (PHP accepts both
comment grammars) a `//`, `#`, `/* ... */`, or docblock `*`-continuation
line in a `.php` file. Every other file extension is out of scope and
never scanned at all. Matching is
whole-word (`RuntimeError` never matches `setRuntimeError`), so a
mention only reports when the removed name reappears as its own word.
`--base`/`--head`/`--allow` and every reported path are resolved
against the git work tree's root, whatever subdirectory `-C`/`--cwd`
itself points at: the whole work tree is always scanned, never only the
named subdirectory.

Removed-identifier extraction is a regex over one diff line, not a
parser, and is prototype scope: a top-level or exported TS/JS
declaration (`export? default? declare? abstract? async?
(type|interface|class|function[*]|const|let|var|enum) Name`, so
`export async function`, `export abstract class` and a generator
`function*` are all recognized), a top-level JSON/YAML config key
(cheap indentation-based heuristic: a key at column 0 for YAML, indented
by at most two spaces for JSON; a more deeply nested key is missed), or
a wholly deleted file's own basename (without extension) - only when
the file's extension is one of the source extensions above AND the
basename itself looks like an identifier (at least 4 characters, and
containing an uppercase letter, a hyphen, or an underscore); a deleted
file whose basename does not clear that bar (`docs/setup.md`,
`logo.png`, `src/index.ts`) contributes nothing and is named instead in
a warning, so an all-lowercase, no-separator basename like `index` or
`setup` never floods the report with every ordinary prose mention of
that word. An identifier declared on both a removed and an added line
anywhere in the same diff is treated as MOVED, never as removed, on the
reading that the same declaration reappearing means it moved rather
than disappeared; a deleted file whose basename reappears as a newly
added file's basename is treated the same way. This is name-only and
can both over- and under-forgive: an unrelated declaration of the same
name added elsewhere in the diff is forgiven too.

A site is allowlisted by default (reported separately, in
`allowlisted`, and excluded from `sites` and from the exit code) when
any of: it matches an `--allow <glob>` (repeatable; `**` crosses path
segments, `*` stays within one); it sits in a released CHANGELOG
section (a `## [x.y.z]` or `## x.y.z` heading; `## [Unreleased]` is
never a released section, so a site under it is still reported); its
path is under `docs/**/migration*` or it sits under a Markdown heading
whose text contains "migration" (a heading inside a fenced ``` or ~~~
code block is never counted as document structure); or a small,
documented historical-phrase word list (`former`, `formerly`, `used
to`, `no longer`, `removed`, `renamed`, `replaced`, `dropped`,
`deleted`, `previously`, `was `) has a match within a bounded span
around the identifier's own mention on the line - up to about 60
characters before it (cut short at the nearest preceding `. `/`; `
sentence boundary) and about 20 characters after - rather than anywhere
on the whole line, so an unrelated historical phrase far away on a long
line never suppresses a present-tense mention. `--strict` also adds
every allowlisted site into `sites` (flagged with `allowlisted: true`
and its `allowlistReason`), so a site this command would otherwise
suppress by default counts toward the exit code too; `allowlisted`
itself always carries every allowlisted site regardless of `--strict`.

Envelope fields: `removed_identifiers` (`name`, `kind`
`declaration`/`config_key`/`file`, `file`, `line`), `sites` and
`allowlisted` (`path`, `line`, `identifier`, `kind` `doc`/`comment`,
`text` - the matched line, trimmed, capped at 300 characters with a
trailing `...` marker when longer - and on an allowlisted entry
`allowlisted: true` plus `allowlistReason`), and `counts` (`removed`,
`sites`, `allowlisted`), which is always reported whole even when
`sites`/`allowlisted` themselves are cut under `--max-chars` reduction.
`status` reuses the package's own verify-shaped values rather than
inventing new ones: `ok` (no site reported, exit `0`), `fail` (at least
one site reported, exit `1`), `usage_error` (`cwd` outside a git work
tree, `--base`/`--head` not a real revision, or `git diff` itself
failed, exit `2`).

Known limits, on top of the ones named above: only tracked content at
`--head` is ever scanned (`git grep` on that revision), so an untracked
file is never a site; a removed-identifier declaration split across
more than one line, or a name bound by destructuring, is missed; a
deleted file's basename that is short or all-lowercase-with-no-
separator (`db`, `api`) is never reported even when it is a real
identifier elsewhere; no cross-repo scanning. The historical-phrase
window's converse failure mode: a legitimate historical mention more
than about 60 characters before the identifier's own mention (or behind
a `. `/`; ` sentence boundary within that lookback), or more than about
20 characters after it, is still reported rather than allowlisted; use
`--allow` or reword the mention to bring it inside the window.

