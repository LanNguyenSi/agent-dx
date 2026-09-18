# Changelog

All notable changes to `slop-detector` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- The npm tarball now ships a `LICENSE` file matching the repo root LICENSE
  (MIT), asserted by the monorepo's `lint-package-licenses` CI job.
- `review-slop/finding-id` now also matches a severity-letter finding id:
  an uppercase `H`, `M`, `L`, or `C` (high, medium, low, critical)
  followed by exactly one digit and an optional lowercase letter, the
  same shape and hyphenated-year exclusion the `F` form already has. The
  `F` form stays ungated; the new severity-letter alternative only
  counts when the same sentence also carries a review-process word
  (`review`, `reviewer`, `finding`/`findings`,
  `fix`/`fixed`/`fixes`/`fixing`, or `round`/`rounds`) -- the same
  sentence-window mechanism `round-reference`'s own bare-token gate
  already uses -- since these four letters collide with plain
  vocabulary (heading levels, chip generations, cache layers, a hazmat
  class) far more often than a capital `F` does. Measured with
  `node dist/cli.js check . --pack review-slop` from the monorepo root:
  696 files scanned both times, 530 violations before this change, 811
  after (281 new `finding-id` hits, entirely from severity-letter ids
  now caught in pre-existing content such as
  `packages/orchestrator-workflow/docs/okf/log.md`'s own review-round
  entries; that pre-existing corpus is not scrubbed as part of this
  change).

### Added

