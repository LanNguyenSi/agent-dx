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

- **npm packages** (`slop-detector`, `github-api-tool`, `git-batch-cli`, `agent-dev-kit`, `friction-log`, `orchestrator-workflow`, `okf-kit`, `mcp-token-audit`):

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

Publishing runs in CI via npm Trusted Publishing (OIDC, `id-token: write`;
see `.github/workflows/publish-npm.yml`) and needs no npm token. The other
npm writes (deprecate, dist-tag) still run via the `NPM_TOKEN` repository
secret (see `npm-deprecate.yml` and `npm-dist-tag.yml`), since OIDC only
covers `npm publish`. There is no working local npm token; do not debug a
local `E401`/`E404`, trigger the workflow instead.

### Releasing okf-kit

`orchestrator-workflow`'s `test/docs-consistency.test.ts` pins okf-kit's
version in three places against `packages/okf-kit/package.json`'s own
version: `.github/workflows/ci.yml` and
`.github/workflows/okf-staleness.yml` (both `npm install -g
okf-kit@<version>` lines), and `packages/okf-kit/README.md`'s own `npx
okf-kit@<version> check path/to/bundle` CI example. `publish-npm.yml` runs
each package's tests at the tag tree before publishing. Cutting an okf-kit
release without also bumping all three pins leaves that guard red on
master, and the same red suite then blocks the orchestrator-workflow tag
from publishing. Bump all three in the same release commit, in this order:

1. `npm version --no-git-tag-version <new-version>` in `packages/okf-kit`.
2. Move the `[Unreleased]` section of `packages/okf-kit/CHANGELOG.md` under
   the new version heading.
3. Update `packages/okf-kit/README.md`'s own `npx okf-kit@<version> check
   path/to/bundle` CI example to `<new-version>` by hand.
4. `node scripts/bump-okf-kit-pin.mjs` from the repo root (reads the new
   version from `packages/okf-kit/package.json` and rewrites the pin line
   in both workflow files; run it with an explicit version argument only
   to preview a bump ahead of step 1). It exits non-zero if either
   workflow file has no pin line to rewrite. This script covers only the
   two workflow pins, not the README example in step 3: the README pin is
   a prose example, not release-workflow config.
5. `npx vitest run test/docs-consistency.test.ts` in
   `packages/orchestrator-workflow` and confirm it is green with the new
   pins before opening the PR.
6. Open the PR, squash merge, then push an annotated tag
   `okf-kit/v<new-version>` to trigger `publish-npm.yml`.

Releasing orchestrator-workflow follows the same shape (`npm version`,
CHANGELOG cut, tag `orchestrator-workflow/v<new-version>`) but has no pin
of its own to bump.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
