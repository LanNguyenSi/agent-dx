# Check catalog

The full set of rules `okf-kit check` runs, plus repo-root auto-detection,
exit codes and the output format. See the main [README](../README.md) for
install and quick-start commands.

## Rules

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. Exception under OKF v0.2 (see [Spec version](#spec-version---spec)): the BUNDLE-ROOT `index.md` may carry a frontmatter block with exactly one key, `okf_version`; any other key next to it, the key on a non-root `index.md` or on `log.md`, and any frontmatter at all under v0.1 stay errors. When that one key is an `okf_version` this tool does not recognize, the finding names the value and the supported versions instead of the generic "must not carry a frontmatter block" text. |
| `reserved-files-structure` | log.md: error (v0.2) / warning (v0.1); index.md: warning | Body structure of the reserved files. `log.md`: every level-2 heading must be exactly `## YYYY-MM-DD` (a real calendar date, nothing after it) and the date headings must be strictly newest first; one finding per bad heading, per wrong-level date heading, and per out-of-order heading, plus one file-level finding when a non-empty `log.md` has no date heading at all. `index.md`: should be headings plus `- [Title](url) - description` link entries, so a free-prose paragraph is a warning (one per paragraph). A conformant optional `#` title, list items that are links without a description, nested link items, fenced code blocks and HTML comments are accepted. See [Reserved file bodies](#reserved-file-bodies-reserved-files-structure). |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. A relative target that climbs out of the bundle directory (`../outside.md`) and still resolves on disk is accepted; the rule checks resolution, not containment. |
| `no-absolute-links` | warning | Markdown links to `.md` targets should not start with `/`; links to other file types are not checked. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources` and `applies_to`, when present, must each be a non-empty array of non-empty strings. With a repo root (explicit or auto-detected), each listed path (file or directory) must also stay inside it (a `..` escape is an error naming the field; the check is lexical and does not resolve symlinks) and exist under it. `applies_to` is validated exactly like `sources` (same shape, same existence check, same resolution, same severity, no globs) but is lookup-only: `docs-for` matches it and `sources-fresh` never reads it, so a broad directory there never makes the doc stale. Use `applies_to` for a doc that is a procedure for work in some area (a runbook); use `sources` for a doc that describes code whose changes must trigger re-verification. A finding names the offending field. A `sources` entry may also be an OKF v0.2 mapping (see [Sources entries](#sources-entries-strings-and-v02-mappings)): a mapping without a non-empty `resource` is one error per mapping, and a `resource` that is not a `scheme://` URL is checked exactly like a string entry. |
| `sources-fresh` | warning / notice | For docs with a `sources` list and a repo root, flags a source path whose last git commit is newer than both the doc's `timestamp` and the doc file's own last re-stamping commit. The doc's stamp is its EFFECTIVE stamp: the OKF v0.2 `generated.at` when present, else the v0.1 `timestamp` (same effective stamp on both sides of the re-stamp comparison, including the historical blobs it parses). A comment-only commit to a cited source still makes the doc stale (see [Comment-only source edits](staleness.md#comment-only-source-edits)). See [Staleness](staleness.md). |
| `sources-fresh-future` | warning / notice | For the same docs as `sources-fresh`, flags the effective stamp (`generated.at` when present, else `timestamp`) later than the doc file's own last commit by more than a clock-skew allowance (default 10 minutes, `--future-skew-minutes`). Catches a local wall-clock time mistakenly written with a `Z`/UTC suffix. A designator-less `timestamp` is skipped with a notice; a designator-less v0.2 `generated.at` is skipped silently, because `generated-shape` reports it as an error. See [Staleness](staleness.md). |
| `generated-shape` | error / warning | Frontmatter `generated` (the OKF v0.2 replacement for `timestamp`): `generated.by` must match one of `<producer>/<version>` (e.g. `okf-kit/0.19.0`), `human:<id>`, `process:<id>` (warning); under spec v0.2 the `generated` key itself is checked too, one warning each for a `generated` that is not a mapping (a scalar stamp, a native YAML date, a list, an empty value; the warning names what was found) and for a mapping missing `by` or missing `at` (or carrying an `at` that names no instant: null, blank, or a value that is not a parseable date-time, i.e. one `Date.parse` does not accept), since such a doc has no usable stamp even though the key is there, and `generated.at` must carry an explicit UTC designator (`Z`) or numeric offset like `+02:00` (error, only once a value that really is a date-time lacks it); a `generated.at` and a `timestamp` on one doc naming DIFFERENT instants is reported once (warning, `generated.at` is the stamp the freshness rules read; both naming the SAME instant is a redundant mid-migration state and passes). |
| `footnotes-resolve` | error / warning | Spec v0.2 only. Every body footnote reference `[^id]` must resolve to a `sources` mapping entry with that `id` (error, once per distinct id), and every `sources` entry with an `id` must be referenced by at least one `[^id]` (warning, once per entry). A definition line `[^id]: ...`, fenced code and inline code are not references; a definition alone does not count as referencing its entry. Ids are case-sensitive. See [Footnote citations](citations.md#footnote-citations-okf-v02). |
| `citations-resolve` | warning / notice | For docs with a repo root, flags a `` `path:N`/`path:N-M` `` citation (and its continuations and short forms) whose target file is missing, whose range is inverted or exceeds the file, or whose start line is blank or (for a non-markdown target) only a closing brace. `--require-anchors` opts into five additional checks. Only paths ending in `.ts`, `.js`, `.mjs`, `.md`, `.yml`, `.yaml`, `.json` or `.prisma` are recognised. Under spec v0.2 it also checks the line numbers written in a footnote definition against the file the footnote's `sources` entry names. See [Citation resolution](citations.md). |
| `citation-drift` | (opt-in, `--base <ref>`) warning | Off by default. With `--base <ref>`, flags a line citation (primary, continuation, extension or short-form) whose cited text, as it was at the ref, is no longer at the cited lines: `citation-moved` when an edit shifted it and the new lines are known (`okf-kit repoint` re-points it), `citation-content-changed` when an edit touched the cited lines themselves. See [Drift since a git ref](citations.md#drift-since-a-git-ref---base). |
| `prose-line-references` | (opt-in, `--prose-line-references`) warning / notice | Off by default. Flags a prose-embedded line reference outside `citations-resolve`'s own backtick grammar (`line N`, `lines N-M`, `lines N to M`) that is drifted, unresolvable, or ambiguous once bound to the nearest named file. See [Prose line references](prose-line-references.md). |
| `frontmatter-refs-resolve` | error / notice | Frontmatter `lessons[].runbook` and `derived_from[]`, when present on any doc, must resolve to an existing `.md` file. See [Frontmatter references](#frontmatter-references-frontmatter-refs-resolve). |

## Frontmatter references (`frontmatter-refs-resolve`)

Checked only when the field is present; a bundle without `lessons` or `derived_from` produces no findings from this rule.

- `lessons[].runbook`: a string per `lessons` entry (an entry without a `runbook` key is ignored).
- `derived_from[]`: an array of strings.

Resolution:

- `<alias>:<path>` resolves to `<companion dir>/<path>`, where `<companion dir>` comes from `--companion <alias>=<dir>`.
- Anything else is a path relative to the doc's own directory inside the checked bundle.
- The prefix before the first `:` counts as an alias only when it matches `[a-z0-9-]+`. A value that contains a colon with any other prefix (`Notes v2:a.md`, `C:\x`) is an ordinary relative path and is not looked up as an alias. Windows drive paths are not supported.
- A value that looks like a URL (a prefix of `http`, `https`, `file` or `mailto`, or an alias-shaped prefix followed by `//`, matched case-insensitively) is an error: URLs are not supported, reference a `.md` file. This holds under `--skip-companion-refs` too.
- An absolute path without an alias prefix (`/etc/x.md`) is an error: unprefixed refs must be relative to the doc, consistent with `no-absolute-links`.
- The target must be an existing file whose name ends in `.md`.
- Containment: an unprefixed ref must stay inside the checked bundle and an alias ref inside its companion dir. A `../` climb or an absolute path that leaves that directory is an error even when the target exists. Containment is lexical, like the path handling in `links-resolve`: symlinks are not followed, so a symlink that points out of the bundle is not detected.
- An alias that was not passed is an error. With `--skip-companion-refs` it is a notice instead, so a bundle can be checked on its own without its companion.
- Malformed shapes are errors, never crashes: `lessons` or `derived_from` not an array, a `lessons` entry that is not a mapping, a `runbook` or `derived_from` element that is not a non-empty string. A doc with missing or unparseable frontmatter is left to `frontmatter-required`.

CLI options (on `check`):

| Option | Meaning |
|--------|---------|
| `--companion <alias>=<dir>` | Declares a companion bundle directory for `<alias>:<path>` refs. Repeatable. A value with no `=`, an empty alias or directory, an alias outside `[a-z0-9-]+`, a duplicate alias, a reserved URL scheme (`http`, `https`, `file`, `mailto`) as alias, or a directory that does not exist is a CLI error (exit 2). |
| `--skip-companion-refs` | An `<alias>:<path>` ref whose alias was not passed is reported as a notice instead of an error. Refs into the checked bundle and refs with a passed alias are still checked. |

## Sources entries (strings and v0.2 mappings)

A `sources` list may mix both shapes, under either spec version:

```yaml
sources:
  - src/client.ts                       # v0.1: a repo-relative path string
  - id: retry                           # v0.2: a mapping
    resource: src/client.ts             # required: a path or a URL
  - id: spec
    resource: https://example.com/spec  # a URL: never touched on disk
    title: The spec
```

- A mapping needs a non-empty string `resource`; without one `sources-shape` reports an error for that mapping (one per mapping) and the doc's other entries are still checked. The optional `id` must be a non-empty string or a number (it is the key a `[^id]` footnote resolves by); the other v0.2 keys (`title`, `author`, `usage_count`, `last_modified`, ...) are not read.
- A mapping `resource` that is not a URL is a repo-relative path, resolved against `--repo-root` exactly like a string entry: the same containment check (a `..` escape is an error), the same existence check, the same leading-slash rule, and the same staleness (`sources-fresh`) and reverse-lookup (`docs-for`) treatment. `citations-resolve` and `prose-line-references` treat it as an allowed citation target like any other source.
- A `resource` is a URL when it starts with `scheme://` (a scheme of at least two characters: `https://`, `file://`, ...). A URL resource is skipped for existence, containment, staleness and `docs-for`, and never fetched or validated. The test is anchored at the start, so `../x://y` and `docs/a://b.md` are paths and stay subject to the containment check. `urn:` and `mailto:` style resources have no `//`, so they count as paths (and fail the existence check); keep them out of `sources`, or write them as a `https://` URL.
- A **string** entry is always a path, whatever it contains, exactly as before v0.2.
- `applies_to` is unchanged: a list of path strings only.

## Reserved file bodies (`reserved-files-structure`)

The OKF spec reserves `log.md` and `index.md` at any depth and constrains their bodies (v0.1 section 7 / v0.2 section 9, conformance v0.1 9.3 / v0.2 11.3). `reserved-files-bare` checks that they carry no frontmatter block; this rule checks what is left. Findings carry the offending line in `message`.

- `log.md` (error under v0.2, warning under v0.1):
  - a level-2 heading whose text is not exactly `## YYYY-MM-DD` is one finding (extra text after the date such as `## YYYY-MM-DD (release notes)`, a non-date heading such as `## Introduction`, or a date that does not exist, such as a February 30), naming the heading and its line;
  - a heading at another level whose text is a bare ISO date (`### YYYY-MM-DD`) is one finding: date headings must be level 2;
  - a non-empty `log.md` with no valid date heading at all and no bad heading to point at (a flat bullet list, a lone `#` title) is one file-level finding;
  - a date heading that is not strictly older than the previous valid date heading (out of order, or the same date twice) is one finding naming the heading and line;
  - lines inside a fenced code block are never headings, so a date heading shown as an example inside a fence is not reported; the fence opener may carry an info string (```` ``` bash ````), and a fence closes only on a line of the same fence character as the opener, at least as long as it and followed by nothing else (a `~~~` line or a shorter ```` ``` ```` run inside a ```` ``` ```` block is content; an unclosed fence runs to the end of the file). A fence is recognised with at most three leading spaces, as at the top level of a document; fences inside nested list items or block quotes are not tracked. An HTML comment contributes no heading either, and masking it out does not shift the other lines' numbers.
- `index.md` (warning, both versions): a run of free-prose lines (one paragraph) is one warning naming its first line. The shape the spec recommends is headings plus `- [Title](url) - description` entries, so:
  - a list item is a conformant entry when its content begins with a markdown link; the trailing ` - description` is optional and its separator (or a description that wraps onto following lines) is not enforced (the spec only says SHOULD);
  - nested list items are allowed when they are link entries, and their wrapped descriptions are absorbed into the item;
  - a list item that is not a link (a plain-text bullet, at any depth) and an ordinary paragraph are free prose;
  - an optional `#` title, fenced code blocks and HTML comments are not free prose.

## Spec version (`--spec`)

`check` resolves the OKF spec version to check against, exposes it to every rule as the bundle context's `specVersion`, and branches the version-sensitive rules on it: `reserved-files-bare` (the root `okf_version` block), `reserved-files-structure` (`log.md` findings are errors under v0.2 and warnings under v0.1, because the existing corpus predates the log format), `generated-shape` (the shape of the `generated` key, the requirement that it carry `by` and `at`, and the offset requirement for `generated.at`), `footnotes-resolve` (runs under v0.2 only) and the footnote line check inside `citations-resolve` (v0.2 only). The freshness rules read `generated.at` as the effective stamp under every spec version; only the designator-less skip notice of `sources-fresh-future` is suppressed under v0.2, where `generated-shape` reports the error instead.

- **Detection:** the BUNDLE-ROOT `index.md` frontmatter may carry exactly one key, `okf_version` (OKF v0.2), e.g. `okf_version: "0.2"`. The YAML number form (`okf_version: 0.2`) is accepted too, but only spelled exactly like that: YAML resolves the number `0.20` to `0.2`, and a misspelling is not a declaration. No key, no frontmatter, an unparseable block, or a value that is neither `0.1` nor `0.2` resolves to `v0.1`, and a value that is present but unrecognized (a future `0.3`, a typo, a `0.20`) is then reported by `reserved-files-bare` with the value it declares and the supported versions, so a half-migrated bundle never has to work out on its own why its version block was rejected. A non-root `index.md` never declares the version (`reserved-files-bare` flags such a block).
- **Override:** `check <bundle> --spec v0.1` or `--spec v0.2` replaces the detected version, in either direction (e.g. `--spec v0.1` re-flags a v0.2 version block). Any other value is a usage error (exit 2). The frontmatter accepts the bare number form; the flag deliberately takes only the `v0.1`/`v0.2` spelling.

## repo-root auto-detection

**Behavior:** when `--repo-root` is omitted, okf-kit runs `git rev-parse --show-toplevel` from the bundle directory and uses the result if it succeeds. A bundle that lives inside a git work tree gets `sources-shape` existence checks, `sources-fresh`/`sources-fresh-future` staleness checks and `citations-resolve` (and, when enabled, `prose-line-references`) citation checks by default, not just when `--repo-root` is passed explicitly.

If the bundle is not inside a git work tree (or `git` is unavailable), repo-root stays unset: `sources-shape` skips existence checks, and `sources-fresh` emits a single notice (`staleness skipped: not inside a git work tree`) rather than silently reporting nothing, so a "clean" run is never a fake pass; `citations-resolve` and, when enabled, `prose-line-references` each emit their own single notice the same way.

With an explicit `--repo-root` but no usable `git`, the existence and citation checks still run, and `sources-fresh` reports an `untracked by git, staleness unknown` notice for each source instead of a verdict.

Pass `--repo-root` explicitly to pin a specific root (useful in CI when the bundle and the code it documents live in different checkouts) or to opt out of the ambient repo (point it at the bundle directory itself to disable these checks' access to the rest of the repo).

## Filtering findings

`--rule <ids>` reports only findings of the given rule ids (comma-separated, and the flag is repeatable). The ids are the ones in [Rules](#rules); an unknown id is a usage error (exit `2`) whose message lists the valid ids.

`--min-severity <level>` reports only findings at that severity or above, in the order `error` > `warning` > `notice`; any other value is a usage error (exit `2`).

Both filters apply to the text and the JSON output alike, including the JSON `summary` counts, and the exit status is computed from the reported findings only: `okf-kit check <bundle> --rule no-absolute-links` exits `0` on a bundle whose only errors come from other rules, and `--strict --min-severity error` ignores warnings.

An empty `--rule` value (`--rule ""`, `--rule ,`) is a usage error (exit `2`) rather than "every rule"; omit `--rule` to report every rule. A filtered run reports only what passes the filters, so the text output can say `clean, no findings` while filtered-out errors or skip notices exist (for example a `sources-fresh` notice that staleness was not checked); run without the filters to see everything.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No errors (and, under `--strict`, no warnings either). Only reported findings count (see [Filtering findings](#filtering-findings)). |
| 1 | At least one error (or, under `--strict`, at least one warning). Only reported findings count (see [Filtering findings](#filtering-findings)). |
| 2 | Invocation or tool error: the bundle directory does not exist or is not a directory; an invalid option value (`--future-skew-minutes` that is not a non-negative number, a malformed `--companion`, an unknown or empty `--rule` id list, an invalid `--min-severity` level or an invalid `--spec` version, see above; a `--base` ref that names no commit, or `--base` outside a git work tree); a `repoint` usage error (see [Re-pointing citations](repoint.md)); `init`'s target is non-empty without `--force`, or exists and is not a directory; a `docs-for` usage error (see [Reverse lookup](docs-for.md)); a commander usage error (unknown option, missing argument, missing/unknown command); or any other error that stops the run, such as an unreadable bundle file. `--help` and `--version` still exit 0. |

## Output

`check --json` prints one pretty-printed JSON object to stdout:

```json
{
  "bundleDir": "/abs/path/to/bundle",
  "findings": [
    { "ruleId": "...", "severity": "warning", "file": "a.md", "message": "...", "detail": "..." }
  ],
  "summary": { "errors": 0, "warnings": 1, "notices": 0 }
}
```

- `severity` is `error`, `warning` or `notice`. Only errors, and warnings under `--strict`, affect the exit code; notices never do.
- `file` is the doc's bundle-relative path, or the empty string for a bundle-level notice such as `staleness skipped: not inside a git work tree`.
- `detail` is present only on findings that carry extra context (for example a resolved path or a list of candidates).
- `bundleDir` is the absolute path the bundle argument resolved to, so it is not portable across machines.
- `ruleId` is one of the rule names in the table above. `citations-resolve` and `prose-line-references` report their finding id (for example `blank-start-line`) as a bracketed suffix at the end of `message`, not in `ruleId`; filter on that suffix to select one kind of finding (see [Citation resolution](citations.md) and [Prose line references](prose-line-references.md)).

Without `--json`, `check` prints one `<SEVERITY> <ruleId> <file>: <message>` line per finding (`ERROR`, `WARN` or `NOTICE`), grouped by file, each followed by an indented `detail` line when present, then a closing `<total> findings (errors <e>, warnings <w>, notices <n>)` line. A run with no findings prints `okf-kit: clean, no findings in <dir>` instead.

An invocation or tool error (exit 2) prints a message to stderr and no report.
