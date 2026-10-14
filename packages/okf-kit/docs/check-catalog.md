# Check catalog

The full set of rules `okf-kit check` runs, plus repo-root auto-detection,
exit codes and the output format. See the main [README](../README.md) for
install and quick-start commands.

## Rules

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. Exception under OKF v0.2 (see [Spec version](#spec-version-spec)): the BUNDLE-ROOT `index.md` may carry a frontmatter block with exactly one key, `okf_version`; any other key next to it, the key on a non-root `index.md` or on `log.md`, and any frontmatter at all under v0.1 stay errors. |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. A relative target that climbs out of the bundle directory (`../outside.md`) and still resolves on disk is accepted; the rule checks resolution, not containment. |
| `no-absolute-links` | warning | Markdown links to `.md` targets should not start with `/`; links to other file types are not checked. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources` and `applies_to`, when present, must each be a non-empty array of non-empty strings. With a repo root (explicit or auto-detected), each listed path (file or directory) must also stay inside it (a `..` escape is an error naming the field; the check is lexical and does not resolve symlinks) and exist under it. `applies_to` is validated exactly like `sources` (same shape, same existence check, same resolution, same severity, no globs) but is lookup-only: `docs-for` matches it and `sources-fresh` never reads it, so a broad directory there never makes the doc stale. Use `applies_to` for a doc that is a procedure for work in some area (a runbook); use `sources` for a doc that describes code whose changes must trigger re-verification. A finding names the offending field. |
| `sources-fresh` | warning / notice | For docs with a `sources` list and a repo root, flags a source path whose last git commit is newer than both the doc's `timestamp` and the doc file's own last re-stamping commit. The doc's stamp is its EFFECTIVE stamp: the OKF v0.2 `generated.at` when present, else the v0.1 `timestamp` (same effective stamp on both sides of the re-stamp comparison, including the historical blobs it parses). See [Staleness](staleness.md). |
| `sources-fresh-future` | warning / notice | For the same docs as `sources-fresh`, flags the effective stamp (`generated.at` when present, else `timestamp`) later than the doc file's own last commit by more than a clock-skew allowance (default 10 minutes, `--future-skew-minutes`). Catches a local wall-clock time mistakenly written with a `Z`/UTC suffix. A designator-less `timestamp` is skipped with a notice; a designator-less v0.2 `generated.at` is skipped silently, because `generated-shape` reports it as an error. See [Staleness](staleness.md). |
| `generated-shape` | error / warning | Frontmatter `generated` (the OKF v0.2 replacement for `timestamp`): `generated.by` must match one of `<producer>/<version>` (e.g. `okf-kit/0.19.0`), `human:<id>`, `process:<id>` (warning); under spec v0.2 `generated.at` must carry an explicit UTC designator (`Z`) or numeric offset like `+02:00` (error); a `generated.at` and a `timestamp` on one doc naming DIFFERENT instants is reported once (warning, `generated.at` is the stamp the freshness rules read; both naming the SAME instant is a redundant mid-migration state and passes). |
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

## Spec version (`--spec`)

`check` resolves the OKF spec version to check against, exposes it to every rule as the bundle context's `specVersion`, and branches the version-sensitive rules (`reserved-files-bare`, `generated-shape`, the freshness stamp resolution) on it:

- **Detection:** the BUNDLE-ROOT `index.md` frontmatter may carry exactly one key, `okf_version` (OKF v0.2), e.g. `okf_version: "0.2"`. The YAML number form (`okf_version: 0.2`) is accepted too. No key, no frontmatter, an unparseable block, or a value that is neither `0.1` nor `0.2` resolves to `v0.1`. A non-root `index.md` never declares the version (`reserved-files-bare` flags such a block).
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
| 2 | Invocation or tool error: the bundle directory does not exist or is not a directory; an invalid option value (`--future-skew-minutes` that is not a non-negative number, a malformed `--companion`, an unknown or empty `--rule` id list, an invalid `--min-severity` level or an invalid `--spec` version, see above); `init`'s target is non-empty without `--force`, or exists and is not a directory; a `docs-for` usage error (see [Reverse lookup](docs-for.md)); a commander usage error (unknown option, missing argument, missing/unknown command); or any other error that stops the run, such as an unreadable bundle file. `--help` and `--version` still exit 0. |

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
