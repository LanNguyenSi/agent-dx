# Release Prep

CLI tool to automate release preparation:
- Generate changelogs from commits
- Suggest semver version bumps
- Create git tags
- Create GitHub releases

## Features

- Parse commits since the latest git tag
- Categorize commits by conventional commit type (`feat`, `fix`, `docs`, etc.)
- Detect breaking changes from `!` and `BREAKING CHANGE:`
- Generate changelogs as Markdown or JSON
- Suggest the next version from commit history
- Prepare an initial release when no previous tag exists
- Create annotated git tags
- Create GitHub releases with generated notes via `gh`

## Usage

```bash
# Build the CLI
npm run build

# Suggest the next version
node dist/cli.js version

# Print changelog as markdown
node dist/cli.js changelog

# Print changelog as JSON
node dist/cli.js changelog --format json

# Full release preparation
node dist/cli.js prep

# Dry-run without creating tag or GitHub release
node dist/cli.js prep --dry-run --no-tag --no-release

# Force a specific bump
node dist/cli.js prep --type minor

# Force an explicit version
node dist/cli.js prep --version 1.4.0
```

## Release Rules

- Latest git tag is used as the previous release boundary
- If no previous tag exists, `package.json` version is used for the initial release
- Breaking changes trigger a `major` bump
- `feat` commits trigger a `minor` bump
- Any other commit defaults to `patch`

## Requirements

- Git repository with readable commit history
- Conventional commits are recommended for better categorization
- GitHub CLI (`gh`) is required only for `prep` runs that create a GitHub release

## Development

```bash
npm install
npm run dev -- version
npm run build
npm test
```

## CI

This package is built and tested as part of the agent-dx monorepo CI matrix in [`.github/workflows/ci.yml`](https://github.com/LanNguyenSi/agent-dx/blob/master/.github/workflows/ci.yml). The matrix runs `npm run build`, `npm test`, and the formatter check.

---

Part of [`agent-dx`](https://github.com/LanNguyenSi/agent-dx). Pairs with [`devreview`](https://github.com/LanNguyenSi/repo-intelligence/tree/master/packages/devreview) (PR review scoring) for post-merge release automation.
