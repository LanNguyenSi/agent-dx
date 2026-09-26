# CI usage

`okf-kit check` is advisory: don't fail the build on warnings unless you pass `--strict`. Use a normal (non-shallow) checkout of the repo that owns the bundle: repo-root detection runs `git rev-parse --show-toplevel` from the `path/to/bundle` argument itself, not from the shell's working directory, and `sources-fresh` reads `git log`. A shallow clone (`actions/checkout`'s default `fetch-depth: 1`, or any `git clone --depth`) does NOT report paths as untracked -- every path is still tracked at the boundary commit's own commit time. What it DOES cost: `sources-fresh`'s re-stamp check (see [Staleness](staleness.md)) can no longer tell a doc's real root commit from the grafted boundary commit history was cut off at, so a doc whose own last commit lands there gets a `staleness not assessable` notice instead of a real STALE/pass verdict. Pass `fetch-depth: 0` (a full checkout) to get a real verdict there too.

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- name: OKF bundle check
  run: npx okf-kit@0.16.0 check path/to/bundle
```

Pin the version: an unpinned `npx okf-kit` picks up new rules on their release day, which turns an unrelated PR red.

Releasing a new okf-kit version to npm must also bump the `npm install -g okf-kit@<version>` pins this repo's own `orchestrator-workflow` package carries in `.github/workflows/`, in the same release commit; see `CONTRIBUTING.md`'s "Releasing okf-kit" section for the order.
