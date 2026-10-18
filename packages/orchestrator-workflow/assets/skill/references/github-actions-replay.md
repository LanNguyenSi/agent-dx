## GitHub Actions replay rules

These rules apply only to a briefing that carries them; the orchestrator copies
this reference into the briefing for a diff that touches workflow or action
files and leaves it out of every other briefing. They cover any diff that adds
or changes a GitHub Actions `run:` step: replay the step locally under the shell
it actually runs.

- Shell: use `bash --noprofile --norc -eo pipefail` when `shell: bash` is set
  on the step or via `defaults.run.shell`, and `bash -e` otherwise on Linux and
  macOS runners (Actions' default for `run:` with no `shell:` key; Windows
  runners default to pwsh).
- Inputs: replay with the expected-success and the expected-failure inputs.
- Job: for a job, replay its steps in their committed order.
- Expected failure: a step that expects a non-zero command captures the status
  inside an `if` or a `set +e`/`set -e` guard.
- Expressions: substitute `${{ }}` expressions with representative values
  before replaying, and never paste untrusted event data into your shell.

Implementer: replay the step yourself, with these rules, before treating it as
tested.

Reviewer: replay the step yourself, independent of the implementer's claim, and
confirm that a step which expects a non-zero command captures the status inside
an `if` or a `set +e`/`set -e` guard. Do the replay in a scratch copy of the
repository outside the reviewed working tree (a temporary clone or a copied
checkout in your scratchpad directory) so it never runs against, or writes into,
the tree you are reviewing; this keeps the replay compatible with the read-only
Bash rule in your prompt.
