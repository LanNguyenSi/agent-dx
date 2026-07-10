# okf-kit

`okf-kit` validates knowledge bundles against the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), a shape for markdown-plus-frontmatter knowledge bundles meant to be readable by both humans and agents. The check catalog here was shaped by the Phase-0 OKF pilot in agent-tasks ([PR #385](https://github.com/LanNguyenSi/agent-tasks/pull/385)), where a few structural mistakes (bad links, absolute paths) turned out to be easy to make and easy to catch mechanically.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Install

```bash
# one-off, no install
npx okf-kit check path/to/bundle

# or install it
npm install -g okf-kit
```

Requires Node >= 20.

## Quick start

```bash
okf-kit check path/to/bundle

# explicit repo root, used for both sources-shape existence checks and
# sources-fresh staleness checks (see "repo-root auto-detection" below for
# what happens when you omit this)
okf-kit check path/to/bundle --repo-root /path/to/repo

# JSON output for tooling
okf-kit check path/to/bundle --json

# fail on warnings too, not just errors (STALE findings are warnings)
okf-kit check path/to/bundle --strict
```

## Scaffold a bundle (`init`)

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

### Placeholder sources are intentional

Every template doc except `benchmark-template.md` ships with `sources: [path/to/covered/source]`, a placeholder, not a real path. Running `okf-kit check` against the freshly scaffolded bundle (with a repo root available, explicit or auto-detected) will report that placeholder as a `sources-shape` "does not exist" error on every template doc. That is intentional: it is the tool telling you which docs still need a real source path, not a bug in the scaffold. The `init` completion message repeats this so it isn't missed. Replace each placeholder with the real repo-root-relative path(s) the doc describes as you write it, and the error clears doc by doc.

### Authoring guidance baked into the templates

- **`timestamp` means "last verified against sources," not "created on."** Bump it, and add a line to `log.md`, every time you re-verify a doc against its sources. Always use the real instant of verification (`new Date().toISOString()` or equivalent); never hand-write an artificial midnight datetime, `sources-fresh` staleness comparisons depend on it being real.
- **Never list the bundle's own directory in `sources`.** A bundle directory changes on every doc edit inside it, so a self-referential `sources` entry goes permanently stale. This happened to the OKF pilot's own `BENCHMARK.md` (`agent-tasks` `docs/okf/BENCHMARK.md`, `sources: [docs/okf/]`); `benchmark-template.md` here omits `sources` entirely for the same reason, since a benchmark record measures the bundle rather than describing a piece of the codebase.
- **Keep all links same-directory relative.** Use `name.md`, not `/name.md`; see `no-absolute-links` above for why a leading slash breaks once the bundle is viewed outside its own repository.

## Check catalog

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. A relative target that climbs out of the bundle directory (`../outside.md`) and still resolves on disk is accepted; the rule checks resolution, not containment. |
| `no-absolute-links` | warning | Link targets should not start with `/`. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources`, when present, must be a non-empty array of non-empty strings. With a repo root (explicit or auto-detected), each listed path (file or directory) must also exist under it. |
| `sources-fresh` | warning / notice | For docs with a `sources` list and a repo root, flags a source path whose last git commit is newer than the doc's `timestamp`. See "Staleness (sources-fresh)" below. |

## repo-root auto-detection

**Behavior change:** when `--repo-root` is omitted, okf-kit runs `git rev-parse --show-toplevel` from the bundle directory and uses the result if it succeeds. A bundle that lives inside a git work tree therefore gets `sources-shape` existence checks and `sources-fresh` staleness checks by default now, not just when you pass `--repo-root` explicitly.

If the bundle is not inside a git work tree (or `git` is unavailable), repo-root stays unset: `sources-shape` skips existence checks exactly as before, and `sources-fresh` emits a single notice (`staleness skipped: not inside a git work tree`) rather than silently reporting nothing, so a "clean" run is never a fake pass.

Pass `--repo-root` explicitly to pin a specific root (useful in CI when the bundle and the code it documents live in different checkouts) or to opt out of the ambient repo (point it at the bundle directory itself to disable both checks' access to the rest of the repo).

## Staleness (sources-fresh)

`sources-fresh` compares each frontmatter `sources` entry's last git commit time against the doc's `timestamp`. It never blocks a doc that has no `sources`, and it never invents an error where git can't give a real answer:

| Situation | Severity | Message |
|-----------|----------|---------|
| A source path's last commit is newer than the doc's `timestamp` | warning | `STALE: <path> changed <iso> after doc timestamp <iso>` |
| A source path exists but has no git history (untracked) | notice | `untracked by git, staleness unknown: <path>` |
| The doc's `timestamp` is missing or not a parseable date, while `sources` is present | notice | `staleness not assessable: no valid timestamp` |
| No repo root available (see auto-detection above) | notice | `staleness skipped: not inside a git work tree` |
| A source path does not exist on disk | (nothing) | left to `sources-shape`, not duplicated here |

STALE findings are warnings, so they are advisory by default; run with `--strict` to fail the build on them.

Known limitation: a `git log` call that fails for a reason other than "no history for this path" (for example a corrupt object or a transient git error) is reported the same way as a genuinely untracked path, the `untracked by git, staleness unknown` notice; okf-kit does not currently distinguish a real git failure from "no commits touch this path".

**Authoring guidance:** when you re-verify a doc against its sources, bump its frontmatter `timestamp` (and add a line to the bundle's `log.md`) so `sources-fresh` reflects that the doc is current again.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No errors (and, under `--strict`, no warnings either). |
| 1 | At least one error (or, under `--strict`, at least one warning). |
| 2 | CLI invocation error: bundle directory does not exist, `init`'s target directory is non-empty without `--force`, or a commander usage error (unknown option, missing argument, missing/unknown command). `--help` and `--version` still exit 0. |

## CI usage

This is advisory: don't fail the build on warnings unless you pass `--strict`. Use a normal (non-shallow) checkout of the repo that owns the bundle: repo-root detection runs `git rev-parse --show-toplevel` from the `path/to/bundle` argument itself, not from the shell's working directory, and `sources-fresh` reads `git log`, so a shallow clone reports paths as untracked.

```yaml
- name: OKF bundle check
  run: npx okf-kit@0.3.1 check path/to/bundle
```

Pin the version: an unpinned `npx okf-kit` picks up new rules on their release day, which turns an unrelated PR red.

## Where this fits

okf-kit is the producer-side check: it validates a bundle you are authoring or maintaining. Consuming an OKF bundle at query time (loading, indexing, ranking passages for an agent) lives in [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle), a separate tool.

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
