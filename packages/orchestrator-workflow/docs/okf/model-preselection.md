---
type: module
title: Model preselection
description: How each subagent role's model is chosen, flows through the CLI and manifest into per-harness frontmatter, and survives re-installs.
tags: [models, cli, manifest, per-role, harness-adapters]
timestamp: 2026-08-19T22:30:00Z
sources:
  - packages/orchestrator-workflow/src/models.ts
  - packages/orchestrator-workflow/src/cli.ts
  - packages/orchestrator-workflow/src/init.ts
  - packages/orchestrator-workflow/src/opencode.ts
  - packages/orchestrator-workflow/src/assets.ts
  - packages/orchestrator-workflow/src/detect.ts
  - packages/orchestrator-workflow/README.md
  - packages/orchestrator-workflow/INSTALL-AGENT.md
  - packages/orchestrator-workflow/assets/agents-md-section.md
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/test/init.test.ts
---

## What gets preselected

Four roles get a per-role model: `explorer`, `task-slicer`, `implementer`,
`reviewer` (`packages/orchestrator-workflow/src/models.ts:3-8`). The
orchestrator itself is deliberately excluded from this map; it always runs on
the session's main model (`src/models.ts:66-69`, policy restated below). Since
0.15.0 all four roles still get a preselected model regardless of `--profile`
(models are resolved before roles are filtered down to what the profile
installs); see [install-fence-mechanics.md](install-fence-mechanics.md) for
how `--profile` scopes which of the four get an actual subagent file.

Defaults (`src/models.ts:70-75`, documented in
`README.md:165-170`):

| Role | Default | Rationale (README) |
|---|---|---|
| explorer | `sonnet` | read-only terrain mapping is broad reading, not deep reasoning |
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |

`ModelAlias` is `"sonnet" | "opus" | "haiku"` (`src/models.ts:62-64`); a
role's value may also be a full model id or, for opencode, a fully-qualified
`provider/model-id` string (see below). Since 0.19.0, each role's
preselected model coexists with an independent, opt-in axis: effort-tier
subagent *variants* (`--tiers`/`--no-tiers`), covered in its own section
below, since they extend the frontmatter surface (an
`effort:`/`variant:`/`reasoningEffort:` line) rather than changing how the
base per-role model itself is chosen.

## Flow: `--models` → manifest → subagent frontmatter

1. **CLI input.** `orchestrator-workflow init` accepts `--models
   "role=model,role=model"`, parsed by `parseModelsSpec` on top of a base
   map (`src/models.ts:119-144`). Unknown roles and malformed pairs throw;
   each value is validated by `assertValidModelId`, which rejects empty
   strings, leading/trailing whitespace, and any of `:"'#\n\\` since the
   value is interpolated as a plain YAML scalar into subagent frontmatter
   (`src/models.ts:104-113`).
2. **Base resolution + interactive fallback.** The CLI builds the base map
   as `DEFAULT_MODELS` overlaid with the *previous* manifest's models (if
   any), then applies `--models` on top; when running interactively with no
   `--models`, it prompts per role instead, defaulting each prompt to the
   already-resolved value (`src/cli.ts:254-260`, prompt UI at
   `src/cli.ts:99-142`). Since 0.15.0 the interactive prompt only asks about
   the roles `rolesForProfile(profile)` selects (`src/cli.ts:99-104`
   iterates a `roles` parameter instead of the full `ROLES` list), so a
   `minimal` install is not asked for `explorer`/`task-slicer` models. Since
   0.19.0 the CLI also resolves `tiers` right after models, on the same
   override-vs-persist rule, now via a `--tiers`/`--no-tiers` negatable pair
   with no interactive prompt at all (`src/cli.ts:262-272`; see "Effort
   tiers" below).
3. **Manifest.** `runInit` writes the resolved map to
   `.ai/workflow/manifest.json` under `models` (`src/init.ts:508-546`,
   `desired` object at `:510-518`), alongside `kit`, `version`, `harnesses`,
   `profile`, `tiers` (since 0.19.0), and per-file hashes. On the next run,
   `readInstalledManifest` reads it back and re-validates every value with
   `assertValidModelId`; an invalid stored id is silently dropped (falling
   back to `DEFAULT_MODELS` for that role) rather than crashing
   (`src/init.ts:115-183`, specifically `:133-145`).
4. **Per-harness frontmatter.** For each selected harness, `runInit` calls a
   `compose*Agent` function per role that turns the resolved model string
   into that harness's frontmatter shape (`src/init.ts:189-225`,
   invocations at `src/init.ts:452-456` for Claude Code and `:476-484` for
   opencode). Since 0.15.0 those invocations iterate `rolesForProfile(profile)`
   rather than the unconditional `ROLES` list, so a role's preselected model
   is only ever composed into a subagent file when the profile actually
   installs that role, see
   [install-fence-mechanics.md](install-fence-mechanics.md). Since 0.19.0 a
   second, sibling pair of `compose*AgentVariant` functions
   (`src/init.ts:240-255` Claude Code, `:298-322` opencode) composes the
   tier-variant files from the same `readAgentAsset` body; see "Effort
   tiers" below for what differs in their frontmatter.

