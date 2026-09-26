# workflow-slop rule pack

Opt in with `--pack workflow-slop`. Scans `.github/workflows/*.yml`/`*.yaml` for GitHub Actions injection and CI-guard regressions; see the [rule pack reference](rule-packs.md) for the full pack table.


Opt in with `--pack workflow-slop`. The main rule, `run-expression`, looks
at `run:` scalars inside `.github/workflows/*.yml`/`*.yaml`, plus one
`with:` input the pack's executed-input list names as code an action
executes at runtime (`actions/github-script`'s `script`, at minimum -- see
[Executed action inputs](#workflow-slop-executed-action-inputs) below). A
`${{ ... }}` in `name:`, `if:`, `env:`, or any other `with:` input is
never a finding, and neither is a `run` key inside a real `uses:` step's
`with:` input block; a `with:` mapping that is not a `uses:` step's input
block is still scanned, fail-closed. GitHub substitutes `${{ ... }}`
expressions into the workflow's YAML text *before* the shell ever sees
`run:`, so an expression whose value an attacker can influence (a step
output computed from a PR title, a branch or tag name, an issue body)
becomes program text in that shell, not a string argument. This pack
exists because of a real incident: an agent-tasks release workflow
interpolated `${{ steps.target.outputs.expected }}` (derived from a
pushed tag) straight into a `run:` body; a tag like
`mcp-server-v0.0.0";id;"` passes `git check-ref-format`, and the job
(holding `id-token: write` and publish rights) executed the injected
command. The fix is always the same shape: assign the value to an
`env:` variable and reference it as `$NAME`, where the shell treats it
as inert data.

```yaml
# BLOCKED by workflow-slop/run-expression
- id: target
  run: echo "expected=$TAG" >> "$GITHUB_OUTPUT"
- run: npm publish --tag ${{ steps.target.outputs.expected }}
```

```yaml
# fixed: routed through env:
- id: target
  run: echo "expected=$TAG" >> "$GITHUB_OUTPUT"
- env:
    EXPECTED: ${{ steps.target.outputs.expected }}
  run: npm publish --tag "$EXPECTED"
```

The rule is YAML-structure-aware (it parses the file and locates the
actual `run:` value node, not a text-shaped guess), so it finds every
`${{ ... }}` inside a `run:` scalar regardless of style: plain,
single- or double-quoted, or a block scalar (`|`/`>`) spanning many
lines.

**Allowlist.** An expression is only excused when the *entire*
`${{ ... }}` body (whitespace-trimmed) is one of the following: this
rule does not parse the GitHub Actions expression grammar, so a
compound expression (a function call, a comparison, a concatenation)
built out of only-safe pieces is still flagged rather than risk
misjudging a mixed expression as safe:

| Allowed | Why |
| --- | --- |
| `github.workspace`, `github.action_path`, `github.run_id`, `github.run_number`, `github.run_attempt`, `github.sha`, `github.job`, `github.repository`, `github.repository_owner`, `github.actor`, `github.event_name`, `github.workflow`, `github.server_url`, `github.api_url`, `github.token`, `runner.temp`, `runner.os`, `runner.arch`, `runner.tool_cache` | Runtime-assigned metadata, not free text an external contributor supplies. Verified against GitHub's [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts): each is documented as an identifier, a URL, a path, a count, or a fixed enum, for example `github.actor` is "the username of the user that triggered the initial workflow run" (a username, not free text), `github.run_id` is "a unique number for each workflow run." |
| `secrets.<NAME>` (any name) | The *value* of a secret is never attacker-supplied; only the workflow author chooses which secret names exist. |
| `steps.<id>.outcome`, `steps.<id>.conclusion` (any step id) | Not step *outputs*. GitHub's contexts reference documents both as exactly one of `success`, `failure`, `cancelled`, or `skipped`, assigned by the runner itself, never attacker-influenced text, unlike `steps.<id>.outputs.<name>` (a value the step's own script chose to emit), which stays flagged. |

**Not allowed** (verified against GitHub's [security hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions), which walks through exactly this `run:`-injection shape using `github.event.pull_request.title` as its example of untrusted input, and the contexts reference, which documents `github.head_ref` as "the `head_ref` or source branch of the pull request" (a value a forked contributor names themselves): `github.ref`, `github.ref_name`, `github.head_ref`, `github.base_ref`, `github.event.*`, `steps.*.outputs.*`, `needs.*.outputs.*`, `inputs.*`, `env.*`, `vars.*`. The documented fix for every one of these is the same `env:`-routing pattern shown above.

**`matrix.*` is deliberately not in the default allowlist**, even though a matrix built entirely from literals in the workflow is safe: this rule inspects one `run:` scalar in isolation and has no way to confirm, from that scalar alone, that every value the matrix can take is a literal (as opposed to one sourced from `steps.*.outputs`, `needs.*`, or an untrusted `include`/`exclude`). A repo that has verified its own matrix is literal-only can allowlist it explicitly:

```yaml
# slop.config.yml
packs:
  workflow-slop: true

workflow:
  allowExpressions:
    - "matrix.node"
```

`workflow.allowExpressions` is additive (on top of the built-in allowlist above) and matches by exact, whitespace-trimmed expression text (same shape as `placement.allow`'s per-pack config surface), just without the regex/span matching (each entry is a literal expression body, not a pattern). An entry that matched no `${{ ... }}` expression across the scanned workflow files (a typo, or leftover from a workflow that changed) is surfaced in `CheckSummary.warnings`, the same mechanism an unmatched `placement.instructionGlobs` pattern uses. Write the bare expression body only (`matrix.node`), not the `${{ ... }}` wrapper; a config entry that still carries `${{`/`}}` is rejected at config-load time.

<a id="workflow-slop-executed-action-inputs"></a>

**Executed action inputs: a `with:` input is not always inert data.** `run-expression`'s `with:` exemption above assumes a `with:` input is data an action reads (a file path, a label, a flag): true for most actions, but not for one whose input is itself code that action runs, most notably `actions/github-script`'s `script` input, which that action passes to `new AsyncFunction(...)` and executes as the step's own JavaScript. A `${{ ... }}` inside such an input is exactly as dangerous as one inside `run:`, so this pack consults a data list of `owner/repo` -> input-name pairs (`src/data/executed-action-inputs.ts`, one built-in entry: `actions/github-script` -> `script`) *before* applying the `with:` exemption: an input on the list is scanned exactly like a `run:` scalar (same allowlist, same scalar-style independence), while every other input of the same step, and this same input name on an action not on the list, stay exempt. Matching is `owner/repo` only, case-insensitive, independent of the step's ref (a moving major tag, a pinned sha, a branch), the same match key `node20-action-major` uses minus the version component; a `docker://` or local `./`/`../` reference, or a reusable-workflow call, never resolves to an `owner/repo` and so can never match. The input-name half is matched case-insensitively too, with a literal space folded to an underscore, using the same expression `@actions/core`'s `getInput` applies to build `INPUT_<NAME>` (`name.replace(/ /g, "_").toUpperCase()`): `with: script:`, `with: Script:`, and `with: SCRIPT:` on `actions/github-script` all match the same built-in entry. The fold goes up, not down, because Unicode case folding is not symmetric: a key spelled with a dotless i or a long s upper-cases to `SCRIPT` and is matched, where a lower-case comparison would miss it. A config entry names the input with an underscore where a workflow author might write a literal space; matching folds the two together.

Like every workflow-slop rule, this scan only reads `.github/workflows/*.yml`/`.yaml` (see `WORKFLOW_FILE_RE`): a `script:` input executed by an `actions/github-script` step inside a composite action's own `action.yml` is not covered, even though that file also runs on the same runner. This is a deliberate scope decision, not an oversight -- extending the scan into arbitrary `action.yml` files (found anywhere in a checkout, not confined to a known directory) is a different, currently unimplemented, feature.

```yaml
# BLOCKED by workflow-slop/run-expression
- uses: actions/github-script@v7
  with:
    script: |
      const title = "${{ github.event.issue.title }}";
      github.rest.issues.createComment({ body: `Thanks for filing: ${title}` });
```

```yaml
# fixed: routed through env:, read back inside the script
- uses: actions/github-script@v7
  env:
    ISSUE_TITLE: ${{ github.event.issue.title }}
  with:
    script: |
      const title = process.env.ISSUE_TITLE;
      github.rest.issues.createComment({ body: `Thanks for filing: ${title}` });
```

The list is extendable per repo, the same shape `node20Majors` uses:

```yaml
# slop.config.yml
packs:
  workflow-slop: true

workflow:
  executedActionInputs:
    - "acme/run-code:code"
```

`workflow.executedActionInputs` entries are `owner/repo:input` (no `@ref`: matching is ref-independent, so a version suffix here is rejected at config-load time), additive on top of the built-in default list. The FIRST colon after `owner/repo` separates it from the input name, so an input name can never itself contain a colon (nor a literal space -- write an underscore instead; matching folds it back to a space-equivalent form, see above). Unlike `node20Majors`/`node20MajorsIgnore` there is no subtractive list, since the package ships only one built-in entry to remove.

**Fail-closed: a `uses:` key present but null or empty is not a `uses:` step.** `run-expression`'s `with:` exemption (and the executed-input match above) both require the containing mapping to carry a real, non-empty `uses:` value -- a step written as `uses:` with nothing after it, or `uses: ""`, no longer counts as a `uses:` step for either. Its `with:` block, if it has one, is then walked like an ordinary mapping instead of an action's input block: a `run:` or an executed-input match found there is reported like any other, rather than silently exempted because a malformed `uses:` happened to be present. A step whose `uses:` is a real, non-empty value (including a `./local` path or a `docker://` reference this pack cannot resolve to an `owner/repo`) keeps the ordinary exemption; only the null/empty case changes behaviour.

**`unparseable-workflow`: a broken workflow file is never scored clean.** `run-expression` walks the YAML tree `yaml`'s parser produced, but that parser does not throw on most syntax errors, it records them and still returns whatever partial tree it managed to build. A workflow file broken partway through (an unterminated quoted scalar, an unbalanced flow collection) can silently drop everything after the break, including a `${{ ... }}` expression this pack exists to catch. The `unparseable-workflow` rule reports one `block`-severity finding whenever a scanned workflow file has a YAML syntax error, naming the file and the first parse error, so a broken file always produces at least one workflow-slop finding instead of a false-clean result.

**`node20-action-major`: a reintroduced Node-20 GitHub Actions major.** A fleet sweep can move every workflow off the actions/runtimes still pinned to a deprecated Node-20 major, but nothing then stops a later edit (a copy-pasted step, an unreviewed dependency bump) from reintroducing one. This rule flags any `uses:` value (job-level or step-level) whose `owner/repo@major` is on a Node-20 list:

```yaml
# BLOCKED by workflow-slop/node20-action-major
- uses: actions/checkout@v4
```

```yaml
# fixed: bump past the flagged major
- uses: actions/checkout@v5
```

The list is data, not hardcoded logic: `src/data/node20-actions.ts` ships a default list, each entry verified by fetching that action's `action.yml` at the moving major tag and reading `runs.using`. Extend it per repo without waiting on a package release:

```yaml
# slop.config.yml
packs:
  workflow-slop: true

workflow:
  node20Majors:
    - "acme/custom-action@v1"
  node20MajorsIgnore:
    - "actions/checkout@v4"
```

`node20Majors` adds entries on top of the default list; `node20MajorsIgnore` is applied after, so it can drop a default-list entry (an action that has since moved off Node 20) or one added via `node20Majors`. Both take the same `owner/repo@vN` shape, matched case-insensitively (`Actions/Checkout@V4` resolves to the same entry as `actions/checkout@v4`; the config file's own `owner/repo@vN` shape check still requires a lowercase `v`, e.g. `actions/checkout@v4`, not `@V4`, ahead of the digits). A trailing prerelease-ish suffix on the ref is tolerated and ignored for major resolution (`actions/checkout@v4-beta` still resolves to major `v4`); this is a deliberate simplification, not full semver-prerelease parsing.

A local `./path` action and a `docker://image` reference are never flagged (neither names a published `owner/repo@vN` action). A reusable-workflow call (`uses:` naming a `.yml`/`.yaml` file rather than an action) is excluded the same way, even when its ref happens to look like a listed major (including when the reusable workflow's own owner/repo, e.g. `actions/checkout/.github/workflows/build.yml@v4`, is itself on the default list). A `uses:` value written inside a step's own `with:` input block (a custom action can name an input literally `uses`) is not collected as a step, the same schema-position gating `run-expression` already applies to `run:`. A `uses:` pinned to a full commit sha is only checked when the same line also carries a trailing `# vN` comment (`uses: actions/checkout@8f4b7f8 # v4`, case-insensitive); a bare sha pin with no version annotation cannot be resolved to a major from the text alone and is not flagged (a deliberate limitation, not a rule the pack tries to work around). A docker-container action (`runs.using: docker`) or a composite action is never Node-20 by itself and is intentionally left off the default list, even when it commonly sits next to Node-20 actions in the same job.

**`audit-gate-missing` and `audit-gate-shape`: the npm-audit gate in `audit.yml`.** A repo's `audit.yml` can carry a dedicated gate step, `npm audit --audit-level=high` (or `critical`, or the stronger `moderate`/`low`), that fails the job on a matching advisory. Two rules guard it, both `block`, both scoped to files literally named `audit.yml`/`audit.yaml` under `.github/workflows/` and to `npm audit` specifically (see "Scope" below):

- **`audit-gate-missing`** reports an `audit.yml` in which no step's normalised shell statements invoke the gate command at all.
- **`audit-gate-shape`** reports a gate step whose normalised run block matches none of the recognised shapes and no registered template, whose step or job carries a `continue-on-error` that cannot be proven `false`, or whose effective shell is not one the rule analyses as bash (see "The gate step's shell" below).

```yaml
# BLOCKED by workflow-slop/audit-gate-shape: unrecognised gate shape
- run: npm audit --audit-level=high || true
```

```yaml
# fixed: let a non-zero exit fail the step (the R-bare shape)
- run: npm audit --audit-level=high
```

**This is a shape allowlist, not a neutralisation blocklist.** An earlier revision of `audit-gate-shape` enumerated the ways a gate can be defused (`|| true`, `; true`, a bare `set +e`, a missing verdict) and reported a block that matched one of them. Every such enumeration leaks in the false-**clean** direction: the next bash construct nobody listed scans green, and bash offers a long tail of them (a shell comment, a here-doc body, a combined `set` flag spelling, a pipeline without `pipefail`, a folded scalar are each a different way to write the same defused gate). The rule asks the opposite question instead, and a gate step is reported **unless** it is recognised. That inverts the leak into false **positives**, which are visible, readable and fixable: register the block as a template, disable the rule for the repo, or use a per-line opt-out. For a `block`-severity security gate that is the only acceptable leak direction. The old enumeration survives only as one extra sentence on a finding that was already reported ("Detected neutralisation signal: ..."); it can never make a block clean.

**Every check reads one normalised view of the run block, never its raw text.** A step's `run:` body goes through a single normalisation step before any check looks at it, and there is no second path:

1. **Here-doc bodies dropped.** On an unquoted `<<`/`<<-` followed by a (possibly quoted) delimiter, the physical lines up to the terminator line are dropped; the redirection statement itself is kept, because it is real program text. A gate command, an `exit 1`, or a `|| true` that exists only inside a `cat <<'MSG'` body is data the shell prints, not a command it runs, and is not read as one.
2. **Logical lines.** Backslash-continued physical lines are joined into one logical line (the backslash and the newline are dropped, nothing else is inserted, matching bash's own backslash-newline removal), so a `||`/`;` tail written on a continuation line is inspected as part of the line it actually runs on.
3. **Comments stripped, per logical line.** Each joined line loses its trailing shell comment, and only when the `#` sits outside a quoted string (a quote-parity scan with escaped-quote handling inside a double-quoted span, so `--note="it\"s fine"   # comment` still strips correctly). A `# TODO: restore npm audit --audit-level=high` is a comment, not a gate.
4. **Statements.** Each comment-free logical line is cut into statements at every unquoted `;`, `&&`, `||` or `|` boundary that is not inside a command substitution, and each statement remembers which separator attached it to the one before.
5. **Quoting respected per match kind.** A command word (`set +e`, `exit 1`) must start outside any quoted span, so `echo "set +e"` is not a `set +e`; an expansion (`$?`) also counts inside a double-quoted span, because `STATUS="$?"` is a real capture while a single-quoted `'$?'` is inert.

**The recognised shapes.** A gate step is clean when its normalised statement list matches one of these, evaluated in this order after the scalar-style check below:

- **`R-bare`** -- the gate command is the whole block: exactly one statement, first in the block, an optional `timeout <arg>` prefix, any `npm audit` flags, and no operator, redirection or substitution at all. `npm audit --audit-level=moderate` and `timeout 60s npm  audit --audit-level=critical --omit=dev` are `R-bare`; `npm audit --audit-level=high >/dev/null` is not (a redirection of stdout is refused wholesale rather than only for a discarding sink, because "which sink discards" is exactly the kind of enumeration this rule stopped making).
- **`R-classify`** -- the gate's own exit status is captured and turned into the step's exit status:

  ```bash
  # permitted before the window: assignments, option-enabling `set -`,
  # trap (only one that does not itself call `exit`), mkdir, mktemp, cd,
  # echo, printf
  set -o pipefail
  set +e                                    # exactly one, any spelling that
                                            # disables errexit: +e, +eu,
                                            # +o errexit
  npm audit --audit-level=high 2>&1 | tee "$LOG"   # optionally piped, only
                                                   # into tee, only with
                                                   # pipefail set earlier
  STATUS=$?                                 # at most one capture, after the gate
  set -e                                    # exactly one restore: -e, -eo
                                            # pipefail, -euo pipefail,
                                            # -o errexit
  # permitted after the restore: if/then/else/elif/fi, echo, printf, and
  # an `exit` of either a non-zero literal or the captured status
  if [ "$STATUS" -ne 0 ]; then
    exit 1                                  # required: an exit of a non-zero
  fi                                        # literal
  exit $STATUS                              # required: an exit of the captured
                                            # status
  ```

  Everything is positional and exhaustive: a statement the shape does not name makes the block unrecognised, so a construct this rule never heard of cannot ride along inside a recognised block (what the shape does not check is which branch a named `exit` sits in; see the honest limits below). That is why the window admits the capture and nothing else (an `echo` between `set +e` and the gate is reported), why a `STATUS=0` reassignment after the restore is reported, and why *every* `exit` after the restore has to be one of the two verdicts: a bare `exit` exits with the status of whatever ran last (post-restore, an `echo`, so zero), and `exit $OTHER` or `exit ${STATUS:-0}` hands over a value the shape knows nothing about. A pre-window `trap` is permitted only when its own body does not call `exit`, since an `EXIT` trap leaves the script's status alone unless it exits itself, and `trap 'exit 0' EXIT` would make every later verdict irrelevant (the `EXIT` signal name is matched case-sensitively, so a cleanup `trap 'rm -f "$LOG"' EXIT` is fine).

- **A registered template** -- see "Registering a gate template" below.

**The normaliser refuses to certify what it does not model.** Before any shape is tried, the block is checked for constructs whose presence makes the statement list an unreliable model of the script. Each refusal is reported with its own reason ("Unrecognised npm-audit gate shape in this audit workflow: ..."), never treated as clean:

- the `run:` value is not a literal block scalar (`|`) or a single-line plain scalar -- a folded `>` scalar joins lines with spaces, a multi-line plain scalar folds the same way, and a quoted scalar carries YAML escapes that would have to be decoded first, so none of them is analysed as shell text (and none counts as a present gate for `audit-gate-missing`);
- a here-doc redirection, or one whose terminator could not be located;
- a shell function definition (`name() {`, `function name`);
- an `eval`;
- a backgrounding `&` (a `2>&1`, `&>log` or `>&2` redirection is not one);
- an unbalanced quote on a logical line (a string spanning physical lines);
- a command substitution spanning a statement separator (`$(echo a || echo b)` on the gate line).

A miss in that list yields a false positive, never a false clean from an unnamed statement (which branch a named `exit` sits in is not evaluated; see the honest limits below): an unmodelled construct that slips past every entry still has to match a recognised shape, and no shape permits a statement it does not name. That is why this one may be a list at all, unlike the neutralisation enumeration it replaced.

**`continue-on-error`.** On the gate step **or** its enclosing job, any value that cannot be proven `false` is reported: a literal `true`, the string `"true"`, and an unresolved `${{ ... }}` expression (which parses as a plain string and cannot be evaluated statically) all count; only literal `false`/`"false"` clears it. A step- or job-level `if:` that would prevent the gate step from running at all is a separate GitHub Actions mechanism this rule does not evaluate.

**The gate step's shell.** `audit-gate-shape` also reads which shell actually runs the gate step, and refuses to certify anything it does not resolve to bash: the step's own `shell:` key, else its enclosing job's `defaults.run.shell`, else the workflow's own `defaults.run.shell`. Certified: an absent `shell:` at all three levels (GitHub's own default on Linux/macOS runners), the literal `bash`, and a custom shell command template whose program token is the bare `bash` or one of the absolute paths `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash` (a closed list: the runner executes exactly the named file, so `./bash {0}`, any other path ending in `bash`, and `bash.exe` refuse rather than letting a file merely named bash certify) AND whose trailing tokens are all on this rule's own no-op allowlist, with the LAST token exactly `{0}` (appearing nowhere else in the template): `-e`, `-u`, `-x` (singly or combined into one short cluster, e.g. `-eux`), `-o <name>` or a cluster ending in `o` followed by `<name>` (only when `<name>` is `pipefail`, `errexit`, `nounset` or `xtrace`), `--noprofile`, and `--norc`. `bash`, `bash {0}`, `bash -e {0}`, `bash --noprofile --norc -eo pipefail {0}` (GitHub's own default expansion) and `bash -eux -o pipefail {0}` are all certified this way. Refused: `pwsh`, `powershell`, `python`, `cmd`, `sh` (GitHub's `sh` keyword is its own documented shell, not bash, even where `/bin/sh` happens to be a bash symlink), a custom bash template carrying any token outside that allowlist -- `-c`, `-n`, `-s`, `-i`, `-l`, `-r`, `--version`, `--help`, `--rcfile`, `--init-file`, `-O`, a `+`-prefixed option (these turn a `set` flag OFF, the opposite of the allowlist's enabling forms), `-o noexec`, a quoted argument, or a plain `||`/`;` (GitHub execs the template without a shell, so these are ordinary argv words, not operators) -- a template with no `{0}` at all (`bash -e`), more than one `{0}`, or text before or after it (`bash {0} || true`, `bash -e {0} extra`), a non-literal `${{ ... }}` value at any of the three levels, and a `shell:` key present but empty or written as a sequence or a mapping rather than a plain scalar. Also refused: an absent shell on a job whose `runs-on:` is a literal naming a Windows runner -- a bare `windows` label, a `windows-*` GitHub-hosted name, or the runner-group object form (`runs-on: { group: <name>, labels: [...] }`, block or flow style, either style's `labels:` itself a scalar or a sequence) whose `labels:` names one; a mapping naming only a `group:` (no literal `labels:`) is a documented residual, left unresolved. Windows label matching is case-insensitive throughout (a self-hosted label is free text an operator could spell any way, and over-matching is the safe direction for a `block`-severity gate), so `runs-on: Windows-Latest` refuses too -- a differently named self-hosted Windows runner (one whose label does not start with `windows`, case-insensitively) needs an explicit `shell:`, since this rule has no other way to know its OS. An unresolved `runs-on:` (an expression, a matrix reference, or an object form with no literal `labels:`) is a documented residual: left certified exactly as an absent shell always was, never resolved to a concrete runner OS. Program names are matched case-sensitively against GitHub's own lower-case keywords, so `Bash`/`BASH` refuse too, on the same reasoning: nothing in GitHub's documented behaviour says a differently-cased name is treated as the same interpreter. Neither recognised shape's exit-code guarantee depends on the invoking shell's own `-e`/`pipefail` defaults (`R-bare` permits no statement after the gate command at all, and `R-classify` manages `errexit` itself with an explicit `set +e`/`set -e` and an explicit `exit`), which is why a custom bash template missing `-e` is certified exactly like the literal `bash` keyword; this reasoning does not extend to a REGISTERED TEMPLATE, whose own dependence on the invoking shell's `-e`/`pipefail` is not analysed by this rule at all (see "the honest limits" below). This check runs, and refuses, before a registered template is even considered: a template match is an attestation about the script as bash text, which does not hold under a shell that never runs it as written -- and unlike a shape or template refusal, a shell refusal's finding names the real remedy for it (set an explicit bash `shell:`, or use the reviewed per-repo exception -- see "Scope" below) rather than shape/template guidance that cannot clear it.

**Registering a gate template.** A repo whose real gate block is legitimate but unmodelled (a classification block with helper functions, a custom exit-code mapping) registers it by digest instead of rewriting it. In short: run the pack against your `audit.yml`, read the sha256 digest an `audit-gate-shape` finding prints for the unmatched block, review the block, then register that digest under `workflow.auditGateTemplates` in your own config. The digest is the sha256 of the block's normalised statements, each trimmed, prefixed with the `;`, `&&`, `||` or `|` boundary it followed (a statement that starts a line carries none), and joined by newlines, and a finding on an unmatched block prints it:

```yaml
# slop.config.yml
packs:
  workflow-slop: true

workflow:
  auditGateTemplates:
    - name: canonical-audit-gate
      sha256: 039827d6b99e8648dad25933d62413fd94e32de33be03c0d46cea225b7b6f0ec
      # (the digest of the gate block in this package's test fixture
      # fleet-audit-real-shape.yml, shown so the example is runnable against
      # the shipped fixture; register your own block's digest, which the
      # finding prints)
    # or write the statements out and let the tool hash them (this form
    # describes a newline-separated block; a `;`, `&&`, `||` or `|`
    # boundary inside a line is part of the digest and needs the sha256
    # form):
    - name: bare-gate-with-timeout
      statements:
        - timeout 60s npm audit --audit-level=high
```

The package ships **no** template of its own: a canonical gate block is org content, not package content, so every entry is the consuming repo's own. A matched template is trusted **as is** -- no shape analysis runs on it, because registering the digest is the operator's statement that they reviewed this exact script, and that is how a block carrying constructs no shape models (helper functions, for instance) is recognised. The cost is the flip side of the same property: **a deliberate change to a registered block, including a harmless one, changes its digest and is reported until the operator updates the entry in that repo's `slop.config.yml`.** Comments, indentation, blank lines and line-ending style are already normalised away, so a pure reformat does not move the digest; anything that changes what the script runs does.

**The honest limits.** These are shape checks over one run block, not an evaluation of the script:

- **The rules are bound to the file name.** Only `.github/workflows/audit.yml` and `audit.yaml` are scanned (`appliesTo`), so an npm-audit gate that lives in `ci.yml`, `security.yml`, or any other workflow file is outside both rules entirely, whatever shape it has.
- **`exit $VAR` is accepted without proving `$VAR` is non-zero at runtime.** `R-classify` requires that the captured status is handed to `exit`, and that no `exit 0`, no other `exit` operand and no reassignment of that variable follows the restore, which is as far as the text goes. It does not evaluate the branch conditions that decide which `exit` is reached.
- **A registered template is trusted as is.** Its digest match suppresses every shape check for that block, so the review that justified registering it is the only thing standing behind it. That trust is not extended by the shell check's own `-e`/`pipefail` reasoning above: a REGISTERED template's dependence on the invoking shell's `errexit`/`pipefail` defaults is not analysed at all (unlike `R-bare`/`R-classify`, which manage that themselves and so a custom bash template's own missing `-e` is provably harmless), so a registered block that silently relies on its shell's `-e` is not double-checked here.
- **Branch reachability is not modelled.** `R-classify` requires the two verdict exits to be present after the restore and permits `if`/`then`/`else`/`elif`/`fi` around them, but it does not evaluate the conditions, so a block whose verdicts both sit in a branch that is never taken is still recognised. Reviewing the conditions of a recognised block stays a human step.
- **The rules cannot see a deleted or renamed `audit.yml`.** Both rules are scoped to that file name, so removing the file, or moving the gate to a workflow with another name, produces no finding at all; an inventory check over the repository, not a file scan, is what covers that edit.
- **The shell check reads a single leading program token against a closed list, nothing more.** `/usr/bin/env bash {0}`, `env bash {0}` and `sudo bash {0}` all refuse, even though each really does run the gate script under bash: the program token is `env`/`sudo`, and this rule does not walk past it to find the real interpreter. A bash installed at any other absolute path (`/opt/homebrew/bin/bash {0}`) and a lone path without `{0}` (`/usr/bin/bash`, which the runner itself rejects) refuse too. All of these are false positives in the safe direction; write the bare `bash` instead. A non-literal `runs-on:` (an expression or a matrix reference) is also not resolved to a concrete OS, so an absent shell there stays certified even when the matrix could produce a Windows runner.
- **Workflow triggers are not evaluated.** A gate that is present and correctly shaped but never runs, because `on:` was narrowed or the job carries an `if:` that is never true, reports clean.
- **A duplicated key is read at its first occurrence.** A step with `shell:` (or a job with `runs-on:`) written twice is not valid YAML; `workflow-slop/unparseable-workflow` reports such a file with a block finding of its own, so it never scans clean, but the shell check's verdict for it is not meaningful.
- **YAML anchors and merge keys are not followed.** A `defaults:` block (or a `shell:`/`runs-on:` value) supplied only via a YAML anchor/alias or a `<<:` merge key, rather than written literally where this rule looks for it, is read as absent at that level, not resolved through the anchor to its real value.

**Scope: `npm audit` only.** The gate-command match (`isGateCommand`) requires literal `npm audit` in the statement; `pnpm audit --audit-level=high`, `pip-audit`, `cargo audit`, and a reusable-workflow-call `audit.yml` (`uses: org/repo/.github/workflows/audit.yml@vN`, no `run:` step to inspect) are all out of these rules' reach and are reported by `audit-gate-missing` (the same finding a truly-missing gate produces) rather than silently skipped. A repo whose `audit.yml` legitimately uses one of those does not need to live with that finding: disable either rule on its own while keeping the rest of `workflow-slop` (including `node20-action-major`) via

```yaml
# slop.config.yml
packs:
  workflow-slop: true

rules:
  "workflow-slop/audit-gate-missing":
    enabled: false
  "workflow-slop/audit-gate-shape":
    enabled: false
```

For a one-off reviewed exception on a single line, use the pack's existing per-line disable-comment mechanism instead (see [Per-line opt-out](configuration.md#per-line-opt-out)): `# slop-detector:disable-line=workflow-slop/audit-gate-shape`.

**Wiring pattern for other repos.** This repo's own `.github/workflows/ci.yml` runs the check in a dedicated `workflow-guard` job (separate from `placement-guard`, since this is a security control, not a doc-hygiene lint): install and build `slop-detector`, then

```bash
node packages/slop-detector/dist/cli.js check . --pack workflow-slop --config slop.config.yml
```

from the repo root. Any repo that vendors (or npm-installs) `slop-detector` can copy that one step into an existing CI job; no other wiring is needed since the pack is off by default until named with `--pack` or `packs.workflow-slop: true`.
