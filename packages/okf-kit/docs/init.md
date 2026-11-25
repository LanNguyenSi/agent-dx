# Scaffold a bundle (`init`)

`okf-kit init` creates a new bundle directory with an `index.md`, a `log.md`, and one template per doc type.

```bash
# scaffold docs/okf (the default target, relative to the current directory)
okf-kit init

# scaffold a specific directory instead
okf-kit init path/to/bundle

# an existing, non-empty target directory is refused (exit 2) unless forced;
# --force overwrites only the files init owns, nothing else in the directory
okf-kit init path/to/bundle --force

# scaffold for OKF spec v0.2 instead of the default v0.1
okf-kit init path/to/bundle --spec v0.2
```

`--spec v0.1|v0.2` picks the OKF spec version to scaffold for (default `v0.1`, identical to every release before the flag existed except for the `index.md` and `log.md` bodies described below). A `v0.2` scaffold differs in exactly two ways: the bundle-root `index.md` declares the version (`okf_version: "0.2"`, the one frontmatter block `reserved-files-bare` accepts under v0.2), and every template doc carries `generated: { by: human:<id>, at: <now> }` where the v0.1 scaffold carries `timestamp: <now>` (v0.2's replacement for `timestamp`; see [Staleness](staleness.md#the-effective-stamp-generatedat-okf-v02)). Replace the `human:<id>` placeholder with your own id. Any other `--spec` value is a usage error (exit 2). `check` detects the version from the scaffolded `index.md` on its own; pass `check --spec` only to override the detection (see the [check catalog](check-catalog.md#spec-version---spec)).

`init` writes `index.md`, `log.md`, and one template doc per concept type: `overview-template.md`, `module-template.md`, `invariant-template.md`, `runbook-template.md`, `incident-template.md` for post-defect analyses whose lessons feed runbooks, plus `benchmark-template.md` for measuring whether the bundle helps. `index.md` and `log.md` carry no frontmatter (`reserved-files-bare`); the scaffolded `log.md` opens its first entry under a `## YYYY-MM-DD` heading (the UTC date of the scaffold time) and the scaffolded `index.md` intro is an HTML comment, so a freshly scaffolded bundle passes `reserved-files-structure`; every template doc carries full frontmatter (`type`, `title`, `description`, `tags` and `timestamp`; `sources` on the overview, module and invariant templates, `applies_to` on the runbook template, and neither on the benchmark and incident templates; the incident template also carries `area`, `root_cause`, `escape_reason`, `applies_when`, `lessons` and `related`) plus inline HTML-comment guidance on writing dense, source-verified, pointer-carrying docs instead of filler. All generated links are same-directory relative (`name.md`), never a leading-slash form.

## Symbolic links are never followed

`init` never creates, truncates or writes a file through a symbolic link, because a repository can ship one (git preserves symlinks) that points outside it. Everything is checked before the first write, so a refusal exits `2`, names the link and what it points to, and leaves no partial scaffold.

- **What is refused.** The target directory, any directory between the walk root and the target, and each of the eight scaffold files, when it is a link (a dangling link included, so nothing is created at its destination). An existing scaffold file that is a directory, FIFO or socket is refused as well, with or without `--force`; `--force` only overwrites regular files.
- **The walk root.** When the resolved target lies under the current working directory, every component from the working directory down to the target, the target included, is checked: `docs` being a link makes `okf-kit init docs/okf` fail. The match is by directory identity, so an absolute path or an alias to the working directory counts the same, and `..` components are resolved before the walk. When the target lies outside the working directory, the walk covers the target directory and everything below it; links above the target that you placed yourself are accepted. The root itself is never examined.
- **Writes.** Missing directories are created one level at a time after the walk. Files are opened with `O_NOFOLLOW`, plus `O_EXCL` without `--force` and `O_TRUNC` with it, so a link planted between the check and the write fails the open instead of being followed. A link planted in a parent directory in that window is not covered: Node has no `openat`.
- **Fix.** Replace the link with a regular file or directory, or remove it, and run `init` again.

## Placeholder sources are intentional

Every template doc except `benchmark-template.md` and `incident-template.md` ships with `sources: [path/to/covered/source]` (the runbook template ships `applies_to: [path/to/covered/source]` instead: `applies_to` is the lookup-only field `docs-for` matches and `sources-fresh` ignores, so the runbook is found for a broad directory without going stale on each edit there; switch it to `sources` when the runbook cites concrete lines that must stay true), a placeholder, not a real path. Running `okf-kit check` against the freshly scaffolded bundle (with a repo root available, explicit or auto-detected) will report that placeholder as a `sources-shape` "does not exist" error (naming the field) on every template doc. That is intentional: it is the tool telling you which docs still need a real source path, not a bug in the scaffold. The `init` completion message repeats this so it isn't missed. Replace each placeholder with the real repo-root-relative path(s) the doc describes as you write it, and the error clears doc by doc.

## Authoring guidance

- **`timestamp` means "last verified against sources," not "created on."** Bump it, and add a line to `log.md`, every time you re-verify a doc against its sources. Always use the real instant of verification (`new Date().toISOString()` or equivalent); never hand-write an artificial midnight datetime, or a local wall-clock time with a `Z` suffix it doesn't actually have -- `sources-fresh` and `sources-fresh-future` staleness comparisons both depend on it being real. See [Staleness: Future-dated timestamps](staleness.md#future-dated-timestamps-sources-fresh-future) for the measure-after-commit discipline this enforces.
- **Never list the bundle's own directory in `sources`.** A bundle directory changes on every doc edit inside it, so a self-referential `sources` entry goes permanently stale. This happened to the OKF pilot's own `BENCHMARK.md` (`agent-tasks` `docs/okf/BENCHMARK.md`, `sources: [docs/okf/]`); `benchmark-template.md` here omits `sources` entirely for the same reason, since a benchmark record measures the bundle rather than describing a piece of the codebase.
- **Keep all links same-directory relative.** Use `name.md`, not `/name.md`; see `no-absolute-links` in the [check catalog](check-catalog.md) for why a leading slash breaks once the bundle is viewed outside its own repository.
- **Write a sibling short-form citation as a connective-led `:N-M`, not `(N-M)`.** When a paragraph cites several sub-ranges of a source already named by a full `path:N-M` citation earlier in the same paragraph, write each later one as a `:N-M` led by one of the serial connectives the gate accepts -- `,`, `;`, `(`, or a trailing `and`/`or` -- right after the phrase it points at (e.g. `review finding L1 (:1170-1227, ...)`). `citations-resolve` only recognises the colon form; a parenthesized `(N-M)` is never checked, so it can drift silently. This convention is not demonstrated by any scaffolded template; it is a `citations-resolve` authoring rule. See [Citation resolution](citations.md).
