# CI usage

`okf-kit check` is advisory: don't fail the build on warnings unless you pass `--strict`. Use a normal (non-shallow) checkout of the repo that owns the bundle: repo-root detection runs `git rev-parse --show-toplevel` from the `path/to/bundle` argument itself, not from the shell's working directory, and `sources-fresh` reads `git log`. A shallow clone (`actions/checkout`'s default `fetch-depth: 1`, or any `git clone --depth`) does NOT report paths as untracked -- every path is still tracked at the boundary commit's own commit time. What it DOES cost: `sources-fresh`'s re-stamp check (see [Staleness](staleness.md)) can no longer tell a doc's real root commit from the grafted boundary commit history was cut off at, so a doc whose own last commit lands there gets a `staleness not assessable` notice instead of a real STALE/pass verdict. Pass `fetch-depth: 0` (a full checkout) to get a real verdict there too.

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- name: OKF bundle check
  run: npx okf-kit@<version> check path/to/bundle  # the exact version, see the README's "Use in CI" example
```

Pin the version: an unpinned `npx okf-kit` picks up new rules on their release day, which turns an unrelated PR red.

The pin in `templates/okf-staleness.yml` (install line and header) is rewritten to the release version when each okf-kit release is cut, so the template in a given okf-kit version pins that version. Maintainers: the release-time bump of this repository's own pins is described in the repository's `CONTRIBUTING.md`, section "Releasing okf-kit".

## Warn-only staleness workflow template

`templates/okf-staleness.yml` (shipped in the npm package, so `node_modules/okf-kit/templates/okf-staleness.yml` in an install) is the canonical warn-only GitHub Actions workflow for a repo that carries a bundle: a full checkout, an exact `npm install -g okf-kit@<version>` pin, a check that the CLI prints a version, and `okf-kit check --json --require-anchors` whose exit code 0 or 1 is reported in the job summary and annotations while the job stays green, and any other exit code (a tool or usage error) fails the job red. Never mark it as a required check.

Copy it to `.github/workflows/okf-staleness.yml` and change only the two lines marked `REPO-SPECIFIC`: the `pull_request` `branches:` entry (the repo's default branch) and `BUNDLE_PATH` (the bundle directory). The header names the template as its source; a repo that must deviate (for example one that builds okf-kit from its own tree when the pin is not on npm yet) documents the deviation in a comment at the deviating spot. The pin in the template is a starting value: move it deliberately, record each move in the bundle's `log.md` with the old and the new version's measured verdict (`okf-kit check` counts), and re-sync every consuming repo's copy from the template at the new pin.
