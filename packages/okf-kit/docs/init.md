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
```

`init` writes `index.md`, `log.md`, and one template doc per concept type: `overview-template.md`, `module-template.md`, `invariant-template.md`, `runbook-template.md`, plus `benchmark-template.md` for measuring whether the bundle helps. `index.md` and `log.md` carry no frontmatter (`reserved-files-bare`); every template doc carries full frontmatter (`type`, `title`, `description`, `tags`, `timestamp`, and, except for the benchmark template, `sources`) plus inline HTML-comment guidance on writing dense, source-verified, pointer-carrying docs instead of filler. All generated links are same-directory relative (`name.md`), never a leading-slash form.

## Placeholder sources are intentional

Every template doc except `benchmark-template.md` ships with `sources: [path/to/covered/source]`, a placeholder, not a real path. Running `okf-kit check` against the freshly scaffolded bundle (with a repo root available, explicit or auto-detected) will report that placeholder as a `sources-shape` "does not exist" error on every template doc. That is intentional: it is the tool telling you which docs still need a real source path, not a bug in the scaffold. The `init` completion message repeats this so it isn't missed. Replace each placeholder with the real repo-root-relative path(s) the doc describes as you write it, and the error clears doc by doc.

## Authoring guidance

- **`timestamp` means "last verified against sources," not "created on."** Bump it, and add a line to `log.md`, every time you re-verify a doc against its sources. Always use the real instant of verification (`new Date().toISOString()` or equivalent); never hand-write an artificial midnight datetime, or a local wall-clock time with a `Z` suffix it doesn't actually have -- `sources-fresh` and `sources-fresh-future` staleness comparisons both depend on it being real. See [Staleness: Future-dated timestamps](staleness.md#future-dated-timestamps-sources-fresh-future) for the measure-after-commit discipline this enforces.
- **Never list the bundle's own directory in `sources`.** A bundle directory changes on every doc edit inside it, so a self-referential `sources` entry goes permanently stale. This happened to the OKF pilot's own `BENCHMARK.md` (`agent-tasks` `docs/okf/BENCHMARK.md`, `sources: [docs/okf/]`); `benchmark-template.md` here omits `sources` entirely for the same reason, since a benchmark record measures the bundle rather than describing a piece of the codebase.
- **Keep all links same-directory relative.** Use `name.md`, not `/name.md`; see `no-absolute-links` in the [check catalog](check-catalog.md) for why a leading slash breaks once the bundle is viewed outside its own repository.
- **Write a sibling short-form citation as a connective-led `:N-M`, not `(N-M)`.** When a paragraph cites several sub-ranges of a source already named by a full `path:N-M` citation earlier in the same paragraph, write each later one as a `:N-M` led by one of the serial connectives the gate accepts -- `,`, `;`, `(`, or a trailing `and`/`or` -- right after the phrase it points at (e.g. `review finding L1 (:1170-1227, ...)`). `citations-resolve` only recognises the colon form; a parenthesized `(N-M)` is never checked, so it can drift silently. This convention is not demonstrated by any scaffolded template; it is a `citations-resolve` authoring rule. See [Citation resolution](citations.md).
