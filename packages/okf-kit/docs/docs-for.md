# Reverse lookup (`docs-for`)

`okf-kit docs-for <bundleDir> <path>...` answers the opposite question from `check`: given one or more paths, which bundle docs claim them as `sources`? Useful for a slicer or CI step that needs to know which knowledge-bundle docs are affected by a set of changed files, without reimplementing frontmatter parsing.

```bash
# which docs claim src/foo.ts (or a directory it lives under) as a source?
okf-kit docs-for path/to/bundle src/foo.ts src/bar/

# JSON output for tooling
okf-kit docs-for path/to/bundle src/foo.ts --json

# explicit repo root, like `check` (auto-detected via `git rev-parse --show-toplevel` when omitted)
okf-kit docs-for path/to/bundle src/foo.ts --repo-root /path/to/repo
```

**Population and matching:** `docs-for` looks at the exact same docs `sources-shape`/`sources-fresh` do -- every doc whose frontmatter `sources` is a validly-shaped (non-empty array of non-empty strings) list; a doc with no `sources` key, or a malformed one, contributes no matches (that shape error is `check`'s job to report, not this command's). A given `<path>` argument matches a doc's `sources` entry when, after resolving both against `--repo-root` (exactly as `check`'s `sources-shape` resolves `sources` entries, see below):

- the two paths are identical, or
- the `sources` entry resolves to a path that is a DIRECTORY on disk, and the given path resolves to that directory itself or anything underneath it.

There is no glob support: a `sources` entry is a plain path everywhere else in this package (`sources-shape`'s existence check is a bare `fs.existsSync`, never glob expansion), so `docs-for` matches nothing wider than what `check` already validates against. A `sources` entry that does not exist on disk (already flagged by `sources-shape`) can only match by exact string equality, never by directory containment, since there is nothing to inspect there.

**Resolution:** every `sources` entry is resolved with `path.join(repoRoot, source)`, exactly as `check`'s `sources-shape` rule resolves it -- a leading slash in the frontmatter spelling (`/src/foo.ts`) is repo-relative, not filesystem-absolute, so `check` and `docs-for` always agree on what a given `sources` entry points at. A given `<path>` argument, relative or absolute, is resolved by ONE rule regardless of spelling: `path.resolve(repoRoot, path)` (a relative argument joins onto `repoRoot`; an absolute one is used as-is, exactly as `path.resolve` treats a second absolute argument). Either way, a leading `./` and a trailing slash are normalized away before comparing, on both the given path and the `sources` entry. A resolved given path that lies outside `--repo-root` -- an absolute path elsewhere on disk (including `--repo-root`'s own parent), or a relative `../` escape -- is a usage error (exit 2), never a silent empty result. `--repo-root` itself, given directly as a `<path>` argument, is accepted (not an error); it only matches a `sources` entry that itself resolves to `--repo-root` (`.` or `./`). The containment check compares path spellings, not real paths: an absolute `<path>` that reaches the repo through a different spelling (a symlinked checkout, or macOS `/tmp` versus `/private/tmp`) is rejected as outside. An auto-detected repo root is git's resolved `--show-toplevel`, so prefer relative `<path>` arguments, or use that same spelling.

**Output:** text output is one line per matching doc, bundle-relative path (the same convention `check`'s own findings use), followed by the `sources` entries of its that matched (`doc.md: src/foo.ts, src/bar/`); an empty result says so explicitly rather than printing nothing. `--json` gives `{ bundleDir, matches: [{ doc, sources: [...] }] }`, one entry per matching doc, sorted by `doc`, each entry's `sources` deduplicated and sorted; `bundleDir` is the ABSOLUTE, machine-bound path `docs-for` resolved the bundle directory argument to (not repo-relative), so a consumer that stores the JSON output should not expect it to be portable across machines or checkouts. **Exit codes:** 0 whether or not anything matched; 2 for a usage error (unknown/missing bundle directory, no `<path>` arguments given, no repo root determinable, or a given path outside `--repo-root`, relative or absolute).

**Symlinked directory sources:** a `sources` entry that is a symlink to a directory is followed (`fs.statSync`, not `fs.lstatSync`), so it is treated as a directory and containment is checked against ITS OWN spelling: a given path underneath the symlink's spelling matches, but the same file addressed through the real directory's path does not (and vice versa) -- the two spellings are never treated as equivalent. This mirrors how `sources-fresh`'s own `git log` pathspec lookup only ever sees the spelling actually committed in frontmatter.
