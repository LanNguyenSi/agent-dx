# `drift`

Finds prose and comments that still cite an identifier a change deleted or renamed. Part of the [agent-primitives](../README.md) CLI.

After a change deletes or renames an identifier, docs and comments that
still describe the old name as current are drift; this command lists
them. Anchored by a measurement of the real case this prototype is
built from; see this package's own `CHANGELOG.md` for the detail.

```bash
agent-primitives drift --base <rev> --head <rev>
agent-primitives drift --base <rev> --head <rev> --allow 'docs/legacy/**' --strict
agent-primitives drift --base <rev> --head <rev> --ignore-identifier legacyHelper --ignore-identifier-file ignore.txt
```

Given a git range, collects the identifiers whose declaration the range
removed, then reports every mention of those
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

`--base` and `--head` are each resolved to a commit SHA once, and the
diff runs from the merge-base of the two to `--head`: the change the
head side made since it branched off, never the base side's later
commits. A symbolic base such as `origin/master` therefore reports the
same result as the SHA it resolves to, even when it moved after the
branch point. (Earlier versions diffed the two trees directly, which
reported every declaration the base side had added since the branch
point as removed.) When the two share no history, the trees are diffed
directly and a warning says so, naming a shallow clone as the likely cause
when the repository is one (fetch more history, or `git fetch --unshallow`). The envelope carries `base` and `head`
as given, plus `base_sha`, `head_sha` and `merge_base`, the commit the
diff started from; it equals `base_sha` when `--base` is an ancestor of
`--head`.

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
that word. Every extracted identifier also carries the two facts the
same line shows: `exported` (the line had an `export` keyword after any
indentation) and `indented` (the line began with whitespace, so the
binding was inside an enclosing scope rather than at column 0). A config
key is never `exported`, and a kind `file` candidate has no line to read
either fact from, so both are `false` for it. An identifier declared on
both a removed and an added line
anywhere in the same diff is treated as MOVED, never as removed, on the
reading that the same declaration reappearing means it moved rather
than disappeared; a deleted file whose basename reappears as a newly
added file's basename is treated the same way. This is name-only and
can both over- and under-forgive: an unrelated declaration of the same
name added elsewhere in the diff is forgiven too.

A site is allowlisted by default (reported separately, in
`allowlisted`, and excluded from `sites` and from the exit code) when
any of: the site's identifier was named with `--ignore-identifier`
(repeatable) or `--ignore-identifier-file` (one name per line, blank
lines and `#` comments ignored, the file resolved against the `-C`
directory) - the reason is `ignored identifier "<name>"` and it outranks
the reasons below, because it is the caller's own statement about that
identifier (an empty name is a usage error, exit `2`, since an empty
pattern would match everything); it matches an `--allow <glob>` (repeatable; `**` crosses path
segments, `*` stays within one); it sits in a released CHANGELOG
section (a `## [x.y.z]` or `## x.y.z` heading; `## [Unreleased]` is
never a released section, so a site under it is still reported); its
path is under `docs/**/migration*` or it sits under a Markdown heading
whose text contains "migration" (a heading inside a fenced ``` or ~~~
code block is never counted as document structure); a small,
documented historical-phrase word list (`former`, `formerly`, `used
to`, `no longer`, `removed`, `renamed`, `replaced`, `dropped`,
`deleted`, `previously`, `was `) has a match within a bounded span
around the identifier's own mention on the line - up to about 60
characters before it (cut short at the nearest preceding `. `/`; `
sentence boundary) and about 20 characters after - rather than anywhere
on the whole line, so an unrelated historical phrase far away on a long
line never suppresses a present-tense mention; or the local-binding rule
below allows it.

The local-binding rule is on by default and needs no option. A removed
candidate that was `!exported && indented && kind == "declaration"` was
bound inside some enclosing scope (a function body, a method, a block),
so its removal says nothing about whether the name is gone. For every
such candidate name (and only those: an exported, column-0 or
non-declaration candidate is never touched, and neither is a name an
explicit `--ignore-identifier` already covers) the command runs ONE
`git grep -n -w -E` at `--head` over the scanned source pathspecs for the
declaration shape `(const|let|var|function|class) <name>`. Where at least
one such head-side declaration exists, the name is still alive under a
binding of its own, and its sites are allowlisted with reason
`local binding "<name>" still declared at head` (visible under
`--strict`); the name is echoed in `ignored_identifiers` with source
`local-binding`. Where none exists, behaviour is exactly as before: the
sites are reported as usual. The trailing word boundary that shape needs
is `-w`'s own (git's `-E` on a BSD regex build reads `\b` as a literal,
which would silently match nothing). Two shapes the grep itself matches
are not live declarations and are filtered after the grep: a comment line
(`// const stamp = old approach`, whose text before the keyword names a
comment) and a longer name whose next character `-w` reads as a word
boundary (`let retired$old`, because git treats `$` as a non-word
character). That filter checks only a comment prefix at the start of the
line (`//`, `/*`, `*`, `#`) and the character after the name; `-w` supplies
the word boundary on both sides of the shape, so `superclass err` never
matches. Limits: the shape inside a string, a template literal, JSX text,
or a comment that does not start the line still counts as a declaration
and suppresses; indentation is a proxy for
scope, not a scope analysis, so an indented declaration inside a block
that still leaves a name unreachable at head is suppressed too, while a
top-level `let` reassigned by a local of the same name is not; and the
head-side shape does not see a destructuring binding
(`const { err } = ...`), a function parameter, a Python `def <name>` or a
Go `func <name>`, so a local binding written that way does not suppress
anything.

`--strict` also adds
every allowlisted site into `sites` (flagged with `allowlisted: true`
and its `allowlistReason`), so a site this command would otherwise
suppress by default counts toward the exit code too; `allowlisted`
itself always carries every allowlisted site regardless of `--strict`,
including the ignored and locally-bound ones, which is what
`counts.allowlisted` counts.

Envelope fields: `removed_identifiers` (`name`, `kind`
`declaration`/`config_key`/`file`, `file`, `line`, `exported`,
`indented`), `ignored_identifiers` (`name`, `source`
`flag`/`file`/`local-binding`: every name the caller asked to ignore,
whether or not it produced a site, plus one `local-binding` entry per
name the default rule suppressed), `sites` and
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

## Compact views: --summary and --print

`--summary` and `--print <field,...>` print a second rendering of the same
result; they work like the views of [probe](probe.md#compact-views---summary---print-and---report).

`--summary` prints one line per site in `sites` (the allowlisted ones too
under `--strict`, flagged), one `warning:` line per warning, and a final
totals line:

```text
<path>:<line> | <identifier> | <doc|comment>[ | allowlisted] | <text, at most 140 characters>
totals: status=<ok|fail> removed=N sites=N allowlisted=N warnings=N ignored=N [fullResult=<path>]
```

`fullResult=` appears when the envelope was reduced to fit `-m` and the
complete result was saved. `-m` is a character budget: rows that do not
fit are replaced by one marker line naming how many were omitted, and the
totals line is always printed.

`--print` prints one JSON object on one line, one key per requested field
in the order given. A name is a top-level envelope field (`status`,
`sites`, `allowlisted`, `removed_identifiers`, `counts`, `base_sha`,
`head_sha`, `merge_base`, `base`, `head`, `warnings`, `logs`, `fullResult`
and the other fixed fields); a dotted path descends into objects
(`counts.sites`) but not into arrays, so a single site is not addressable
(`sites.0` prints `null`). Fields are read from the unreduced result, so
`-m` does not shorten a printed field; only the printed line is bounded by
it. A field this run did not produce prints `null`.

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
