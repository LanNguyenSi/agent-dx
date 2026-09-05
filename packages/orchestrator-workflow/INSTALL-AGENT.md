# Installing via a coding agent

Give your agent this single line:

```text
Follow the install instructions at https://raw.githubusercontent.com/LanNguyenSi/agent-dx/master/packages/orchestrator-workflow/INSTALL-AGENT.md
```

The agent fetches this file and executes the numbered instructions in the
"Instructions for the agent" section at the bottom. The two sections in
between explain, for you, what those instructions make the agent do and
which files it may touch, so you can audit the prompt before delegating.

The audit applies to the revision you read: the link above tracks `master`,
which is mutable. For a stable audit, pin the URL to a commit SHA instead
(replace `master` with the SHA).

## What the linked instructions do

1. **Inspect the repository and installed state**: detect harness configs,
   read an existing workflow manifest, and inspect native model capabilities
   where the harness provides them. Existing choices and authorization are
   evidence; the agent does not make you answer them again.
2. **Prepare a concrete configuration diff**: selected harnesses, profile,
   tier variants, and the complete per-harness role/tier routing that will be
   persisted. Existing routing leaves remain exact unless you asked to change
   them. The agent records the prior routing in its handoff as the rollback
   input and never treats "latest" or "newer" as a reason to change models.
3. **Ask only when needed**, for a material preference, missing authority, or
   a conflict that changes the result. Then run the non-interactive CLI with
   `--routing <json-file>` for the reviewed deep patch and, when available,
   `--codex-catalog <json-file>` for deterministic Codex capability checking.
   If the installer reports conflicts with locally edited files, inspect the
   concrete files and reuse any overwrite authority already granted for that
   scope. Ask before a `--force` re-run only when authority or conflict scope
   remains unresolved. **The operator
   path**: when an operator has already run `orchestrator-workflow setup`
   on this machine (an operator manifest exists at
   `<operator home>/manifest.json`, where the operator home is
   `~/.orchestrator-workflow/` unless `ORCHESTRATOR_WORKFLOW_HOME` names a
   different directory), the agent runs
   `orchestrator-workflow apply --target <repo>` instead of `init`, which
   sources its defaults from that operator install and registers the
   repository under it. A repository that already has the kit installed
   and only needs bringing under that management, with nothing in it
   changed, is registered with `orchestrator-workflow adopt <repo>`
   instead of either command.
4. **Manual fallback only when npx or the registry is unavailable**: create
   the same files by hand from this repository's `assets/` directory,
   following the byte-precise rules in step 4 below. This manual path
   covers `init` only; there is no manual equivalent for `apply` or
   `adopt`, both of which require the installed CLI.
5. **Verify and report back**: describe the applied routing, prior routing
   rollback input, installed profile and variants, and the supported dispatch
   path (named selection, explicit model/effort spawn from the installed TOML,
   or inline/sequential fallback). Include checks run, unknown capability or
   entitlement gaps, and conflicts left in place. The workflow never opens a
   GUI or changes fleet or global harness configuration.

### Write surface

The install creates or touches only these paths:

- `.ai/workflow/templates/00-goal.md` through `06-handoff.md`,
  `.ai/workflow/manifest.json`, `.ai/runs/.gitkeep` (new files). The
  orchestrator later writes a per-worktree `.ai/run` pointer at run time (a
  machine-local absolute path, not written by the installer); add it to the
  repository's `.gitignore`. This repository's own `.ai/workflow/manifest.json`
  can additionally carry one optional field, `pin`: a kit version recorded
  by `apply --pin`/`--unpin`/`--force-pin`, absent when no pin was ever set.
- **Operator path only** (`apply`/`adopt`, not `init`): the operator's own
  home's manifest, `<operator home>/manifest.json`, where the operator home
  is `~/.orchestrator-workflow/` unless `ORCHESTRATOR_WORKFLOW_HOME` names a
  different directory, gains or updates its record of this repository,
  guarded by a transient `.manifest.lock` directory held only for the
  duration of that write. Neither path lives inside the target repository.