## Per-harness frontmatter behavior

- **Claude Code.** `composeClaudeAgent` always emits a `model:` line;
  `claudeModelValue` is the identity function, so aliases and full ids pass
  through unchanged (`src/models.ts:85-87`, `src/init.ts:189-203`). The
  read-only roles (`explorer`, `reviewer`, per `READ_ONLY_ROLES` at
  `src/models.ts:14-17`) additionally get
  `disallowedTools: Edit, Write, NotebookEdit` right after `model:`
  (`src/init.ts:198-200`). Test coverage:
  `test/init.test.ts:102-108` (`model: sonnet` / `model: opus` present) and
  `:466-511` (per-role alias mix installs correctly for Claude while
  opencode differs, see below).
- **opencode.** opencode needs a fully-qualified `provider/model-id`.
  `opencodeModelValue` (the pure fallback used when the CLI has not already
  resolved a catalog) passes through any value containing `/` and returns
  `undefined` otherwise (`src/models.ts:96-98`). The real CLI path is
  richer: when the `opencode` harness is selected, `cli.ts` shells out to
  `opencode models`, parses the catalog (`loadOpencodeCatalog`,
  `src/opencode.ts:236-247`), auto-detects the provider offering Claude
  models (`detectProvider`, `src/opencode.ts:40-65`; exactly one candidate
  provider resolves automatically, more than one triggers an "ambiguous,
  pass `--opencode-provider`" warning, none triggers a "no provider found"
  warning), and resolves each alias to the highest-versioned canonical match
  (`resolveAlias`, `src/opencode.ts:115-149`, non-canonical variants like
  `-fast`/`-thinking`/`-mini`/`-latest` deprioritized). `composeOpencodeAgent`
  emits `model:` only when a resolved value exists; otherwise the line is
  omitted entirely so the subagent inherits the session/default model
  (`src/init.ts:205-225`, comment at `:215-216`). Nested-path providers such
  as `openrouter/anthropic/claude-...` are never alias-auto-resolved and
  must be passed as fully-qualified `--models` entries (`README.md:193-196`,
  confirmed by `test/init.test.ts:513-536`, `openrouter/some-model` passes
  through unchanged). Confirmed end-to-end when the `opencode` binary is
  absent: every role's file omits `model:` (`test/init.test.ts:1449-1461`),
  and the disambiguation hint goes to stderr, never stdout
  (`test/init.test.ts:1463-1470`).
- **Codex.** Codex gets no per-role subagent definition files at all: `init`
  installs only `.agents/skills/orchestrator-workflow/SKILL.md` for the
  `codex` harness (`src/init.ts:470-472`); there is no `model:` surface for
  Codex because "there is no standardized project-level subagent
  definition" and the skill instructs running roles inline instead
  (`README.md:105`), regardless of `--profile` — Codex has no per-role
  files to select from either way. `--tiers`/`--no-tiers` follow the same
  rule for the same reason: Codex gets no tier-variant files either, since
  it never gets a per-role file to render a variant of.

## Effort tiers (`--tiers` / `--no-tiers`)

