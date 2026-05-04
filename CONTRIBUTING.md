# Contributing to agent-dx

Thanks for your interest. This is a TypeScript monorepo of small, independent tools.

## Issues

- Bug reports: include repro steps, expected vs. actual, Node version, package name (`packages/<tool>`).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/slop-detector-rule-x`, `fix/release-prep-bug`).
2. Keep changes scoped to one package where possible. Cross-package refactors should be split.
3. Run the package's local checks (`npm run build`, `npm test`, `npm run lint`) inside the changed package.
4. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx/packages/<tool>
npm install
npm run build
npm test
```

Each package is self-contained, no root install.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