- `workflow-slop` gains three rules closing the gap between a fleet
  sweep fixing something by hand and nothing then guarding against it
  recurring:
  - `workflow-slop/node20-action-major`: flags any `uses:` value
    (job-level or step-level, not inside a step's own `with:` input
    block) whose `owner/repo@major` is on a data-driven Node-20 GitHub
    Actions list, matched case-insensitively and tolerant of a trailing
    prerelease-ish ref suffix (`@v4-beta` still resolves to major `v4`).
    A prior fleet-wide sweep across the workspace's repos replaced every
    Node-20-runtime action major (`actions/checkout@v4`,
    `actions/setup-node@v4`, and others) with a newer major, but nothing
    stopped a later workflow edit from reintroducing one (a copy-pasted
    step from an old example, an unreviewed dependency bump). The list
    lives in `src/data/node20-actions.ts` (not hardcoded rule logic):
    each entry was verified by fetching that action's `action.yml` at
    the moving major tag and reading `runs.using`, confirming
    `actions/checkout@v4`, `actions/setup-node@v4`,
    `softprops/action-gh-release@v2`, `actions/github-script@v7`,
    `docker/build-push-action@v5`/`@v6`, `docker/login-action@v3`,
    `docker/metadata-action@v5`, `docker/setup-buildx-action@v3`,
    `astral-sh/setup-uv@v4`/`v5`/`v6`, `actions/setup-python@v5`,
    `codecov/codecov-action@v4`, `actions/upload-artifact@v4`,
    `actions/cache@v4`, `actions/download-artifact@v4`,
    `actions/setup-go@v5`, `actions/configure-pages@v5`,
    `actions/deploy-pages@v4`, `peter-evans/create-pull-request@v6`, and
    `pnpm/action-setup@v4` are all `node20` at those tags. Every entry was
    reached the same way: scan a corpus of real workflow files for live
    `uses:` majors, then fetch each candidate's own `action.yml` and read
    `runs.using`. `softprops/action-gh-release@v1` was checked and
    deliberately excluded: its `action.yml` reports `runs.using: node16`,
    not `node20`, at that tag (its `@v2` major is `node20` and is
    listed). The `docker/*`-owned actions above are JS actions
    (`runs.using: node20`, `main: dist/index.js`), not container actions,
    despite the `docker/` org prefix; a genuinely `runs.using: docker`
    action or a composite action is never Node-20 by itself and is
    intentionally never on this list. The list is extendable per repo via
    `workflow.node20Majors` (additive) and `workflow.node20MajorsIgnore`
    (subtractive, applied after `node20Majors`) in `slop.config.yml`, so
    a newly discovered or newly fixed major doesn't need a package
    release. A `uses:` pinned to a full commit sha is only checked when
    the same line also carries a trailing `# vN` comment; a bare sha pin
    is a documented limitation, not a finding.
  - `workflow-slop/audit-gate-missing`: reports an `audit.yml` in which
    no step's normalised shell statements invoke `npm audit` with a
    recognised `--audit-level` (`low`/`moderate`/`high`/`critical`;
    `moderate`/`low` are stronger gates than `high`/`critical` and also
    satisfy it). A gate command that exists only in a shell comment,
    only inside a here-doc body, or only in a `run:` scalar style this
    pack does not analyse as shell text (a folded `>` block, a
    multi-line or quoted scalar) is not a present gate. Scoped to files
    literally named `audit.yml`/`audit.yaml` under `.github/workflows/`,
    and to `npm audit` specifically: a `pnpm audit`, a non-npm audit
    command, or a reusable-workflow-call `audit.yml` with no `run:` step
    reports as missing rather than being silently skipped.
  - `workflow-slop/audit-gate-shape`: reports a gate step unless its
    normalised run block matches a recognised SHAPE or an exact template
    the consuming repo registered. This is an allowlist, not a
    blocklist of neutralisation patterns: an enumeration of the ways a
    gate can be defused leaks in the false-clean direction (the next
    bash construct nobody listed scans green), while an allowlist leaks
    into false positives, which are visible and fixable. For a
    `block`-severity security gate that is the only acceptable leak
    direction. The two recognised shapes are `R-bare` (exactly one
    statement, first in the block, an optional `timeout <arg>` prefix,
    any `npm audit` flags, and no operator, redirection or substitution)
    and `R-classify` (exactly one statement disabling `errexit`, the
    gate strictly inside the window, at most one `VAR=$?` capture after
    the gate, the gate optionally piped only into `tee` and only with
    `set -o pipefail` set earlier, exactly one `set -e` restore, then
    `if`/`then`/`else`/`elif`/`fi`/`echo`/`printf` statements plus
    `exit` statements that each exit either a non-zero literal or the
    captured status, including at least one of each, with no `exit 0`,
    no bare `exit`, no other `exit` operand and no reassignment of the
    captured variable; before the window only assignments,
    option-enabling `set -` statements, `mkdir`, `mktemp`, `cd`, `echo`,
    `printf`, and a `trap` whose own body does not call `exit`). Every spelling bash accepts for those `set`
    calls is parsed rather than pattern-matched, so `set +eu` and
    `set +o errexit` open the window and `set -eo pipefail` and
    `set -euo pipefail` restore it. A `continue-on-error` on the gate
    step or its enclosing job that cannot be proven `false` (a literal
    `true`, the string `"true"`, or an unresolved `${{ }}` expression)
    is reported too.
  - Both rules consume one normalised view of the run block instead of
    its raw text, and there is no second path: here-doc bodies dropped
    (the redirection statement itself kept), physical lines joined
    across backslash continuations, each logical line's trailing shell
    comment stripped by a quote-parity scan with escaped-double-quote
    handling, each line cut into statements at unquoted
    `;`/`&&`/`||`/`|` boundaries outside any command substitution, and
    each match honoured only where the shell would honour it (a command
    word such as `set +e` must start outside any quoted span, so
    `echo "set +e"` is data; an expansion such as `$?` also counts
    inside double quotes, so `STATUS="$?"` is a real capture).
  - The normaliser refuses to certify a block carrying a construct it
    does not model and reports the reason instead: a `run:` value that
    is not a literal block scalar (`|`) or a single-line plain scalar, a
    here-doc redirection (or one whose terminator cannot be located), a
    shell function definition, an `eval`, a backgrounding `&` (a
    `2>&1`/`&>log`/`>&2` redirection is not one), an unbalanced quote on
    a logical line, or a command substitution spanning a statement
    separator. A construct that slips past that list still has to match
    a recognised shape, and no shape permits a statement it does not
    name, so a miss there is a false positive rather than a false clean
    from an unnamed statement; which branch a named `exit` sits in is not
    evaluated (a documented limit).
  - New config knob `workflow.auditGateTemplates`, a list of
    `{ name, sha256 }` or `{ name, statements }` entries; an entry
    carrying neither or both is rejected at config-load time. A block
    whose normalised statements (each trimmed, prefixed with the `;`,
    `&&`, `||` or `|` boundary it followed, joined by newlines) hash
    to a registered digest is recognised, which is how a legitimate but
    unmodelled gate block (helper functions, a custom exit-code
    mapping) is accepted without rewriting it. A matched template is
    trusted as is: no shape analysis runs on it. The package ships no
    template of its own, since a canonical gate block is org content,
    not package content; `test/fixtures/fleet-audit-real-shape.yml` is
    the test fixture for the mechanism and the README shows how to
    register one. The operating cost is the flip side of the same
    property: a deliberate change to a registered block, including a
    harmless one, changes its digest and is reported until the operator
    updates the entry in that repo's `slop.config.yml`. Comments,
    indentation, blank lines and line-ending style are normalised away,
    so a pure reformat does not move the digest.
  - Documented limits, each with a fixture: the rules are bound to the
    file name (`audit.yml`/`audit.yaml`), so a gate living in another
    workflow file is outside both; `R-classify` requires that the
    captured status is handed to `exit` without proving that value is
    non-zero at runtime, and does not evaluate the branch conditions
    deciding which `exit` is reached; and a registered template is
    trusted as is, so the review that justified registering it is the
    only thing standing behind that block.

