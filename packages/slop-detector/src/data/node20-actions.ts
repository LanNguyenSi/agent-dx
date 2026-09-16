/**
 * Default list of `owner/repo@vN` GitHub Actions majors whose `action.yml`
 * declares `runs.using: node20` at that moving major tag, consumed by
 * `workflow-slop/node20-action-major`. This is DATA, not a rule: extend it
 * per-repo via `workflow.node20Majors` (add) and `workflow.node20MajorsIgnore`
 * (drop) in `slop.config.yml`, instead of a package release.
 *
 * Verification method for every entry below (durable, not point-in-time):
 * fetch the action's `action.yml` at the exact moving major tag and read
 * `runs.using`, for example
 * `curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<tag>/action.yml`
 * or `gh api repos/<owner>/<repo>/contents/action.yml?ref=<tag> -H 'Accept:
 * application/vnd.github.raw'`. Only an entry whose `runs.using` came back
 * `node20` at that tag is listed; a `runs.using: docker` (container action)
 * or `runs.using: composite` action is never Node-20 by itself and is left
 * out even if a workflow commonly pairs it with Node-20 actions. Re-run the
 * same check before trusting an existing entry: a moving major tag can be
 * re-pointed to a different runtime by its own maintainers between one
 * verification and the next.
 *
 * Checked and deliberately excluded (not Node-20, so not in the list):
 * `softprops/action-gh-release@v1` -- `runs.using: node16` at that tag
 * (its `@v2` major is `node20` and is listed below).
 */
export interface Node20ActionEntry {
  /** Exact `owner/repo@vN` match key, as written in a workflow's `uses:`. */
  uses: string;
  /** One-line record of what was checked, not when. */
  source: string;
}

export const DEFAULT_NODE20_ACTIONS: Node20ActionEntry[] = [
  {
    uses: "actions/checkout@v4",
    source: "action.yml runs.using: node20 at the v4 tag",
  },
  {
    uses: "actions/setup-node@v4",
    source: "action.yml runs.using: node20 at the v4 tag",
  },
  {
    uses: "softprops/action-gh-release@v2",
    source: "action.yml runs.using: node20 at the v2 tag",
  },
  {
    uses: "actions/github-script@v7",
    source: "action.yml runs.using: node20 at the v7 tag",
  },
  {
    uses: "docker/build-push-action@v5",
    source:
      "action.yml runs.using: node20 at the v5 tag (a JS action despite the docker/ org prefix, not a container action)",
  },
  {
    uses: "docker/build-push-action@v6",
    source:
      "action.yml runs.using: node20 at the v6 tag (a JS action despite the docker/ org prefix, not a container action)",
  },
  {
    uses: "docker/login-action@v3",
    source:
      "action.yml runs.using: node20 at the v3 tag (a JS action despite the docker/ org prefix, not a container action)",
  },
  {
    uses: "docker/metadata-action@v5",
    source:
      "action.yml runs.using: node20 at the v5 tag (a JS action despite the docker/ org prefix, not a container action)",
  },
  {
    uses: "docker/setup-buildx-action@v3",
    source:
      "action.yml runs.using: node20 at the v3 tag (a JS action despite the docker/ org prefix, not a container action)",
  },
  {
    uses: "astral-sh/setup-uv@v4",
    source: "action.yml runs.using: node20 at the v4 tag",
  },
  {
    uses: "astral-sh/setup-uv@v5",
    source: "action.yml runs.using: node20 at the v5 tag",
  },
  {
    uses: "astral-sh/setup-uv@v6",
    source: "action.yml runs.using: node20 at the v6 tag",
  },
  {
    uses: "actions/setup-python@v5",
    source: "action.yml runs.using: node20 at the v5 tag",
  },
  {
    uses: "codecov/codecov-action@v4",
    source: "action.yml runs.using: node20 at the v4 tag",
  },
];