- `AGENTS.md`: the marker-fenced workflow section is appended (file created
  when missing); content outside the
  `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->`
  markers is never modified
- `CLAUDE.md`: one `@AGENTS.md` import line appended when missing; the file
  is created with a short heading when absent (Claude Code harness only)
- `.claude/skills/orchestrator-workflow/SKILL.md` and
  `.claude/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md` (Claude Code)
- `.agents/skills/orchestrator-workflow/SKILL.md` and
  `.codex/agents/{explorer,task-slicer,implementer,reviewer,advisor}.toml` (Codex)
- `.opencode/skills/orchestrator-workflow/SKILL.md` and
  `.opencode/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md` (opencode)

The per-role agent files above are the `full` profile (the default); the
`minimal` profile writes only the `implementer` and `reviewer` files for all
three harnesses and skips `task-slicer`, `explorer`, and `advisor` entirely.
When `--tiers` is on, each installed role
additionally gets one subagent file per non-default effort tier, named
`<role>-<tier>.md` for Claude Code/opencode or `<role>-<tier>.toml` for Codex
(never a file for the role's own default tier, which would collide with the
plain role file); see the package README's
"Effort tiers" section for the full role/tier table and the per-harness
frontmatter shape. `--tiers` is off by default and has no interactive
prompt equivalent in the manual fallback below (nor does its negation,
`--no-tiers`): the automated installer is the only path that renders
tier-variant files; a manual scaffold (step 4) does not cover them.
The manifest records the complete effective routing map, including exact
Codex model and effort selections. Nothing else in the repository is modified. Locally edited files are
reported as conflicts and left alone, never overwritten silently; the
exceptions are the kit-owned surfaces: `.ai/workflow/manifest.json` (the
kit's state file, rewritten whenever the applied state changes) and the
fenced AGENTS.md section itself, which is restored on re-run. The install
is fully reversible: `npx orchestrator-workflow uninstall` removes exactly
this write surface again, keeping run history under `.ai/runs/` and any
locally edited files. Network access is limited to the npm registry (for
`npx`) and, in the manual fallback, this repository on github.com /
raw.githubusercontent.com. Native harness capability inspection is read-only;
the workflow does not open a GUI or mutate global or fleet configuration.

## Instructions for the agent

You are a coding agent that was pointed at this file. Execute the following
steps in the repository you were asked to install into.

1. Inspect the target before proposing changes:
   - Detect `.claude/` or `CLAUDE.md` (Claude Code), `.opencode/`,
     `opencode.json` or `opencode.jsonc` (opencode), and `.agents/` or
     `.codex/` (Codex).
   - Read `.ai/workflow/manifest.json` when present. Treat its harnesses,
     profile, tiers, legacy models, and exact routing as the reinstall
     baseline. Preserve them unless the operator already requested a change.
   - Inspect native model capabilities when the installed harness exposes a
     read-only command. For Codex, a refreshed `codex debug models` catalog
     can be supplied to the installer with `--codex-catalog`; a bundled-only
     view does not prove account entitlement. Do not invent a minimum harness
     version. If the catalog or entitlement is unavailable offline, report
     that gap instead of claiming validation.
   - Check for an operator manifest as described under "Operator path" below.
     Existing authorization and preferences remain valid. Do not open a GUI
     or change global or fleet configuration.

2. Prepare a concrete, reviewable configuration diff. Infer the harness set
   from installed state and detected configs; infer the existing profile,
   tiers, and routing from the manifests. Use `full` for a fresh install
   unless the repository clearly calls for `minimal`. Build a routing JSON
   deep patch only for leaves that need to change. Its shape is
   `harness -> role -> tier -> {model, effort}`; the role's default-tier key
   configures the unsuffixed file. Preserve every omitted leaf. Keep the prior
   routing in the handoff as the rollback input. Never upgrade a model merely
   because a newer one exists, and ask the operator only when a material
   preference, authority boundary, or conflict remains unresolved.

3. Run the non-interactive installer with the reviewed configuration:

   ```bash
   npx orchestrator-workflow init --yes \
     --harness <claude,codex,opencode> \
     --profile <minimal|full> \
     [--models "explorer=<model>,task-slicer=<model>,implementer=<model>,reviewer=<model>,advisor=<model>"] \
     [--routing <routing.json>] \
     [--codex-catalog <codex-catalog.json>] \
     [--tiers | --no-tiers]
   ```

   Omit `--profile` to keep `full` (or, on a re-run, whatever profile was
   installed previously). `--models` is a backward-compatible input for
   Claude Code and opencode only; never use it to configure Codex. `--routing`
   is the highest-precedence deep patch. Add `--tiers` only when the operator asked for tier
   variants; add `--no-tiers` only when the operator explicitly wants them
   turned off on a re-run that previously had them on; omit both to keep
   tiers off on a fresh install, or whatever value was previously installed
   on a re-run. If the command reports conflicts, inspect the concrete files,
   reuse prior overwrite authority for the same scope, and ask before
   `--force` only when authority or scope remains unresolved.

   **Operator path**: before running `init`, check whether an operator
   manifest already exists on this machine, at
   `<operator home>/manifest.json` (the operator home is
   `~/.orchestrator-workflow/` unless `ORCHESTRATOR_WORKFLOW_HOME` names a
   different directory). If it does, run
   `orchestrator-workflow apply --target <repo>` with the same flags in
   place of `init --yes` instead: it sources its defaults from the operator
   install and the target's own prior settings, and registers the
   repository. If the repository already has the kit installed and the
   operator only wants it brought under that management without any file
   changes, run `orchestrator-workflow adopt <repo>` instead and skip the
   rest of this step.

4. Only if npx or the registry is unavailable, scaffold manually from
   https://github.com/LanNguyenSi/agent-dx/tree/master/packages/orchestrator-workflow/assets.
   This manual path does not cover `--tiers`: it never renders
   tier variant files, regardless of what the operator asked
   for in step 2; tell the operator tier variants require the automated
   installer (step 3). It also cannot safely reproduce native Codex TOML from
   the Markdown assets without duplicating the installer's serializer. For a
   Codex manual fallback, install the shared skill only and state that roles
   must run inline and sequentially until the automated CLI can generate
   `.codex/agents/*.toml`.

   - `.ai/workflow/templates/00-goal.md` through `06-handoff.md` from
     `assets/templates/`, unchanged.
   - `.ai/runs/.gitkeep`, empty. The orchestrator later writes a
     per-worktree `.ai/run` pointer at run time (a machine-local absolute
     path, not written by the installer); add it to the repository's
     `.gitignore`.
   - Append the content of `assets/agents-md-section.md` to `AGENTS.md`
     (create the file when missing; the installer starts a fresh file with a
     `# Agent instructions` heading). Never change anything outside the
     `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->`
     markers.
   - Claude Code: `.claude/skills/orchestrator-workflow/SKILL.md` from
     `assets/skill/SKILL.md`. For each role in the chosen profile (all five
     for `full`; only `implementer` and `reviewer` for `minimal`),
     `.claude/agents/<role>.md` from
     `assets/agents/<role>.md` with `model: <operator's choice>` added as a
     new line directly after the `description:` line, then
     `effort: <medium|high>` on the next line (`medium` for explorer,
     task-slicer, and implementer; `high` for reviewer and advisor; this
     pinned default effort is unconditional, not tied to whether the
     operator asked for `--tiers`; see the package README's "Effort tiers"
     section), that placement matching the installer's output byte for
     byte. For the explorer, reviewer, and advisor roles additionally,
     `disallowedTools: Edit, Write, NotebookEdit` goes on a new line
     directly after the `effort:` line. Ensure `CLAUDE.md` exists and
     contains a line `@AGENTS.md`.
   - Codex: `.agents/skills/orchestrator-workflow/SKILL.md`, same skill file.
     Do not hand-author `.codex/agents/*.toml`; report the native-agent
     limitation above and use the inline/sequential role fallback.
   - opencode: `.opencode/skills/orchestrator-workflow/SKILL.md` from
     `assets/skill/SKILL.md`, unchanged.
     For each role in the chosen profile (same set as Claude Code above),
     `.opencode/agents/<role>.md` from `assets/agents/<role>.md`, with the
     frontmatter rewritten to this order: `description:` (unchanged), then
     `mode: subagent`; the `name:` line is dropped. Only emit a
     `model: <provider/model-id>` line when you have a fully-qualified id
     (i.e. the value contains a `/`, such as
     `github-copilot/claude-sonnet-4.6`). For a bare alias (`sonnet`, `opus`,
     `haiku`) or any bare id without a provider prefix, **omit the `model:`
     line entirely** — the subagent then inherits the session/default model,
     which is the safe portable fallback. The installed CLI resolves aliases
     to fully-qualified ids by running `opencode models` at install time; in a
     manual install you may not have a live catalog, so omitting `model:` is
     correct. When you do have a fully-qualified `model:` value, add the same
     pinned-default-effort line (see the package README's "Effort tiers"
     section for the exact dispatch rule), keyed by
     the role's own default tier instead of a suffix tier (`medium` for
     explorer/task-slicer/implementer, `high` for reviewer/advisor): a
     resolved Claude-family model gets `variant: high` for reviewer/advisor
     and no effort line at all for the three medium-default roles, a
     non-Claude-family provider-qualified model gets `reasoningEffort:
     medium` or `reasoningEffort: high`, and Ollama or a provider-less id
     gets no effort line either way; when `model:` is omitted (the common
     manual-fallback case above), omit the effort line too, the same
     no-live-catalog fallback. For the explorer, reviewer, and advisor roles
     additionally, `permission:` goes on a new line directly after
     `mode: subagent` (or after `model:`/the effort line when present),
     followed by `  edit: deny` (two-space indent) on the next line.
     Example read-only role frontmatter (explorer, reviewer, or advisor) when
     no model is resolved:
     ```yaml
     ---
     description: "..."
     mode: subagent
     permission:
       edit: deny
     ---
     ```
   - `.ai/workflow/manifest.json`, exactly this shape (harnesses MUST be an
     array, `profile` is `"minimal"` or `"full"`, legacy models keyed by role,
     version = the kit version you installed, read from this kit's own
     `packages/orchestrator-workflow/package.json` `version` field):

     ```json
     {
       "kit": "orchestrator-workflow",
       "version": "<kit version you installed>",
       "harnesses": ["claude", "opencode"],
       "profile": "full",
       "tiers": false,
       "models": {
         "explorer": "sonnet",
         "task-slicer": "sonnet",
         "implementer": "sonnet",
         "reviewer": "opus",
         "advisor": "opus"
       },
       "files": {},
       "installedAt": "<ISO 8601 timestamp of this install>"
     }
     ```

     Under `minimal`, `models` only needs the `implementer` and `reviewer`
     keys (the roles actually installed); the missing keys fall back to the
     kit's defaults if the profile is later switched back to `full`. `tiers`
     is always `false` from this manual path, since it never renders
     tier-variant files (see step 4's opening note above).

     A manual install may leave the `files` hash map empty; a later `init`
     run then treats existing kit files conservatively and reports conflicts
     rather than overwriting them.

5. Verify the expected files and manifest entries, then report back: which
   harnesses and roles were installed; the exact model and effort per routed
   role/tier; whether variants were rendered; the prior routing to use for a
   rollback; the commands actually run; any offline capability or entitlement
   gap; and conflicts left in place.