Since 0.19.0, `init` also accepts `--tiers`: for each role, it renders one
additional subagent file per effort tier the role has that is not that
role's own default tier, alongside the base `<role>.md` file described
above. Off by default; there is no interactive prompt for it at all
(`src/cli.ts:262-272`; the code comment there states explicitly why: tiers
is opt-in/off via the flags only). A fix-round-1 correction on the initial
0.19.0 release (review finding M2) added commander's negatable-option
counterpart, `--no-tiers`, so a re-run can explicitly turn a previously
installed `tiers: true` back off; before the fix `--tiers` was one-way and
the only route back to `tiers: false` was hand-editing the manifest.

**Tier data (`src/models.ts:146-199`).** `Tier` is
`"low" | "medium" | "high" | "xhigh"` (`:151`). `ROLE_TIERS` (`:158-163`) is
which tiers each role gets a variant for: explorer and task-slicer
`low, medium, high`; implementer all four; reviewer `medium, high, xhigh`.
`DEFAULT_TIER` (`:170-175`) is the tier each role's plain file already
corresponds to (`medium` for explorer/task-slicer/implementer, `high` for
reviewer), the tier a variant is never rendered for since that would both
collide with and duplicate the default file (`init.ts:459` Claude Code,
`:487` opencode, both a `continue` guarded by
`tier === DEFAULT_TIER[role]`). `TIER_DEFS` (`:187-192`) maps each tier to a
`ModelClass` (`"small" | "medium" | "large"`, `:177`) and its requested
`effort` value (the tier's own name). `CLASS_MODELS` (`:195-199`) maps each
class to a `ModelAlias`: `small`->`haiku`, `medium`->`sonnet`,
`large`->`opus`. `Tier`, `ModelClass`, and all four maps are re-exported
from `src/index.ts` since fix-round-1 (review finding L2), the same
public-surface treatment `Profile`/`PROFILES` already had; the two
previously-unused `TIERS`/`isTier` exports that finding also flagged were
dropped outright rather than forced into a real call site, since the
`tiers` field they would degrade is a plain `boolean`, not a `Tier` value —
`isTier` had nothing to validate.

**Composition.** `composeClaudeAgentVariant` (`init.ts:240-255`) is the
tier-variant sibling of `composeClaudeAgent`: same frontmatter shape plus
`model: <CLASS_MODELS[modelClass]>` and `effort: <tier>` (in that order,
right after `description:`), and the same `disallowedTools:` line for
`READ_ONLY_ROLES`. `composeOpencodeAgentVariant` (`init.ts:298-322`) is the
opencode sibling; its effort line is decided by `opencodeVariantEffortLine`
(`init.ts:282-296`), which dispatches on model *family*, not provider id —
a fix-round-1 correction (review finding M4): the original 0.19.0 release
keyed the check on the literal provider string `"anthropic"`, so a Claude
model fronted by a different provider (`github-copilot/claude-sonnet-4.6`,
or the nested `openrouter/anthropic/claude-sonnet-4.6`) silently fell
through to the `reasoningEffort:` branch instead of the `variant:` one.
`isClaudeFamilyModel` (`init.ts:266-271`) now treats a resolved model id as
Claude-family when the segment after the first `/` contains `claude-`, or
the id starts with `anthropic/` outright, regardless of which provider
fronts it. Claude-family models get `variant: high` for the `high` tier and
`variant: max` for `xhigh`; `low`/`medium` on a Claude-family model get no
effort line at all (Anthropic's opencode `variant:` option does not
distinguish an effort below `high`, a documented collapse, not a bug: the
variant still gets its class's `model:` line). A non-Claude-family model
behind the `ollama` provider prefix, and any tier whose class model could
not be resolved to a fully-qualified id at all (`modelValue` is
`undefined`), also get no effort line. Every other non-Claude-family,
non-Ollama model gets a plain `reasoningEffort: <tier>` line, `xhigh`
included (D8: not mapped down to `high`, not dropped — it is part of
opencode's documented built-in OpenAI-style variant range). Both variant
composers share `tierDescriptionSuffix` (`init.ts:227-232`), which appends
`" (Effort tier: <tier>.)"` to the role's own description.

**Unresolved-class guard (fix-round-1, review finding M1).** Before the
fix, a tier's class model that failed to resolve — an empty opencode
catalog, or `--models` supplying already fully-qualified role ids that
never trigger class resolution at all — silently rendered a no-op opencode
variant file carrying neither `model:` nor an effort line, distinguishable
from the base file only by diffing the two, and with no warning anywhere.
Two changes close this. First, `cli.ts`'s tier-class resolution loop
(`:291-317`) now writes one `Warning: Tier model class "<class>" (alias
"<alias>") ...` line to stderr per unresolved class (`small`/`medium`/
`large`), mirroring `resolveOpencodeModels`'s own per-role warning style
(`opencode.ts:162-226`) rather than staying silent. Second, `runInit`'s
opencode tier loop (`init.ts:485-504`) now computes the variant's `model:`
value and effort line *before* calling `installKitFile`, and skips the
write — and the manifest ledger entry — entirely when both would be absent
(`init.ts:489-498`), so an unresolved class produces zero tier-variant
files for opencode instead of nine indistinguishable empty ones.

**Rendering (`init.ts:450-506`).** For each harness and each role
`rolesForProfile(profile)` selects, `runInit` writes the base file exactly
as it always has, then, only `if (tiers)`, loops `ROLE_TIERS[role]`
skipping the role's `DEFAULT_TIER` and writes `<role>-<tier>.md`
(`:457-465` Claude Code, `:485-504` opencode, the opencode loop now
carrying the unresolved-class skip described above). The base file's own
composition call is untouched by this addition, so a tiers-off install
renders byte-identical output to pre-0.19.0: a structural, not just tested,
guarantee against a silent model downgrade (the reviewer's `opus` default
in particular), pinned with a content assertion (not just a file-set check)
on the legacy-manifest path since fix-round-1 (review finding L1,
`test/init.test.ts:989-1042`, four-line frontmatter with no `effort:`).
With `--profile full` and tiers on, that is 4 base files plus 9 variants:
13 total per harness (`test/init.test.ts:1044-1073` pins the count and, as
a dedicated anti-downgrade check, that `reviewer.md` itself still carries
`model: opus` and no `effort:` line). opencode's variant `model:` values
come from a new, separate resolution pass keyed by `ModelClass` instead of
`Role` (`InitOptions.opencodeClassModels`, `init.ts:62-70`; resolved in
`cli.ts` at `:291-317`, mirroring the existing per-role opencode resolution
just above it at `:281-290`). The three provider-branch outcomes (Claude
family gets `variant:`, Ollama gets no effort field, every other provider
gets `reasoningEffort:`) are pinned at `test/init.test.ts:1088-1168`; the
fix-round-1 family-dispatch correction adds two more cases pinning that the
`variant:` rule follows the model regardless of provider —
`github-copilot/claude-sonnet-4.6` (`:1170-1193`) and the nested
`openrouter/anthropic/claude-sonnet-4.6` (`:1195-1218`) both still resolve
to `variant:`, not `reasoningEffort:`. The unresolved-class guard is pinned
at `:1220-1257` (an omitted `opencodeClassModels` renders zero variant
files and leaves no ledger entry), and a standalone invariant test
(`:1259-1263`) asserts `DEFAULT_TIER[role]` is always a member of
`ROLE_TIERS[role]` for every role — nothing in the type system enforces
that relationship, so a hand-edited `models.ts` could otherwise define a
default tier the role's own tier list does not carry.

**Manifest and re-install.** The chosen value is recorded in a new `tiers`
boolean on `.ai/workflow/manifest.json` (`Manifest.tiers`, `init.ts:83-84`).
A manifest written before tiers existed (no `tiers` key) degrades to
`false` (`init.ts:166-170`), the same per-field-degradation style already
used for a missing `profile` field just above it (`:158-164`): a legacy
manifest never rendered variant files, so `false` is the only value
consistent with what is actually on disk. `cli.ts` resolves the flag with
the same override-vs-persist rule as `--profile`/`--models`, but with no
interactive branch: `opts.tiers ?? previous?.tiers ?? false` (`cli.ts:272`).
This is the fix-round-1 form (review finding M2); the original 0.19.0
release read `opts.tiers ? true : (previous?.tiers ?? false)`, which had no
way to express an explicit "turn it off" short of hand-editing the
manifest, since commander only ever set `opts.tiers` to `true` or left it
`undefined` — there was no negated flag to produce `false`. commander's
negatable-option pairing (`--tiers` / `--no-tiers` declared under the same
`"tiers"` option name, `cli.ts:175-182`) resolves `opts.tiers` to `true`
when `--tiers` is passed, `false` when `--no-tiers` is passed, and
`undefined` when neither is passed; `test/init.test.ts:1349-1385` verifies
this end-to-end against the installed commander version (`--no-tiers` on a
fresh install with no previous manifest to persist, and the true->false
transition on a re-run) rather than assuming the pairing behavior. An
explicit `--tiers` or `--no-tiers` always turns it on or off; a plain
re-run (neither flag) keeps whatever the previous install had; a fresh
install with no prior manifest defaults to off. A `tiers: true -> false`
transition now leaves the same kind of leftover-file note a
`full -> minimal` profile downgrade does (`init.ts:387-404`, review finding
M2; before the fix this transition was silent, see
[install-fence-mechanics.md](install-fence-mechanics.md)), and a
`full -> minimal` downgrade that also had `tiers: true` now notes the
dropped roles' tier-variant files too, not just their base files
(`init.ts:360-376`, review finding M3;
`test/init.test.ts:845-885` pins the note count). Variant files themselves
still flow through the same `installKitFile` hash ledger as every other
kit-owned file (`init.ts:411-428`, unchanged by this feature), so
idempotence, conflict detection, and `uninstall` (see
[install-fence-mechanics.md](install-fence-mechanics.md)) all cover them
automatically with no tier-specific removal code.

README documents `--tiers`/`--no-tiers`, the role/tier table, the tier ->
model class/effort table, and the opencode provider behavior in its own
"Effort tiers" section, including a warning that `CLAUDE_CODE_EFFORT_LEVEL`
(a harness environment variable, wire-verified 2026-08-19 to override
frontmatter `effort:` on every installed agent when set) beats the
frontmatter `effort:` this feature adds, plus (since fix-round-1) the
tiers-on-to-off leftover-note behavior mirroring the profile-downgrade one.
`INSTALL-AGENT.md` documents both flags in its init question and command
example and states plainly that the manual fallback path never renders
tier-variant files.

## Re-install behavior

A re-run with no `--models` reuses the previously chosen models rather than
resetting to shipped defaults: `models = { ...DEFAULT_MODELS,
...(previous?.models ?? {}) }` in `src/cli.ts:254-257`. The same
override-vs-persist rule now also covers `--profile` (`src/cli.ts:242-252`)
and, since 0.19.0, `--tiers`/`--no-tiers` (`src/cli.ts:262-272`, see
"Effort tiers" above): a plain re-run keeps the previously installed value
for each, an explicit flag overrides it. Test:
`test/init.test.ts:965-985` runs `init --models implementer=haiku`, then a
plain `init` re-run, and asserts the manifest and the installed
`.claude/agents/implementer.md` both still carry `haiku`. A hand-edited or
damaged manifest degrades gracefully per-field: a non-object `harnesses`
falls back to `[]` filtered against known harnesses, each model id is
re-validated, with invalid entries dropped back to that role's default, a
missing `profile` field degrades to `"full"` rather than `"minimal"`, and
(since 0.19.0) a missing `tiers` field degrades to `false`
(`src/init.ts:115-183`; end-to-end proof at `test/init.test.ts:277-308`,
where a malformed `reviewer: 'opus: "x"'` is dropped to `opus` while a valid
sibling `implementer: "haiku"` survives; the `profile`-fallback proof is
`test/init.test.ts:723-760`, see
[install-fence-mechanics.md](install-fence-mechanics.md) for why that test
starts from a target with no prior `full` install; the `tiers`-fallback
proof is `test/init.test.ts:989-1042`, see "Effort tiers" above).

The manual/agent install path (`INSTALL-AGENT.md`) mirrors this contract by
hand: step 2 tells the agent to *ask* the operator for harnesses, the role
profile, per-role models, and (since 0.19.0) whether to render tier
variants, rather than guess, suggesting the same defaults and skipping the
model question for a role the chosen profile does not install
(`INSTALL-AGENT.md:23-30, 94-108`); step 4's manual fallback spells out
byte-precise placement (`model:` line directly after `description:` for
Claude Code, scoped to `.claude/agents/<role>.md` for each role in the
chosen profile, `INSTALL-AGENT.md:144-153`; conditional `model:` line only
for fully-qualified opencode ids, `INSTALL-AGENT.md:155-181`) and an example
`manifest.json` shape carrying the `profile` and (since 0.19.0) `tiers`
fields and keyed by all four roles under `full`
(`INSTALL-AGENT.md:182-202`; under `minimal`, `models` only needs the
`implementer` and `reviewer` keys, `INSTALL-AGENT.md:204-208`). That same
step 4 states explicitly that the manual path never renders tier-variant
files regardless of what the operator asked for. Since fix-round-1 (review
finding L3) this is framed as an installer-scope decision — composing
tier-variant frontmatter is logic the manual fallback simply does not
implement — rather than attributed to the missing live `opencode models`
catalog: the original wording blamed the catalog, but Claude Code's
tier-variant composition needs no catalog at all, so the catalog gap only
ever explained the opencode half of the omission
(`INSTALL-AGENT.md:129-134`).

## Orchestrator-runs-on-session-model policy

The installed `AGENTS.md` policy section carries a `### Models` subsection
verbatim (`assets/agents-md-section.md:104-110`): "The orchestrator runs on
the session's main model. Use the strongest reasoning model available,"
plus "Per-role model preferences ... are recorded in
`.ai/workflow/manifest.json` and, where the harness supports per-agent
models, in the subagent definitions themselves." README states the same
rule at `README.md:172-174`.

## Docs-consistency pins (model-specific)

`test/docs-consistency.test.ts` guards enumeration sites so a role
added to `ROLES` (`src/models.ts:3-8`) cannot silently go undocumented in
model-facing docs, each targeting the specific list rather than the whole
file:

- README's model-preselection table has one row per role
  (`test/docs-consistency.test.ts:37-41`, matches `^\| <role> \|`).
- `INSTALL-AGENT.md`'s `--models` example names every role
  (`:52-56`, checks for `<role>=<model>` per role).
- `INSTALL-AGENT.md`'s manifest example JSON has one `models` key per role
  (`:58-68`, parses the fenced JSON block and compares sorted keys).
- `agents-md-section.md`'s "Per-role model preferences (...)" parenthetical
  lists every role (`:70-79`).

A fifth, adjacent test guards the read-only-role brace lists
(`agents/{explorer,task-slicer,implementer,reviewer}.md`) in
`INSTALL-AGENT.md` (`:43-50`); it is role-enumeration generally, not
model-specific, but shares the same drift-prevention purpose.

Since 0.19.0, a standalone `describe` (`:1107-1164`) guards a tier-specific
enumeration site: README's "Effort tiers" role/tier table against
`ROLE_TIERS` and `DEFAULT_TIER` directly, per role and column
(tiers-available list order, default-tier value, and a row-count check with
no extras or omissions), so a tier added to or removed from either
`models.ts` map without a matching table edit fails loudly the same way a
role addition already does for the four sites above. Since fix-round-1
(review finding L4), a second, sibling `describe` (`:1177-1242`) guards
README's other tier-shaped table — Tier -> model class -> model alias ->
requested effort — against `TIER_DEFS`/`CLASS_MODELS` directly, the same
way; before this fix nothing guarded that second table, so it could drift
from its source maps silently.

## Solution-neutral notes for future edits

Any change to `ROLES`, `DEFAULT_MODELS`, the harness list, or (since 0.19.0)
`ROLE_TIERS`/`DEFAULT_TIER`/`TIER_DEFS`/`CLASS_MODELS` should expect
`test/docs-consistency.test.ts` to fail loudly in the corresponding doc
before a fix is complete; treat that suite as the authoritative check for
"did I update every place a role/model/tier is enumerated," not just the
docs quoted above.

See [subagent-contracts-superset.md](subagent-contracts-superset.md) for the
role I/O contracts these models are attached to, and
[install-fence-mechanics.md](install-fence-mechanics.md) for how the
composed frontmatter files are written, conflict-detected, and removed on
uninstall. [index.md](index.md) has the bundle overview.
