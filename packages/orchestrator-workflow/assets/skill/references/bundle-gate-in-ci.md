## Bundle gate in CI

A knowledge bundle doc rots silently when someone changes one of its
documented sources outside a run: no hand-off step fires, and the doc keeps
describing the old code. Running the bundle check in CI on every change closes
that gap. This reference describes one way to wire it up. GitHub Actions is the
example host; the same steps work on any CI that can check out full history and
run a shell step. The kit ships no CI files and generates none; copy and adapt
the example.

The examples use `okf-kit` as the bundle checker, the validator the hand-off
step names. A different checker works the same way as long as it can report
findings per rule in a machine-readable form.

### Which bundles

Gate every configured bundle, not only the default one. Each entry of
`knowledge` in `.ai/workflow/manifest.json` names a bundle `path` and the
`repoRoot` its sources live in (default `.`); with no `knowledge` list the one
bundle is `docs/okf/` with `repoRoot` `.`. Run one check per bundle and pass
`--repo-root <repoRoot>` explicitly: without it the checker detects the
repository top level from the bundle directory, which is the wrong root for a
workspace bundle whose sources live in a sub-repo.

### Pin the checker

Install the checker at a pinned version, written here as the placeholder
`okf-kit@<pinned-version>`. An unpinned install picks up new rules on their
release day and turns an unrelated change red. Bump the pin deliberately, in a
change of its own, after the new version runs clean against the bundles. The
example carries the pin as an environment value (`OKF_KIT_VERSION`), so a copy
that still holds the placeholder fails the job instead of running something
else.

### Check out the full history

Check out the full history (`fetch-depth: 0` with `actions/checkout`): the
`sources-fresh` rule dates each source by its last commit and asks whether the
doc's own last commit re-stamped the doc, and a shallow clone cannot answer
that, so it reports `staleness not assessable` notices instead of a STALE
verdict. A shallow checkout therefore looks clean while it assessed nothing.

### Runner as an input

Take the runner as an input of the job (for example a reusable workflow input
`runner`) rather than hard-coding a runner label in the example. The label is a
property of the consuming organization, not of the gate.

### Staged rollout

Roll the gate out in three stages and move to the next one only once the
bundles run clean under the current stage:

1. Stage 1, warn-only: run the check on every change, publish every finding as
   an annotation and in the job summary, and never fail the job on a finding.
   This surfaces existing drift without blocking anyone.
2. Stage 2, block on structure and staleness: fail the job on any
   error-severity finding (structure: frontmatter, links, sources shape) and on
   any `sources-fresh` or `sources-fresh-future` warning, selected from the
   `--json` report with a filter; other warnings stay advisory.
3. Stage 3, strict: run the check with `--strict`, which fails on every
   warning from every rule.

The exit code alone is not the signal for stage 1 or stage 2: `okf-kit check`
exits 0 when it finds only warnings (STALE and FUTURE-DATED findings are
warnings) and 1 when it finds an error, so read the JSON report to decide.
Any other outcome means the checker could not run (exit 2 for a usage error
such as a missing bundle directory, a failed install, a missing command, or a
report that does not parse), and it fails the job at every stage, including
stage 1.

The stage 2 selection, as a `jq` filter over the `--json` report (any JSON
tool works; the report is `{ "findings": [{ "ruleId", "severity", "file",
"message" }], ... }`):

```sh
jq '[.findings[]
     | select(.severity == "error"
              or (.severity == "warning"
                  and (.ruleId == "sources-fresh"
                       or .ruleId == "sources-fresh-future")))]
    | length' "$report"
```

A result above 0 fails the job.

### Example: GitHub Actions

A reusable workflow with the runner and the stage as inputs and one matrix
entry per configured bundle:

```yaml
on:
  workflow_call:
    inputs:
      runner:
        type: string
        required: true
      stage:
        type: string # warn | block | strict
        required: true

jobs:
  bundle-gate:
    runs-on: ${{ inputs.runner }}
    strategy:
      fail-fast: false
      matrix:
        bundle:
          # one entry per `knowledge` entry in .ai/workflow/manifest.json
          - { path: docs/okf, repoRoot: . }
    steps:
      - uses: actions/checkout@<pinned-ref>
        with:
          fetch-depth: 0
      - name: Bundle check
        shell: bash
        env:
          OKF_KIT_VERSION: <pinned-version>
          BUNDLE: ${{ matrix.bundle.path }}
          REPO_ROOT: ${{ matrix.bundle.repoRoot }}
          STAGE: ${{ inputs.stage }}
        run: |
          report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/okf-report.json"
          strict=""
          if [ "$STAGE" = "strict" ]; then strict="--strict"; fi
          set +e
          npx -y "okf-kit@$OKF_KIT_VERSION" check "$BUNDLE" \
            --repo-root "$REPO_ROOT" --json $strict > "$report"
          status=$?
          set -e
          if [ "$status" -ne 0 ] && [ "$status" -ne 1 ]; then
            echo "bundle check could not run (exit $status)"; exit 2
          fi
          if ! jq -e '.findings | type == "array"' "$report" > /dev/null; then
            echo "bundle check could not run (no parseable report)"; exit 2
          fi
          jq -r --arg b "$BUNDLE" '.findings[]
            | "::\(.severity) file=\($b)/\(.file)::\(.ruleId): \(.message)"' \
            "$report"
          jq -r --arg b "$BUNDLE" '"### Bundle check: \($b)",
            (.findings[] | "- \(.severity) \(.ruleId) \(.file): \(.message)")' \
            "$report" >> "$GITHUB_STEP_SUMMARY"
          case "$STAGE" in
            warn) exit 0 ;;
            block)
              blocking=$(jq '[.findings[]
                | select(.severity == "error"
                         or (.severity == "warning"
                             and (.ruleId == "sources-fresh"
                                  or .ruleId == "sources-fresh-future")))]
                | length' "$report")
              if [ "$blocking" -gt 0 ]; then exit 1; fi ;;
            strict) exit "$status" ;;
            *) echo "unknown stage: $STAGE"; exit 2 ;;
          esac
```

The annotation command names match the checker's severities (`error`,
`warning`, `notice`), so each finding lands on its file in the change view.
The report goes to the runner's temporary directory, outside the checked-out
work tree.

### Pre-commit parity

Run `okf-kit check <bundle> --repo-root <repoRoot> --dirty-as-now` before
committing: it treats every uncommitted change as one virtual commit made now,
so the local run reports the same `sources-fresh` and `sources-fresh-future`
verdict CI will report once the commit lands. Without the flag a pre-commit
run judges an edited source by its last commit and can report clean while CI
reports STALE after the push. A hook loops over the same bundles as CI:

```sh
report="$(mktemp)"
okf-kit check docs/okf --repo-root . --dirty-as-now --json > "$report"
# apply the same stage decision as CI to "$report"
```

Write the report outside the work tree: under `--dirty-as-now` a report file
inside it is itself an uncommitted change and can mark a doc STALE whose
sources cover that directory.

Parity covers the verdict of those two rules, not the stage decision: apply
the same stage filter locally, and add `--strict` only when CI runs stage 3.

### What the gate proves

The gate proves that a doc was re-stamped after its sources changed, not that
its content is correct; review of the doc against its sources stays mandatory.
A re-stamp without re-verification passes the gate, and a doc-only prose edit
that leaves the sources untouched gives the staleness rules nothing to compare
against. The gate complements the hand-off check and the reviewer; it replaces
neither.
