# okf-kit

CLI that validates OKF v0.1 knowledge bundles for structural correctness, staleness, and citation drift.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Overview

`okf-kit` checks knowledge bundles against the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), a shape for markdown-plus-frontmatter knowledge bundles meant to be readable by both humans and agents. The check catalog was shaped by the Phase-0 OKF pilot in agent-tasks ([PR #385](https://github.com/LanNguyenSi/agent-tasks/pull/385)), where a few structural mistakes (bad links, absolute paths) turned out to be easy to make and easy to catch mechanically.

It validates frontmatter shape, link resolution, staleness against git history, and citation drift (a `path:N` citation whose line numbers shifted under it); `init` scaffolds a starter bundle and `docs-for` answers "which docs claim this source path".

`okf-kit` is the producer-side check: it validates a bundle you are authoring or maintaining. Consuming a bundle at query time (loading, indexing, ranking passages for an agent) lives in [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle), a separate tool.

## Key features

- 9 rules covering frontmatter shape, reserved files, link resolution, and staleness/citation drift assessed against git history; see the [check catalog](docs/check-catalog.md).
- `init` scaffolds a starter bundle: `index.md`, `log.md`, and one template doc per concept type.
- `docs-for` reverse lookup: given one or more changed paths, which bundle docs claim them as `sources`.
- A citation can carry an anchor (`#heading` or `#"text"`) so a `path:N-M` citation survives content moving above it; see [Citation resolution](docs/citations.md).
- `--dirty-as-now` makes a pre-commit `check` run report the same staleness verdict CI reports after the commit lands; see [Staleness](docs/staleness.md).
- `--require-anchors` and `--prose-line-references` opt into stricter checks for a bundle whose citations are already anchored.

## Install

```bash
# one-off, no install
npx okf-kit check path/to/bundle

# or install it
npm install -g okf-kit
```

Requires Node >= 20.

## Usage

```bash
okf-kit check path/to/bundle

# explicit repo root, used for both sources-shape existence checks and
# sources-fresh staleness checks (see docs/check-catalog.md's "repo-root
# auto-detection" for what happens when you omit this)
okf-kit check path/to/bundle --repo-root /path/to/repo

# JSON output for tooling
okf-kit check path/to/bundle --json

# fail on warnings too, not just errors (STALE and FUTURE-DATED findings are warnings)
okf-kit check path/to/bundle --strict
```

`check` exits `0` with no errors (and, under `--strict`, no warnings), `1` when it finds one, and `2` on a CLI invocation error; see [check catalog](docs/check-catalog.md#exit-codes) for the full table.

Other commands:

```bash
# scaffold docs/okf (the default target, relative to the current directory)
okf-kit init

# which docs claim src/foo.ts (or a directory it lives under) as a source?
okf-kit docs-for path/to/bundle src/foo.ts
```

See [Scaffold a bundle](docs/init.md) and [Reverse lookup](docs/docs-for.md) for the full command reference, including flags and output formats.

### Use in CI

Pin the exact version and use a full (non-shallow) checkout; [CI usage](docs/ci.md) explains why:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- name: OKF bundle check
  run: npx okf-kit@0.16.0 check path/to/bundle
```

## Documentation

- [Check catalog](docs/check-catalog.md): all 9 rules, repo-root auto-detection, exit codes.
- [Scaffold a bundle (`init`)](docs/init.md): generated files, placeholder sources, authoring guidance.
- [Reverse lookup (`docs-for`)](docs/docs-for.md): matching rules, path resolution, output formats.
- [Staleness (`sources-fresh`)](docs/staleness.md): the re-stamp rule, designator-less timestamps, squash-merge interaction, `--dirty-as-now`, `sources-fresh-future`.
- [Citation resolution (`citations-resolve`)](docs/citations.md): every finding id, anchor forms, continuation and short-form citations, `--require-anchors`.
- [Prose line references](docs/prose-line-references.md): the opt-in `--prose-line-references` check for line numbers written outside `citations-resolve`'s own grammar.
- [CI usage](docs/ci.md): shallow-clone caveats, the pinned-version rationale, and the release-time pin bump.

## Development

```bash
npm install
npm run build
npm test
```

See [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) for issue and PR conventions, and the release process (including `CONTRIBUTING.md`'s "Releasing okf-kit" section for bumping this repo's own `okf-kit@<version>` pins).

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
