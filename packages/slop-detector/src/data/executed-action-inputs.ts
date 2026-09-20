/**
 * Default list of `owner/repo` GitHub Actions whose `action.yml` executes
 * one of its own `with:` inputs as code (a script body, an expression
 * evaluated by the action's own runtime) rather than treating it as inert
 * data the action merely reads or forwards. Consumed by
 * `workflow-slop/run-expression`, BEFORE that rule's ordinary `with:`
 * exemption: a `${{ ... }}` expression inside a listed input is scanned
 * exactly like a `run:` shell scalar, while every other input of the same
 * step stays exempt. This is DATA, not a rule: extend it per-repo via
 * `workflow.executedActionInputs` in `slop.config.yml`, instead of a
 * package release.
 *
 * Matching is `owner/repo` only, case-insensitive, independent of the
 * step's ref (a moving major tag, a pinned sha, a branch): the input is
 * executed as code by every published version of the action, not just
 * one major line, so there is no `@vN` component to this list the way
 * `node20-actions.ts` has one.
 *
 * Verification method for every entry below (durable, not point-in-time):
 * read the action's own source (`action.yml` plus the entry script it
 * names) and confirm the input is passed into a code-execution path
 * (`eval`, `new Function`, a script-runtime `run()` call) rather than
 * used as a literal value (a file path, a label, a URL). Re-run the same
 * check before trusting an existing entry: an action's own maintainers
 * could in principle change how an input is consumed between one
 * verification and the next, though a published action's `with:`
 * contract is treated as stable in practice.
 */
export interface ExecutedActionInputEntry {
  /** Exact `owner/repo` match key (case-insensitive), no ref/version. */
  uses: string;
  /** The `with:` input name whose value that action executes as code. */
  input: string;
  /** One-line record of what was checked, not when. */
  source: string;
}

export const DEFAULT_EXECUTED_ACTION_INPUTS: ExecutedActionInputEntry[] = [
  {
    uses: "actions/github-script",
    input: "script",
    source:
      "action.yml's main entrypoint (dist/index.js) passes with.script to " +
      "new AsyncFunction(...) and invokes it, so its text runs as the " +
      "step's own JavaScript with full access to @actions/github and " +
      "@actions/core, not data the action merely reads",
  },
];
