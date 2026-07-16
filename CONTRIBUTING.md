# Contributing to agent-dx

Thanks for your interest. This is a TypeScript monorepo of small, independent tools.

## Issues

- Bug reports: include repro steps, expected vs. actual, Node version, package name (`packages/<tool>`).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/slop-detector-rule-x`, `fix/okf-kit-bug`).
2. Keep changes scoped to one package where possible. Cross-package refactors should be split.
3. Run whatever checks the changed package defines (commonly `npm run build`, `npm test`, plus `npm run format:check` / `npm run typecheck` where present). CI uses `--if-present` so missing scripts are not a blocker.
4. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

The monorepo is mixed:

- **npm packages** (`slop-detector`, `github-api-tool`, `git-batch-cli`, `agent-dev-kit`, `friction-log`, `orchestrator-workflow`, `okf-kit`):

  ```bash
  git clone https://github.com/LanNguyenSi/agent-dx
  cd agent-dx/packages/<tool>
  npm install
  npm run build
  npm test
  ```

- **Doc-only packages** (`agentic-coding-playbook`, `agent-engineering-playbook`): no install step, just edit Markdown.

Each package is self-contained, no root install.

## Releases and npm credentials

All npm writes (publish, deprecate) run in CI via the `NPM_TOKEN` repository
secret (see `.github/workflows/publish-npm.yml` and `npm-deprecate.yml`).
There is no working local npm token; do not debug a local `E401`/`E404`,
trigger the workflow instead.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
