# Verification sets

See the [package README](../README.md) for how this file fits into an
implementer or reviewer briefing.

A repository may check in `.ai/workflow/verify.json` to name the complete
verification set for an implementer or reviewer briefing. This generic worked
example uses a `preflight run <repo> --json` executor and ordered extras with
`cwd`, `argv`, and an explicit before/after-preflight phase, so an approved
build can precede a dependent test:

```json
{
  "format": "orchestrator-workflow-verification-set/v1",
  "preflight": {
    "kind": "preflight",
    "name": "preflight",
    "cwd": ".",
    "argv": ["preflight", "run", ".", "--json"]
  },
  "extras": [
    {
      "kind": "command",
      "name": "build",
      "phase": "before_preflight",
      "cwd": "packages/example",
      "argv": ["npm", "run", "build"]
    },
    {
      "kind": "command",
      "name": "package-tests",
      "phase": "after_preflight",
      "cwd": "packages/example",
      "argv": ["npm", "test"]
    },
    {
      "kind": "bundlecheck",
      "name": "knowledge-bundle",
      "phase": "after_preflight",
      "cwd": "packages/example",
      "argv": ["npx", "okf-kit", "check", "docs/okf"]
    }
  ]
}
```

The workflow does not execute or validate this file: the orchestrator first
approves the resolved effective config and scripts, then records a run-local
snapshot with the set digest, repository identity, executable identity, and
every result. Preflight JSON reports check results, not the underlying shell
commands it discovered. A repository with a configured knowledge bundle
(`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`) includes
its bundle check in every set, even when the task did not edit documentation.