- New pack `workflow-slop` (off by default, opt in via `--pack
  workflow-slop` or `packs.workflow-slop: true`), rule
  `workflow-slop/run-expression`: flags any `${{ ... }}` expression
  interpolated directly into a `run:` scalar under
  `.github/workflows/*.yml`/`*.yaml`, unless the expression is one of a
  documented allowlist of non-attacker-controllable contexts. Anchored on
  a real incident: an agent-tasks release workflow interpolated
  `${{ steps.target.outputs.expected }}` (a tag-derived value) straight
  into a `run:` body; a tag such as `mcp-server-v0.0.0";id;"` passes
  `git check-ref-format`, GitHub substitutes the expression before bash
  parses it, and the job (holding `id-token: write` and publish rights)
  executed the payload, skipping the version gate (fixed in agent-tasks
  by routing through `env:`), but nothing in the fleet prevented the class
  from recurring in the next workflow edit.
  - **New pack, not a rule inside an existing one.** `placement-slop`'s
    domain is org-/machine-/time-bound evidence leaking into reusable
    Markdown instruction files (prose-kind); `code-slop`'s is
    source-level anti-patterns in TypeScript/JavaScript via its AST
    corpus. Neither fits a YAML-structural, security-severity check over
    `.github/workflows/*.yml`, and folding it into either would mean
    either pack's default-severity/config surface (`placement.*`,
    `corpus`) governing an unrelated concern. A new pack keeps its own
    `workflow.allowExpressions` config surface (mirroring
    `placement.allow`'s per-pack shape) and its own CI status check
    (`workflow-guard`, separate from `placement-guard`'s doc-hygiene
    lint), the same reasoning `placement-slop` itself was split out for.
  - **Detection is YAML-structure-aware**, not text/regex-shaped: the
    rule parses each candidate file with the `yaml` package (already a
    dependency) and walks the parsed tree for `Pair`s whose key is `run`
    and whose value is a scalar node, then scans that scalar's *raw
    source slice* (via the node's byte range) for `${{ ... }}`: this
    finds every `run:` style (plain, single- or double-quoted, and
    multi-line block scalars `|`/`>`) and never fires on a `${{ }}` in
    `name:`, `if:`, `with:`, or `env:`, since those are different keys
    entirely rather than a coincidentally-similar text pattern.
  - **Allowlist, verified against GitHub's own docs** (both fetched
    during this task, no local paraphrase assumed correct): the
    [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
    documents `github.workspace`, `github.action_path`, `github.run_id`,
    `github.run_number`, `github.run_attempt`, `github.sha`,
    `github.job`, `github.repository`, `github.repository_owner`,
    `github.actor`, `github.event_name`, `github.workflow`,
    `github.server_url`, `github.api_url`, `github.token`,
    `runner.temp`, `runner.os`, `runner.arch`, and `runner.tool_cache` as
    runtime-assigned metadata (ids, counts, usernames, paths), never
    attacker-supplied free text, so allowed. `secrets.<NAME>` (any name) is
    allowed structurally: the secret's value is never attacker-supplied.
    The [security hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
    walks through exactly this `run:`-injection shape using
    `github.event.pull_request.title` as its example of untrusted input
    and recommends the same `env:`-routing fix this rule's message
    points at; the contexts reference documents `github.head_ref` as
    "the `head_ref` or source branch of the pull request" (named by a
    forked contributor) and `github.ref`/`github.ref_name` as the
    triggering ref (attacker-controlled for a `push`-on-tag trigger,
    which is the exact incident shape above): all four
    (`github.ref`, `github.ref_name`, `github.head_ref`,
    `github.base_ref`), plus `github.event.*`, `steps.*.outputs.*`,
    `needs.*.outputs.*`, `inputs.*`, `env.*`, and `vars.*`, are NOT
    allowed, matching the task brief's list exactly.
  - **`matrix.*` deliberately excluded from the default allowlist**: it
    is only safe when every value the matrix can take is a literal
    written in the workflow, and a single `run:` scalar's text gives no
    way to confirm that (the matrix could be built from `steps.*.outputs`
    or an untrusted `include`/`exclude`). A repo that has verified its
    own matrix is literal-only can allowlist a specific field via the new
    `workflow.allowExpressions` config array (exact-match, additive).
  - **Found and fixed one refinement during fleet validation, not in the
    task brief**: `steps.<id>.outcome` and `steps.<id>.conclusion` are
    NOT step outputs (the contexts reference documents both as exactly
    one of `success`/`failure`/`cancelled`/`skipped`, assigned by the
    runner itself, never attacker-influenced), but the rule as first
    written flagged them anyway (`steps.` was entirely unallowlisted).
    Running the guard over this repo's own workflows surfaced two
    concrete instances (`npm-deprecate.yml`, `npm-dist-tag.yml`, both
    echoing `${{ steps.<id>.outcome }}` into a log line). Added a
    structural allowlist entry for `steps.<id>.(outcome|conclusion)`
    rather than routing those two lines through `env:` for no security
    benefit; `steps.<id>.outputs.*` stays unallowlisted and still fires.
  - **Fleet scan** (every git repo directly under the workspace root with
    `.github/workflows` on its resolved default branch, archived from
    `origin/<default>` without touching any repo's working tree): 39
    repos checked, 32 carry `.github/workflows`, 15 clean, 17 with
    findings totalling 54 occurrences. The dominant shape by far is a
    tag/version value computed into a step output and interpolated
    unrouted into `release.yml`'s `run:` (the same class as the
    motivating incident, just not yet exploited elsewhere); the remainder
    is unallowlisted `matrix.*`. Fixing those is explicitly out of scope
    for this change (each becomes its own task, or falls under the held
    fleet-wide guard-rollout task); see the run's fleet-scan table for
    the full per-repo breakdown. This repo's own `.github/workflows`
    scanned clean once the `steps.*.outcome`/`.conclusion` refinement
    above was in place.
  - Wired into this repo's own CI as a new `workflow-guard` job in
    `.github/workflows/ci.yml` (sibling to `placement-guard`, not folded
    into it): `node packages/slop-detector/dist/cli.js check . --pack
    workflow-slop --config slop.config.yml`. Wiring pattern for other
    repos documented in `README.md` ("workflow-slop by example").
  - **Follow-up review round, four fixes**:
    - New rule `workflow-slop/unparseable-workflow`: `yaml`'s parser
      does not throw on most syntax errors, it records them on
      `doc.errors` and still returns whatever partial tree it managed to
      build, which `run-expression` then walked without knowing it was
      incomplete. A workflow file broken partway through (an
      unterminated quoted scalar, an unbalanced flow collection) could
      silently drop everything after the break, including an unsafe
      `${{ ... }}` expression, and report clean. The new rule reports one
      `block`-severity finding whenever a scanned workflow file has a
      YAML syntax error, naming the file and the first parse error, so a
      broken file always produces at least one workflow-slop finding.
    - `run-expression` no longer treats a `run:` key nested under a
      step's `with:` block as a shell script: a custom action's own
      input can be named `run` (an arbitrary action parameter, not
      something GitHub executes), and the walk previously matched on the
      key name at any depth regardless of parent; the gate is now keyed
      on schema position (a `with:` pair's own containing mapping must
      also carry a `uses:` key), not on a mapping key literally spelled
      `with` anywhere, since the earlier name-only gate let a mapping
      merely named `with` (a job, for instance) silence every `run:` in
      its whole subtree.
    - `workflow.allowExpressions` entries are now validated at
      config-load time (the bare expression body only, not the
      `${{ ... }}` wrapper) and an entry that matched no scanned `${{ ...
      }}` expression is surfaced in `CheckSummary.warnings`, the same
      mechanism `placement.instructionGlobs` already uses for a
      zero-match pattern.
    - Corrected the fleet-scan totals above and the CHANGELOG entry that
      first shipped them: the agent-dx row was stale against the shipped
      `steps.<id>.outcome`/`.conclusion` allowlist entry, so the correct
      totals are 15 clean / 17 with findings / 54 occurrences, not the
      14/18/56 first reported.

- New pack `review-slop` (off by default, opt in via `--pack review-slop`
  or `packs.review-slop: true`): three rules, `review-slop/finding-id`
  and `review-slop/round-reference` (block), `review-slop/handoff-phrase`
  (warn), flag run-local review tokens (finding ids like `F1`/`F2a`,
  round references like `round 2`/`R3`/`review round 1 fixes`, and
  workspace-handoff phrases like `per the <workspace> handoffs`) leaking
  into Markdown files, TypeScript/JavaScript source comments, test titles,
  and a commit-message file (`check --stdin-path COMMIT_MSG`, or a path
  ending `COMMIT_EDITMSG`/`.commitmsg`).
  - Precision, since every one of these token shapes also occurs as
    ordinary prose: `finding-id` takes a capital `F` plus exactly one
    digit and an optional lowercase letter, so a two-digit `F16`/`F22` (a
    function-key range) and an `F1-2026`-shaped version or date never
    match. A digitless `review round` never matches at any severity: that
    is the workflow kit's own name for its own mechanism, not run-local
    evidence. `round N` and a bare `RN` token match only when the same
    sentence also carries a review-process word (`review`, `finding`,
    `fix`, or, for the bare token, `round` itself), so `round 2 of the DNS
    retry`, a Cloudflare `R2` bucket and `DeepSeek-R1` are left alone.
    "The same sentence" is bounded by a `.`, `!` or `?`, a blank line, a
    Markdown heading line, or the start of a list item, so a
    `## Review rounds` heading and a preceding bullet do not lend their
    words to the bullet below, while one list item's own soft-wrapped
    continuation line is part of the same sentence.
  - A test title is the first string-literal argument of an
    `it`/`test`/`describe` call, including a chained
    `.only`/`.skip`/`.each`/`.concurrent`/`.for` (up to two deep, so
    `it.only.each` counts) and the two curried `.each` forms whose title
    sits in the outer call, `it.each(table)("title", fn)` and
    ``it.each`table`("title", fn)``.
  - Config surface: `review.allow` (regex allowlist; a matched span is
    excused on the Markdown surface, and a matching whole comment or whole
    test title on the two code surfaces) and `review.allowPaths` (glob
    allowlist matched against the scan-root-relative path, with a
    user-typed leading `./` normalized away as `placement.instructionGlobs`
    already does, default `["**/CHANGELOG.md"]`, since a repo's changelog
    convention narrating rounds and finding ids by design is a
    config-level allow rather than a violation).
  - Negative fixtures that stay clean: a tracker id (`e904f25a`),
    `round-trip`, a version number (`v1.2.3`), a bare plural `rounds`
    without a digit or `review` prefix, a hyphenated `round-2`
    cross-reference, and an `R1`/`F1` code-block label; fenced and inline
    code spans are stripped from Markdown before either block rule runs.
  - Anchored on pandora batch 51
    (`.ai/runs/2026-09-13-quickwins-batch51`): four review rounds (or
    post-merge cleanup commits) across five repos were spent on exactly
    this token class, caught only by grep, nothing mechanical. agent-dx
    PR #263 (commits `8d46ca09`, `494f1a32`) carried finding-id test
    titles (`F1:`, `F2a:`, `F2/F5 crossover:`) and round/handoff-phrase
    comments (`review round 2 finding F5`, `(F1, review R1)`, `per the
    pandora handoffs`) before a follow-up cleanup commit removed them by
    hand.
  - `packages/orchestrator-workflow`'s `assets/agents/implementer.md`
    gains a matching pre-return rule naming this pack's exact check
    command; see that package's own CHANGELOG.md.

- `check` takes one or more positional paths (`check fileA fileB`), each
  scanned and folded into one result, with a path named twice (or spelled
  two ways) scanned once instead of counted twice. `--pack` is a
  repeatable single-value option (`-p a -p b`, or one comma-separated
  `-p a,b`) rather than a variadic one, so `--pack review-slop fileA
  fileB` no longer swallows the two paths as pack names. Two invocations
  that used to pass silently are usage errors (exit `2`): a real path
  together with `--stdin-path`, which only ever names piped content and
  never opens a file; and reading stdin with nothing to read, where
  emptiness rather than TTY-ness is the predicate, so a TTY,
  `< /dev/null`, an empty pipe and a whitespace-only pipe all report
  instead of printing a clean report over an empty document (exit `0`,
  "0 violations"), which reads as "checked, found nothing" when nothing
  was checked. A stdin that is opened and then never written to and never
  closed, which is what a CI step or an agent harness spawning the CLI
  with stdio inherited hands it, no longer hangs forever: the read is
  bounded by a 10-second first-byte timeout, armed once before the first
  byte and cleared for good on the first chunk that arrives (a producer
  that writes some data and then stalls forever mid-stream is not bounded
  by it and hangs like an ordinary pipe again, since a producer that has
  proven it is alive is trusted to keep going), and reports the same
  usage error. `SLOP_DETECTOR_STDIN_TIMEOUT_MS` overrides that bound for
  a producer that legitimately takes longer to write its first byte.

- `stripFencedCode`, shared by `prose-slop`, `agent-tics` and
  `review-slop`, anchors both the opener and the closer of a backtick or
  tilde fence to the start of a line, with CommonMark's up-to-three
  spaces of leading indentation. Unanchored, a mid-sentence run of three
  backticks or tildes (prose about fences, a `~~~` used as a visual
  separator) opened a "fence" that ran to the next such run anywhere
  later in the file and blanked every word between them, hiding real
  findings from every rule that reads prose through this helper. On this
  repo's own tree the anchoring surfaced 56 previously masked warnings
  (54 `prose-slop/em-dash`, 2 `prose-slop/hedging-opener`), all of them
  in one Markdown file that discusses a stray triple-backtick run in
  prose; the block count and both CI pack scans are unchanged.

## [0.3.1] - 2026-08-26

### Changed

- `placement.instructionGlobs` in the agent-dx root `slop.config.yml` now
  also covers every package README (`packages/*/README.md`), closing a
  gap the `placement-guard` CI job (`check . --pack placement-slop
  --config slop.config.yml`) had against that location kind (agent-tasks
  80e4743d, itself filed from two independent mutation-probe findings in
  agent-tasks batch27: an implementer inserted a dated/tallied evidence
  line into `okf-kit/README.md` and a reviewer repeated the same probe
  across five locations, in both cases with the guard staying clean). The
  repo-root `README.md` is deliberately not covered: it is the monorepo
  overview, not a single package's own doc.
  - The wildcard immediately surfaced 50 pre-existing findings across 6
    files, by rule: `home-path` 30 (27 bare `~/`, 2 `/Users/you/`, 1
    `/home/node/`), `tally-phrase` 8, `org-marker` 8, `dated-evidence` 2,
    `opaque-id` 2. Every one was resolved, not deferred, by one of three
    mechanisms:
    - **`placement.allow` (28 findings):** a new narrow entry for the
      literal two characters `~/` and one for the literal string
      `/Users/you/`. A bare `~/` is portable by construction (unlike
      `/Users/<name>/` or `/home/<name>/`, it never bakes in a literal
      username), so it carries no machine-bound information to leak;
      package READMEs use it constantly as the generic "your home
      directory" idiom in install/usage examples
      (`mcp-token-audit/README.md`, `git-batch-cli/README.md`,
      `friction-log/README.md`). `/Users/you/` is the same idiom spelled
      as a literal placeholder word instead of an angle-bracket one
      (`friction-log/README.md`'s `sync_export` example). Both entries
      are deliberately narrow (exact literal matches, no wildcards), so
      `/Users/<realname>/` and `/home/<realname>/` still fire; verified
      by two mutation probes: inserting `/Users/lannguyensi/git/pandora`
      into a covered README still BLOCKs, and `placement.markers` gained
      a lowercase `"lannguyensi"` entry (marker matching has no implicit
      `i` flag, and this org's own machine-path convention, e.g.
      `-Users-lannguyensi-git-pandora`, writes the handle lowercase)
      after a probe showed `~/.claude/projects/-Users-lannguyensi-git-pandora/`
      and `~/../lannguyensi/...` passing silently through the `~/`
      allow; both now fire as `org-marker` after the new marker. A third
      probe line, `~/git/pandora` (no username at all), still passes:
      this is a known, accepted limitation of the `~/` allow, not a gap
      to close, since there is no username in it to catch.
    - **`slop-detector:disable-line` / `disable-next-line` (12
      findings):** `slop-detector/README.md`'s own "`placement-slop` by
      example" section deliberately contains evidence-shaped lines (a
      home path, a dated tally, an opaque id, a table row listing
      `n=8`/`p=0.016`/`so far` as sample tokens, and a prose mention of
      `/home/node/app`) to demonstrate what each rule catches; rewriting
      them would defeat their purpose as examples. The fenced sample
      lines themselves stay pristine (no inline comment on the evidence
      text); the marker comment immediately above each carries a
      `slop-detector:disable-next-line=placement-slop` instead. The
      table row and the prose paragraph (not inside the fenced sample)
      keep an inline `disable-line` comment. This mechanism is
      file/line-scoped, unlike a config-level `allow` regex, so it
      cannot mask a finding anywhere else.
    - **Content edits (10 findings):** real example values with nothing
      to preserve, replaced with generic placeholders:
      `github-api-tool/README.md` (5 `org-marker` occurrences, a real
      org handle in CLI examples, now `your-org`, and the repo-name
      example next to it now reads `repo-a repo-b` for the same reason);
      `friction-log/README.md` (2 `org-marker` occurrences, a `repo:`
      YAML example and a "zero `<org>`-stack assumptions" sentence, plus
      1 `opaque-id`, a `projectId:` YAML example, now generic
      placeholders); `slop-detector/README.md`'s own dogfood anecdote (1
      `org-marker`, a real org handle naming this org's PR sample, now
      genericized with the specific counts moved into this entry: the
      first real run found real violations, mostly em-dashes and
      auto-appended agent-harness footers, across a majority of the
      sampled PRs, zero false positives). One real measurement,
      `orchestrator-workflow/README.md`'s Haiku 4.5 `effort:`-drop
      paragraph (1 `dated-evidence`), was reworded to what that
      package's own CHANGELOG `0.23.0` entry actually documents (the
      harness ignores the pinned `effort:` value on Haiku 4.5 rather
      than rejecting it) and anchored there, instead of duplicating a
      new `[Unreleased]` entry, since inserting one above versioned
      sections shifts every citation into that CHANGELOG by line count
      and would have re-broken 16 already-fixed anchored citations in
      the OW OKF bundle. A separate, more specific wire-probe claim
      (the Claude Code CLI itself silently drops the `effort:`
      parameter for Haiku 4.5 rather than rejecting it, dated
      2026-08-19) is not what `0.23.0` records, so the README no longer
      makes that exact claim; the orchestrator has that sentence and its
      date for the run files, since it is not duplicated in this
      CHANGELOG either (same reason).
  - `placement-slop/README.md` also gained a short recommendation (rule
    only, no counts, no task ids) pointing a monorepo at
    `packages/*/README.md` as a `placement.instructionGlobs` value, and
    dropped the now-inaccurate "the same content in README.md never
    fires" line in favor of describing the built-in defaults plus how a
    repo can widen them.
  - Corpus re-measured clean after all of the above: `check .` at the
    repo root stays green, 390 files scanned, 0 violations. Confirmed by
    toggling each mechanism independently: with the two `~/`/`/Users/you/`
    allow entries removed (disable comments and edits left in place),
    exactly 28 findings reappear; with every disable comment stripped
    (allow entries and edits left in place), exactly 12 findings
    reappear in `slop-detector/README.md`; 28 + 12 + 10 = 50.
- `packages/slop-detector/package.json`'s `files` array now includes
  `CHANGELOG.md`, so it ships with the published package alongside
  `README.md`.
- OKF bundle docs (`packages/*/docs/okf/**`) are deliberately **not**
  covered by `placement.instructionGlobs` at all, for the whole bundle
  consistently. Measured: a `packages/*/docs/okf/*.md` wildcard on the
  orchestrator-workflow bundle surfaces 14 pre-existing violations across
  5 of its 6 module docs (`index.md`, `model-preselection.md`,
  `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
  `subagent-contracts-superset.md`) plus 72 in `log.md` alone. These docs
  carry verification stamps, tallies, and task ids by design: okf-kit's
  sources-fresh / re-verify convention re-stamps them with exactly this
  kind of dated evidence on every verification pass, and the bundle
  already has its own mechanical freshness guard (`okf-kit check` in
  CI). `log.md` is the bundle's own append-only log, the same reason
  `CHANGELOG.md` is never in `instructionGlobs`. Editing bundle document
  content to satisfy a second, unrelated guard would fight the tool that
  already owns that content's shape. This change did touch two of the
  bundle's own listed *sources* (`orchestrator-workflow/README.md` and,
  transiently, `orchestrator-workflow/CHANGELOG.md`), which is not the
  same thing as touching the bundle documents themselves: the five
  module docs that list either file as a `sources:` entry
  (`install-fence-mechanics.md`, `model-preselection.md`,
  `run-state-lifecycle-and-markers.md`, `review-gate-and-waivers.md`,
  `subagent-contracts-superset.md`) were re-verified against the new
  README wording (no citation range or anchor targets the edited
  paragraph; the edit kept the same line count so no other citation into
  that file shifted either) and re-stamped per the bundle's own
  `timestamp:` frontmatter convention. `okf-kit check --json
  packages/orchestrator-workflow/docs/okf --repo-root .` reports the
  same 13 `citations-resolve` warnings and 22 notices as origin/master,
  and 0 `sources-fresh` warnings after the re-stamp (6 before it).
- `CHANGELOG.md` files anywhere in the repo: unchanged, still never
  matched by any `instructionGlobs` entry (verified: this very entry,
  carrying a date, a tally, and an agent-tasks task id, stays green under
  `check .`). This is the pack's existing, intentional carve-out for
  evidence that is supposed to live somewhere, and this change does not
  touch it.
