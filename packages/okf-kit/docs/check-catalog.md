# Check catalog

The full set of rules `okf-kit check` runs, plus repo-root auto-detection,
exit codes and the output format. See the main [README](../README.md) for
install and quick-start commands.

## Rules

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. A relative target that climbs out of the bundle directory (`../outside.md`) and still resolves on disk is accepted; the rule checks resolution, not containment. |
| `no-absolute-links` | warning | Markdown links to `.md` targets should not start with `/`; links to other file types are not checked. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources` and `applies_to`, when present, must each be a non-empty array of non-empty strings. With a repo root (explicit or auto-detected), each listed path (file or directory) must also exist under it. `applies_to` is validated exactly like `sources` (same shape, same existence check, same resolution, same severity, no globs) but is lookup-only: `docs-for` matches it and `sources-fresh` never reads it, so a broad directory there never makes the doc stale. Use `applies_to` for a doc that is a procedure for work in some area (a runbook); use `sources` for a doc that describes code whose changes must trigger re-verification. A finding names the offending field. |
| `sources-fresh` | warning / notice | For docs with a `sources` list and a repo root, flags a source path whose last git commit is newer than both the doc's `timestamp` and the doc file's own last re-stamping commit. See [Staleness](staleness.md). |
| `sources-fresh-future` | warning / notice | For the same docs as `sources-fresh`, flags a `timestamp` later than the doc file's own last commit by more than a clock-skew allowance (default 10 minutes, `--future-skew-minutes`). Catches a local wall-clock time mistakenly written with a `Z`/UTC suffix. A `timestamp` string without a `Z` or numeric offset is skipped with a notice. See [Staleness](staleness.md). |
| `citations-resolve` | warning / notice | For docs with a repo root, flags a `` `path:N`/`path:N-M` `` citation (and its continuations and short forms) whose target file is missing, whose range is inverted or exceeds the file, or whose start line is blank or (for a non-markdown target) only a closing brace. `--require-anchors` opts into five additional checks. Only paths ending in `.ts`, `.js`, `.mjs`, `.md`, `.yml`, `.yaml` or `.json` are recognised. See [Citation resolution](citations.md). |
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

## repo-root auto-detection

**Behavior:** when `--repo-root` is omitted, okf-kit runs `git rev-parse --show-toplevel` from the bundle directory and uses the result if it succeeds. A bundle that lives inside a git work tree gets `sources-shape` existence checks, `sources-fresh`/`sources-fresh-future` staleness checks and `citations-resolve` (and, when enabled, `prose-line-references`) citation checks by default, not just when `--repo-root` is passed explicitly.

If the bundle is not inside a git work tree (or `git` is unavailable), repo-root stays unset: `sources-shape` skips existence checks, and `sources-fresh` emits a single notice (`staleness skipped: not inside a git work tree`) rather than silently reporting nothing, so a "clean" run is never a fake pass; `citations-resolve` and, when enabled, `prose-line-references` each emit their own single notice the same way.

With an explicit `--repo-root` but no usable `git`, the existence and citation checks still run, and `sources-fresh` reports an `untracked by git, staleness unknown` notice for each source instead of a verdict.

Pass `--repo-root` explicitly to pin a specific root (useful in CI when the bundle and the code it documents live in different checkouts) or to opt out of the ambient repo (point it at the bundle directory itself to disable these checks' access to the rest of the repo).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No errors (and, under `--strict`, no warnings either). |
| 1 | At least one error (or, under `--strict`, at least one warning). |
| 2 | Invocation or tool error: the bundle directory does not exist or is not a directory; an invalid option value (`--future-skew-minutes` that is not a non-negative number, a malformed `--companion`, see above); `init`'s target is non-empty without `--force`, or exists and is not a directory; a `docs-for` usage error (see [Reverse lookup](docs-for.md)); a commander usage error (unknown option, missing argument, missing/unknown command); or any other error that stops the run, such as an unreadable bundle file. `--help` and `--version` still exit 0. |

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
