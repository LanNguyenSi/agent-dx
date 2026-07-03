# okf-kit

`okf-kit` validates knowledge bundles against the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), a shape for markdown-plus-frontmatter knowledge bundles meant to be readable by both humans and agents. The check catalog here was shaped by the Phase-0 OKF pilot in agent-tasks ([PR #385](https://github.com/LanNguyenSi/agent-tasks/pull/385)), where a few structural mistakes (bad links, absolute paths) turned out to be easy to make and easy to catch mechanically.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Install

okf-kit is not yet published to npm, so run it from a local build of this monorepo:

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx/packages/okf-kit
npm install
npm run build
```

## Quick start

```bash
node dist/cli.js check path/to/bundle

# verify frontmatter `sources` paths exist under a given repo checkout
node dist/cli.js check path/to/bundle --repo-root /path/to/repo

# JSON output for tooling
node dist/cli.js check path/to/bundle --json

# fail on warnings too, not just errors
node dist/cli.js check path/to/bundle --strict
```

## Check catalog

| Rule | Severity | What it enforces |
|------|----------|-------------------|
| `frontmatter-required` | error | Every non-reserved `.md` file has a frontmatter block that parses as YAML and carries a non-empty string `type`. |
| `reserved-files-bare` | error | Reserved files (`index.md`, `log.md`, at any depth) must not carry a frontmatter block. |
| `links-resolve` | error | Markdown links to other `.md` files in the bundle must resolve to a real file. Relative targets resolve against the containing file's directory; targets starting with `/` resolve against the bundle root. |
| `no-absolute-links` | warning | Link targets should not start with `/`. GitHub resolves a leading slash against the repository root, not the bundle root, so an absolute link 404s once the bundle is viewed outside its own repository. Use a same-directory relative link instead. |
| `sources-shape` | error | Frontmatter `sources`, when present, must be a non-empty array of non-empty strings. With `--repo-root`, each listed path (file or directory) must also exist under it. |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No errors (and, under `--strict`, no warnings either). |
| 1 | At least one error (or, under `--strict`, at least one warning). |
| 2 | CLI invocation error (bundle directory does not exist). |

## CI usage

okf-kit is not published, so a CI step checks out this repo and builds it before use. This is advisory: don't fail the build on warnings unless you pass `--strict`.

```yaml
- name: OKF bundle check
  run: |
    git clone https://github.com/LanNguyenSi/agent-dx /tmp/agent-dx
    (cd /tmp/agent-dx/packages/okf-kit && npm install && npm run build)
    node /tmp/agent-dx/packages/okf-kit/dist/cli.js check path/to/bundle
```

## Where this fits

okf-kit is the producer-side check: it validates a bundle you are authoring or maintaining. Consuming an OKF bundle at query time (loading, indexing, ranking passages for an agent) lives in [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle), a separate tool.

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
