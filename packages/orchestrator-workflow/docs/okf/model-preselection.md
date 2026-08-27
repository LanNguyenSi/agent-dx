---
type: module
title: Model preselection
description: How each subagent role's model is chosen, flows through the CLI and manifest into per-harness frontmatter, and survives re-installs.
tags: [models, cli, manifest, per-role, harness-adapters]
timestamp: 2026-08-27T23:59:00Z
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

Five roles get a per-role model since 0.21.0 (four before it): `explorer`,
`task-slicer`, `implementer`, `reviewer`, `advisor`
(`Role` type and `ROLES`,
`packages/orchestrator-workflow/src/models.ts:1-8#"export const ROLES: Role[] = ["`). The orchestrator
itself is deliberately excluded from this map; it always runs on the
session's main model (`src/models.ts:76-78#"* deliberately not configured here."`, policy restated below). Since
0.15.0 every role in `ROLES` still gets a preselected model regardless of
`--profile` (models are resolved before roles are filtered down to what the
profile installs); see [install-fence-mechanics.md](install-fence-mechanics.md)
for how `--profile` scopes which roles get an actual subagent file — since
0.21.0 `advisor` is scoped out of `minimal` the same way `explorer` and
`task-slicer` already were, via the same `MINIMAL_PROFILE_ROLES` set
(`src/models.ts:42#"const MINIMAL_PROFILE_ROLES: ReadonlySet<Role> = new"`) simply not naming it, no new profile logic needed.

Defaults (`src/models.ts:80-85#"advisor:"`, documented in
`README.md:182-188`):

| Role | Default | Rationale (README) |
|---|---|---|
| explorer | `sonnet` | read-only terrain mapping is broad reading, not deep reasoning |
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |
| advisor | `opus` | escalations happen precisely when the situation is hard, so it shares the reviewer's strongest-model default |

`ModelAlias` is `"sonnet" | "opus" | "haiku"` (`src/models.ts:72-74#"export const MODEL_ALIASES: ModelAlias[] = ["`); a
role's value may also be a full model id or, for opencode, a fully-qualified
`provider/model-id` string (see below). Since 0.19.0, each role's
preselected model coexists with an independent, opt-in axis: effort-tier
subagent *variants* (`--tiers`/`--no-tiers`), covered in its own section
below, since they extend the frontmatter surface (an
`effort:`/`variant:`/`reasoningEffort:` line) rather than changing how the
base per-role model itself is chosen. Since 0.22.0, the base (unsuffixed)
file itself also carries a pinned effort line, unconditionally rather than
opt-in; see "Pinned default effort (0.22.0)" in the "Effort tiers" section
below.

## Flow: `--models` → manifest → subagent frontmatter

1. **CLI input.** `orchestrator-workflow init` accepts `--models
   "role=model,role=model"`, parsed by `parseModelsSpec` on top of a base
   map (`src/models.ts:126-154#"return result;"`). Unknown roles and malformed pairs throw;
   each value is validated by `assertValidModelId`, which rejects empty
   strings, leading/trailing whitespace, and any of `:"'#\n\\` since the
   value is interpolated as a plain YAML scalar into subagent frontmatter
   (`src/models.ts:111-121#"or a plain id like anthropic/claude-opus-4-8"`).
2. **Base resolution + interactive fallback.** The CLI builds the base map
   as `DEFAULT_MODELS` overlaid with the *previous* manifest's models (if
   any), then applies `--models` on top; when running interactively with no
   `--models`, it prompts per role instead, defaulting each prompt to the
   already-resolved value (`src/cli.ts:254-260#"...DEFAULT_MODELS,"`, prompt UI at
   `src/cli.ts:104-146#"return models;"`). Since 0.15.0 the interactive prompt only asks about
   the roles `rolesForProfile(profile)` selects (`src/cli.ts:104-109#"for (const role of roles) {"`
   iterates a `roles` parameter instead of the full `ROLES` list), so a
   `minimal` install is not asked for `explorer`/`task-slicer` models (and,
   since 0.21.0, not for `advisor` either — the same `rolesForProfile`
   scoping picked up the new role automatically, no `cli.ts` change
   required). Since
   0.19.0 the CLI also resolves `tiers` right after models, on the same
   override-vs-persist rule, now via a `--tiers`/`--no-tiers` negatable pair
   with no interactive prompt at all (`src/cli.ts:267-277#"const tiers = opts.tiers ?? previous?.tiers ?? false;"`; see "Effort
   tiers" below).
3. **Manifest.** `runInit` writes the resolved map to
   `.ai/workflow/manifest.json` under `models` (`src/init.ts:578-613#"force: true,"`,
   `desired` object at `:580-588`), alongside `kit`, `version`, `harnesses`,
   `profile`, `tiers` (since 0.19.0), and per-file hashes. On the next run,
   `readInstalledManifest` reads it back and re-validates every value with
   `assertValidModelId`; an invalid stored id is silently dropped (falling
   back to `DEFAULT_MODELS` for that role) rather than crashing
   (`src/init.ts:115-181#"typeof candidate.installedAt ==="`, specifically `:133-142`).
4. **Per-harness frontmatter.** For each selected harness, `runInit` calls a
   `compose*Agent` function per role that turns the resolved model string
   into that harness's frontmatter shape (`src/init.ts:189-250#"permission:"`,
   invocations at `src/init.ts:507-509#"composeClaudeAgent(role, options.models[role]),"` for Claude Code and `:539-542` for
   opencode). Since 0.15.0 those invocations iterate `rolesForProfile(profile)`
   rather than the unconditional `ROLES` list, so a role's preselected model
   is only ever composed into a subagent file when the profile actually
   installs that role, see
   [install-fence-mechanics.md](install-fence-mechanics.md). Since 0.19.0 a
   second, sibling pair of `compose*AgentVariant` functions
   (`src/init.ts:269-280#"disallowedTools: Edit, Write, NotebookEdit"` Claude Code, `:338-357` opencode) composes the
   tier-variant files from the same `readAgentAsset` body; see "Effort
   tiers" below for what differs in their frontmatter.

## Per-harness frontmatter behavior

- **Claude Code.** `composeClaudeAgent` always emits a `model:` line;
  `claudeModelValue` is the identity function, so aliases and full ids pass
  through unchanged (`src/models.ts:88-89#"return (MODEL_ALIASES as string[]).includes(value);"`, `src/init.ts:205-216#"disallowedTools: Edit, Write, NotebookEdit"`). Since
  0.22.0 it also always emits a pinned `effort:` line right after `model:`
  (`TIER_DEFS[DEFAULT_TIER[role]].effort`, `src/init.ts:212#"effort: ${TIER_DEFS[DEFAULT_TIER[role]].effort}"`; medium for
  explorer/task-slicer/implementer, high for reviewer/advisor), covered in
  its own "Pinned default effort (0.22.0)" section below. The read-only
  roles (`explorer`, `reviewer`, and since 0.21.0 `advisor`, per
  `READ_ONLY_ROLES` at
  `src/models.ts:22#"export const READ_ONLY_ROLES: ReadonlySet<Role> = new"`) additionally get
  `disallowedTools: Edit, Write, NotebookEdit` right after `effort:`
  (`src/init.ts:215-216#"disallowedTools: Edit, Write, NotebookEdit"`). Test coverage:
  `test/init.test.ts:102-108#"expect(slicer).toContain("` (`model: sonnet` / `model: opus` present) and
  `:466-512` (per-role alias mix installs correctly for Claude while
  opencode differs, see below).
- **opencode.** opencode needs a fully-qualified `provider/model-id`.
  `opencodeModelValue` (the pure fallback used when the CLI has not already
  resolved a catalog) passes through any value containing `/` and returns
  `undefined` otherwise (`src/models.ts:107-108#"return model.includes("`). The real CLI path is
  richer: when the `opencode` harness is selected, `cli.ts` shells out to
  `opencode models`, parses the catalog (`loadOpencodeCatalog`,
  `src/opencode.ts:236-245#"return [];"`), auto-detects the provider offering Claude
  models (`detectProvider`, `src/opencode.ts:40-64#"return { provider: undefined, ambiguous: false };"`; exactly one candidate
  provider resolves automatically, more than one triggers an "ambiguous,
  pass `--opencode-provider`" warning, none triggers a "no provider found"
  warning), and resolves each alias to the highest-versioned canonical match
  (`resolveAlias`, `src/opencode.ts:115-148#"return best;"`, non-canonical variants like
  `-fast`/`-thinking`/`-mini`/`-latest` deprioritized). `composeOpencodeAgent`
  emits `model:` only when a resolved value exists; otherwise the line is
  omitted entirely so the subagent inherits the session/default model
  (`src/init.ts:230-250#"permission:"`, comment at `:241-242`). Since 0.22.0 it also takes
  an `effortLine` parameter, computed once by the caller via
  `opencodeEffortLine(DEFAULT_TIER[role], modelValue)` (`src/init.ts:535-537#"modelValue,"`)
  and emitted right after `model:` when the model was resolved; see "Pinned
  default effort (0.22.0)" below for the dispatch rule. Nested-path providers
  such as `openrouter/anthropic/claude-...` are never alias-auto-resolved and
  must be passed as fully-qualified `--models` entries (`README.md:206-209`,
  confirmed by `test/init.test.ts:514-537#"expect(slicer).not.toContain("`, `openrouter/some-model` passes
  through unchanged). Confirmed end-to-end when the `opencode` binary is
  absent: every role's file omits `model:` (`test/init.test.ts:1896-1904#"${role}.md must not contain model:"`,
  the loop is `for (const role of ROLES)` so it already covers `advisor` for
  free, no test edit needed for the 0.21.0 role addition; an omitted `model:`
  also means `opencodeEffortLine` short-circuits to no effort line, so this
  case is unaffected by the 0.22.0 pin), and the disambiguation hint goes to
  stderr, never stdout (`test/init.test.ts:1910-1916#"expect(result.stdout).not.toContain("`).
- **Codex.** Codex gets no per-role subagent definition files at all: `init`
  installs only `.agents/skills/orchestrator-workflow/SKILL.md` for the
  `codex` harness (`src/init.ts:524-525#", SKILL_NAME,"`); there is no `model:` surface for
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
(`src/cli.ts:267-277#"const tiers = opts.tiers ?? previous?.tiers ?? false;"`; the code comment there states explicitly why: tiers
is opt-in/off via the flags only). A fix-round-1 correction on the initial
0.19.0 release (review finding M2) added commander's negatable-option
counterpart, `--no-tiers`, so a re-run can explicitly turn a previously
installed `tiers: true` back off; before the fix `--tiers` was one-way and
the only route back to `tiers: false` was hand-editing the manifest.

**Tier data (`src/models.ts:157-211#"large:"`).** `Tier` is
`"low" | "medium" | "high" | "xhigh"` (`:162`). `ROLE_TIERS` (`:169-175`) is
which tiers each role gets a variant for: explorer and task-slicer
`low, medium, high`; implementer all four; reviewer `medium, high, xhigh`;
since 0.21.0, advisor `high, xhigh` (the smallest tier list of any role —
its default already sits at `high`, one step below the reviewer's default
`--tiers` ceiling, so it only ever gets one variant, `-xhigh`).
`DEFAULT_TIER` (`:182-188`) is the tier each role's plain file already
corresponds to (`medium` for explorer/task-slicer/implementer, `high` for
reviewer and, since 0.21.0, advisor), the tier a variant is never rendered
for since that would both collide with and duplicate the default file
(`init.ts:513-516#"composeClaudeAgentVariant(role, tier),"` Claude Code,
`:545` opencode, both a `continue` guarded by
`tier === DEFAULT_TIER[role]`, role-generic code unchanged by the role
addition). `TIER_DEFS` (`:200-205`) maps each tier to a
`ModelClass` (`"small" | "medium" | "large"`, `:190`) and its requested
`effort` value (the tier's own name). `CLASS_MODELS` (`:208-212`) maps each
class to a `ModelAlias`: `small`->`haiku`, `medium`->`sonnet`,
`large`->`opus`. `Tier`, `ModelClass`, and all four maps are re-exported
from `src/index.ts` since fix-round-1 (review finding L2), the same
public-surface treatment `Profile`/`PROFILES` already had; the two
previously-unused `TIERS`/`isTier` exports that finding also flagged were
dropped outright rather than forced into a real call site, since the
`tiers` field they would degrade is a plain `boolean`, not a `Tier` value —
`isTier` had nothing to validate.

**Composition.** `composeClaudeAgentVariant` (`init.ts:269-280#"disallowedTools: Edit, Write, NotebookEdit"`) is the
tier-variant sibling of `composeClaudeAgent`: same frontmatter shape plus
`model: <CLASS_MODELS[modelClass]>` and `effort: <tier>` (in that order,
right after `description:`), and the same `disallowedTools:` line for
`READ_ONLY_ROLES`. `composeOpencodeAgentVariant` (`init.ts:338-357#"permission:"`) is the
opencode sibling; its effort line is decided by `opencodeEffortLine`
(`init.ts:315-328#"reasoningEffort: ${TIER_DEFS[tier].effort}"`, renamed from `opencodeVariantEffortLine` in 0.22.0 since
the function is no longer variant-only, see "Pinned default effort
(0.22.0)" below), which dispatches on model *family*, not provider id,
a fix-round-1 correction (review finding M4): the original 0.19.0 release
keyed the check on the literal provider string `"anthropic"`, so a Claude
model fronted by a different provider (`github-copilot/claude-sonnet-4.6`,
or the nested `openrouter/anthropic/claude-sonnet-4.6`) silently fell
through to the `reasoningEffort:` branch instead of the `variant:` one.
`isClaudeFamilyModel` (`init.ts:295-299#"return remainder.includes("`) now treats a resolved model id as
Claude-family when the segment after the first `/` contains `claude-`, or
the id starts with `anthropic/` outright, regardless of which provider
fronts it. Claude-family models get `variant: high` for the `high` tier and
`variant: max` for `xhigh`; `low`/`medium` on a Claude-family model get no
effort line at all (Anthropic's opencode `variant:` option does not
distinguish an effort below `high`, a documented collapse, not a bug: the
variant still gets its class's `model:` line). A non-Claude-family model
behind the `ollama` provider prefix, a *resolved* id with no provider
prefix at all (no `/`, so `provider` comes out `undefined` the same as the
Ollama branch checks against, review round 3, R3-L2/R3-L4, previously
missing from this sentence), and any tier whose class model could not be
resolved to a fully-qualified id at all (`modelValue` is `undefined`), all
get no effort line. Every other non-Claude-family, non-Ollama,
provider-qualified model gets a plain `reasoningEffort: <tier>` line,
`xhigh` included (D8: not mapped down to `high`, not dropped, it is part of
opencode's documented built-in OpenAI-style variant range). Both variant
composers share `tierDescriptionSuffix` (`init.ts:256-260#"${asset.description} (Effort tier: ${tier}.)"`), which appends
`" (Effort tier: <tier>.)"` to the role's own description. Since fix-round-2
(review finding R2-L1), `composeOpencodeAgentVariant` takes the decided
effort line as an explicit fourth parameter instead of recomputing it via a
second internal call to `opencodeEffortLine`: the caller (`runInit`'s
opencode tier loop) computes `effortLine` exactly once, right after the
resolved-model skip check that decides whether to write the variant at all
(that check depends only on `variantModelValue`, see "Unresolved-class
guard" below, not on `effortLine`), and hands the single computed value to
the composer instead of letting it recompute the same value a second time
(review round 3, R3-L2: an earlier draft of this paragraph and the
composer's own JSDoc wrongly attributed the fourth-parameter change to the
composer "needing" `effortLine` to decide whether to skip the write; it
does not decide that at all, the caller's skip check runs first and does
not consult `effortLine`, so the real motivation is a single source of
truth for the value, not a skip decision).

**Unresolved-class guard (fix-round-1, review finding M1; hardened
fix-round-2, review finding R2-M3).** Before the fix-round-1 fix, a tier's
class model that failed to resolve (an empty opencode catalog, or
`--models` supplying already fully-qualified role ids that never trigger
class resolution at all) silently rendered a no-op opencode variant file
carrying neither `model:` nor an effort line, distinguishable from the base
file only by diffing the two, and with no warning anywhere. Two changes
close this. First, `cli.ts`'s tier-class resolution loop (`:291-322`) now
writes one warning line to stderr per unresolved class (`small`/`medium`/
`large`), mirroring `resolveOpencodeModels`'s own per-role warning style
(`opencode.ts:162-225#"return { resolved, warnings };"`) rather than staying silent. Second, `runInit`'s
opencode tier loop (`init.ts:543-570#"effortLine,"`) now checks whether the variant's
class model resolved at all (`variantModelValue !== undefined`,
`init.ts:548-560#"// rules in opencodeEffortLine above."`) and skips the write, and the manifest ledger entry,
entirely when it did not, so an unresolved class produces zero tier-variant
files for opencode instead of nine indistinguishable empty ones.

Fix-round-2 corrected two things about the first half of this guard, the
warning text itself. The fix-round-1 wording read `Warning: Tier model
class "<class>" (alias "<alias>"): <reason>; model: will be omitted for
its effort-tier variants.`, which was already false the moment fix-round-1
shipped: fix-round-1's own second half (the skip in `runInit` above) means
the variant file is never written at all, not written with just its
`model:` line missing, so "model: will be omitted" understated the real
effect. The wording also never named which harness it applied to, reading
as if it could affect Claude Code variants too, when Claude Code's
`model:` line resolves from a plain alias (`haiku`/`sonnet`/`opus`) and
needs no live catalog lookup at all. The corrected wording
(`cli.ts:291-322#"// and need no live catalog lookup, so they are unaffected)."`) is `Warning: Tier model class "<class>" (alias
"<alias>") could not be resolved to an opencode model id (<reason>); no
opencode effort-tier variant files will be rendered for this class (Claude
Code variants are unaffected).`, stating both the real rendering effect and
the real harness scope; `test/init.test.ts:1929-1950#"expect(agents.sort()).toEqual(["` asserts the full
wording verbatim (a review-round-2 strengthening of the fix-round-1 tests,
which had only asserted the model class name appeared somewhere in
stderr). README's opencode-effort prose and the CHANGELOG 0.19.0 entry
carried the same two stale claims (the pre-M4 provider-keyed framing and
this pre-fix-round-1 "model: will be omitted" phrasing); both were
corrected in the same fix-round-2 pass, and
`test/docs-consistency.test.ts`'s new "README opencode-effort prose uses
family terms" `describe` (review finding R2-M1) guards the README half of
that correction against regressing back to either stale claim.

**Rendering (`init.ts:504-570#"effortLine,"`).** For each harness and each role
`rolesForProfile(profile)` selects, `runInit` writes the base file exactly
as it always has (now including its own pinned default effort, see "Pinned
default effort (0.22.0)" below), then, only `if (tiers)`, loops
`ROLE_TIERS[role]` skipping the role's `DEFAULT_TIER` and writes
`<role>-<tier>.md` (`:506-516` Claude Code, `:539-569` opencode, the
opencode loop now carrying the unresolved-class skip described above). The
base file's own composition call takes no `tiers`-flag input at all, so a
tiers-off install renders byte-identical output to a tiers-on install (not,
since 0.22.0, to pre-0.19.0: the base file's own content changed with the
0.22.0 pin, see below): a structural, not just tested, guarantee against a
silent model downgrade (the reviewer's `opus` default in particular),
pinned with a content assertion (not just a file-set check) on the
legacy-manifest path since fix-round-1 (review finding L1,
`test/init.test.ts:1208-1224#"effort: medium"`, five-line frontmatter including the 0.22.0
`effort: medium` line) plus, since 0.22.0, a dedicated two-target diff test
(`test/init.test.ts:1229-1263#"tiers: false,"`) that installs into two separate targets,
one with `tiers: true` and one with `tiers: false`, and asserts every
role's default file is byte-for-byte identical between them on both
harnesses. With `--profile full` and tiers on, that is 5 base files plus 10
variants since 0.21.0 (was 4 base files plus 9 variants: 13 total, before
advisor added its own base file plus one `xhigh` variant): 15 total per
harness (`test/init.test.ts:1300-1345#"advisor's only variant is xhigh"` pins the count and, as a dedicated
anti-downgrade check, that `reviewer.md` and, since 0.21.0, `advisor.md`
still carry `model: opus`, now with `effort: high` rather than no `effort:`
line since 0.22.0). opencode's variant `model:` values come from a new,
separate resolution pass keyed by `ModelClass` instead of `Role`
(`InitOptions.opencodeClassModels`, `init.ts:62-70#"opencodeClassModels?: Record<ModelClass, string | undefined>;"`; resolved in `cli.ts` at
`:291-322`, mirroring the existing per-role opencode resolution just above
it at `cli.ts:286-294#"process.stderr.write("`). The Claude-family-`variant:` and Ollama-no-effort-field
provider-branch outcomes are pinned at `test/init.test.ts:1504-1537#"expect(implementerLow).not.toContain(" and test/init.test.ts:1541-1559#"model: ollama/llama3"`; a
resolved class id with no provider prefix at all (no `/`) reaches the same
no-effort-field outcome as Ollama but via `opencodeEffortLine`'s
`provider === undefined` branch rather than its `provider === "ollama"`
one, a case review round 3 (R3-L2/R3-L4) found missing from both this
doc's own prose and README's, pinned separately at `:1448-1474`; the plain
`reasoningEffort:` outcome for every other non-Claude-family, non-Ollama,
provider-qualified model is pinned at `:1476-1496`. The fix-round-1
family-dispatch correction adds two more cases pinning that the `variant:`
rule follows the model regardless of provider: `github-copilot/claude-sonnet-4.6`
(`:1498-1521`) and the nested `openrouter/anthropic/claude-sonnet-4.6`
(`:1523-1546`) both still resolve to `variant:`, not `reasoningEffort:`. The
unresolved-class guard is pinned at `:1548-1586` (an omitted
`opencodeClassModels` renders zero variant files and leaves no ledger
entry), and a standalone invariant test (`:1588-1592`) asserts
`DEFAULT_TIER[role]` is always a member of `ROLE_TIERS[role]` for every
role: nothing in the type system enforces that relationship, so a
hand-edited `models.ts` could otherwise define a default tier the role's
own tier list does not carry.

**Pinned default effort (0.22.0, agent-dx task T-001).** Before 0.22.0, the
unsuffixed default agent file carried a `model:` line but no `effort:` line
at all, so a default subagent spawn silently inherited whatever effort the
orchestrator's own session happened to run at (a `high`-effort orchestrator
session made every default spawn run at `high` too, regardless of the
role's own intended weight). 0.22.0 closes that gap by having
`composeClaudeAgent` (`init.ts:205-216#"disallowedTools: Edit, Write, NotebookEdit"`) and `composeOpencodeAgent`
(`init.ts:230-250#"permission:"`) add the role's own
`` `effort: ${TIER_DEFS[DEFAULT_TIER[role]].effort}` `` (Claude Code,
`init.ts:212#"effort: ${TIER_DEFS[DEFAULT_TIER[role]].effort}"`) or the equivalent opencode effort line (via
`opencodeEffortLine(DEFAULT_TIER[role], modelValue)`, computed once per role
at the call site, `init.ts:535-537#"modelValue,"`, and passed in as a parameter the same
way `composeOpencodeAgentVariant` already took its own effort line since
fix-round-2) unconditionally, for every install regardless of `--tiers`.
Since `TIER_DEFS[DEFAULT_TIER[role]].effort` is `"medium"` for
explorer/task-slicer/implementer and `"high"` for reviewer/advisor, this
renders as `effort: medium`/`effort: high` for Claude Code, and for
opencode follows the exact same family-based dispatch tier variants already
used (see "Composition" above): a Claude-family model gets `variant: high`
for reviewer/advisor's default file and no effort field at all for the
three medium-default roles' default files (opencode's `variant:` option
still does not distinguish an effort below `high`), a non-Claude-family
provider-qualified model gets `reasoningEffort: medium`/`reasoningEffort:
high`, and Ollama, a provider-less id, or an unresolved model gets no
effort field either way, identical to the tiers-off era's own output on
that specific axis. `opencodeVariantEffortLine` was renamed to
`opencodeEffortLine` in the same commit since the function is no longer
variant-exclusive; its own dispatch logic is unchanged. Test coverage:
`test/init.test.ts:1375-1381#"// no-effort-pin era output byte for byte on this axis."` (opencode default files: reviewer/advisor get
`variant: high` on an anthropic-resolved model, the three medium-default
roles get no effort field at all, matching the pre-0.22.0 byte shape on
that axis) plus the legacy-frontmatter and two-target byte-identity tests
cited above. `README.md`'s "Effort tiers" section gained a new "Every
default file carries its own pinned effort, independent of `--tiers`"
paragraph stating the same rule (`README.md:220-235`), and the CHANGELOG
0.22.0 entry leads with this behavior change since it is user-visible and
session-effort-dependent, not just an additive feature. `agents-md-section.md`'s
Scaling delegation bullet list gained a dedicated bullet (deliberately
sitting outside the pre-existing "When tier variants are installed..."
tiers-gated bullet, so it cannot be misread as `--tiers`-only) and
`SKILL.md` step 6 gained a matching parenthetical on the implementer tier
choice; both are pinned by a dedicated, derivation-based
`test/docs-consistency.test.ts` `describe` (see "Docs-consistency pins"
below) rather than a hand-maintained role list, so a future role addition
or a wrong effort claim in either doc fails there instead of drifting
silently.

**Manifest and re-install.** The chosen value is recorded in a new `tiers`
boolean on `.ai/workflow/manifest.json` (`Manifest.tiers`, `init.ts:83-84#"tiers: boolean;"`).
A manifest written before tiers existed (no `tiers` key) degrades to
`false` (`init.ts:166-170#"const tiers = typeof candidate.tiers ==="`), the same per-field-degradation style already
used for a missing `profile` field just above it (`:158-164`): a legacy
manifest never rendered variant files, so `false` is the only value
consistent with what is actually on disk. `cli.ts` resolves the flag with
the same override-vs-persist rule as `--profile`/`--models`, but with no
interactive branch: `opts.tiers ?? previous?.tiers ?? false` (`cli.ts:277#"const tiers = opts.tiers ?? previous?.tiers ?? false;"`).
This is the fix-round-1 form (review finding M2); the original 0.19.0
release read `opts.tiers ? true : (previous?.tiers ?? false)`, which had no
way to express an explicit "turn it off" short of hand-editing the
manifest, since commander only ever set `opts.tiers` to `true` or left it
`undefined` — there was no negated flag to produce `false`. commander's
negatable-option pairing (`--tiers` / `--no-tiers` declared under the same
`"tiers"` option name, `cli.ts:180-186#"explicitly turn effort-tier subagent variants off, overriding a previously installed --tiers value"`) resolves `opts.tiers` to `true`
when `--tiers` is passed, `false` when `--no-tiers` is passed, and
`undefined` when neither is passed; verified end-to-end against the
installed commander version rather than assuming the pairing behavior:
`test/init.test.ts:1796#"no previous manifest to persist"` (`--no-tiers`
on a fresh install with no previous manifest to persist) and
`test/init.test.ts:1808-1825#"now untracked after tiers were turned off"`
(the true->false transition on a re-run). An
explicit `--tiers` or `--no-tiers` always turns it on or off; a plain
re-run (neither flag) keeps whatever the previous install had; a fresh
install with no prior manifest defaults to off. A `tiers: true -> false`
transition now leaves the same kind of leftover-file note a
`full -> minimal` profile downgrade does (`init.ts:442-452#"now untracked after tiers were turned off"`, review finding
M2; before the fix this transition was silent, see
[install-fence-mechanics.md](install-fence-mechanics.md)), and a
`full -> minimal` downgrade that also had `tiers: true` now notes the
dropped roles' tier-variant files too, not just their base files
(`init.ts:417-428#"now untracked after the full -> ${profile} profile downgrade; run"`, review finding M3;
`test/init.test.ts:883-920#"The variant files themselves are untouched, only untracked, same as"` pins the note count, since 0.21.0 asserting 8
notes rather than 6 for the base-plus-tiers case — advisor became a third
dropped role, contributing 1 base-file note plus 1 non-default-tier note of
its own, purely from `ROLES` growing by one in `src/models.ts`, no code
change of its own). Since fix-round-2 (review
finding R2-M2), both of these note code paths only ever push a note for a
path that is actually a key of `previous.files`, and both iterate
`previous.harnesses` rather than the current run's `options.harnesses`, so
a role or harness that never actually had a file written for it (an
unresolved opencode tier class, or a harness just added this run) is never
misreported as a leftover, and a real leftover under a harness this run
happens to drop is still reported; see
[install-fence-mechanics.md](install-fence-mechanics.md)'s "What `init`
writes" section for the full mechanics, and
`test/init.test.ts:941-1005#"The .opencode harness was only just added this run and was never"`'s dedicated `describe` for both cases exercised
directly. That block's own mutation probe covered only the *tiers-off* note
loop's ledger gate; review round 3 (R3-L1) added a sibling
`test/init.test.ts:1029-1063#"note) => !note.includes("` `describe` proving the ledger gate inside the
*full -> minimal profile-downgrade* loop's own tier-variant sub-loop
(`init.ts` ~423) the same way, after a mutant that always pushed that note
(`if (true)` in place of the `previous.files` check) survived the full
suite untested. Variant files themselves still flow through the same
`installKitFile` hash ledger as every other kit-owned file (`init.ts:460-480#"installFile(report, path, content, { force });"`,
unchanged by this feature), so idempotence, conflict detection, and
`uninstall` (see [install-fence-mechanics.md](install-fence-mechanics.md))
all cover them automatically with no tier-specific removal code.

README documents `--tiers`/`--no-tiers`, the role/tier table, the tier ->
model class/effort table, and the opencode effort behavior in its own
"Effort tiers" section, including a warning that `CLAUDE_CODE_EFFORT_LEVEL`
(a harness environment variable, wire-verified 2026-08-19 to override
frontmatter `effort:` on every installed agent when set) beats the
frontmatter `effort:` this feature adds, plus (since fix-round-1) the
tiers-on-to-off leftover-note behavior mirroring the profile-downgrade one.
The opencode-effort prose itself was rewritten in fix-round-2 (review
finding R2-M1): it still described the pre-fix-round-1 provider-keyed
dispatch and the pre-fix-round-1 "model: will be omitted" unresolved-class
behavior, both already false once fix-round-1 landed but never corrected in
README at the time; it now uses family terms ("Claude-family models",
matching `isClaudeFamilyModel`) and states the real unresolved-class effect
(no variant file rendered at all). The CHANGELOG 0.19.0 entry carried the
same two stale claims and was corrected the same way in the same pass.
`INSTALL-AGENT.md` documents both flags in its init question and command
example and states plainly that the manual fallback path never renders
tier-variant files.

## Re-install behavior

A re-run with no `--models` reuses the previously chosen models rather than
resetting to shipped defaults: `models = { ...DEFAULT_MODELS,
...(previous?.models ?? {}) }` in `src/cli.ts:254-256#"if (interactive) profile = await promptProfile(profile);"`. The same
override-vs-persist rule now also covers `--profile` (`src/cli.ts:242-252#"if (opts.profile) {"`)
and, since 0.19.0, `--tiers`/`--no-tiers` (`src/cli.ts:267-277#"const tiers = opts.tiers ?? previous?.tiers ?? false;"`, see
"Effort tiers" above): a plain re-run keeps the previously installed value
for each, an explicit flag overrides it. Test:
`test/init.test.ts:1146-1165#"model: haiku"` runs `init --models implementer=haiku`, then a
plain `init` re-run, and asserts the manifest and the installed
`.claude/agents/implementer.md` both still carry `haiku`. A hand-edited or
damaged manifest degrades gracefully per-field: a non-object `harnesses`
falls back to `[]` filtered against known harnesses, each model id is
re-validated, with invalid entries dropped back to that role's default, a
missing `profile` field degrades to `"full"` rather than `"minimal"`, and
(since 0.19.0) a missing `tiers` field degrades to `false`
(`src/init.ts:115-181#"typeof candidate.installedAt ==="`; end-to-end proof at `test/init.test.ts:278-308#"expect(manifest.models.implementer).toBe("`,
where a malformed `reviewer: 'opus: "x"'` is dropped to `opus` while a valid
sibling `implementer: "haiku"` survives; the `profile`-fallback proof is
`test/init.test.ts:762-791#"should exist under the full-profile fallback"`, see
[install-fence-mechanics.md](install-fence-mechanics.md) for why that test
starts from a target with no prior `full` install; the `tiers`-fallback
proof is `test/init.test.ts:1170-1215#"explorer.md has no frontmatter block"`, see "Effort tiers" above).

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
fields and keyed by all five roles under `full` since 0.21.0 (was four)
(`INSTALL-AGENT.md:199-221`; under `minimal`, `models` only needs the
`implementer` and `reviewer` keys, `INSTALL-AGENT.md:223-227`). That same
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
verbatim (`assets/agents-md-section.md:146-150#"harness supports per-agent models, in the subagent definitions themselves."`): "The orchestrator runs on
the session's main model. Use the strongest reasoning model available,"
plus "Per-role model preferences ... are recorded in
`.ai/workflow/manifest.json` and, where the harness supports per-agent
models, in the subagent definitions themselves." README states the same
rule at `README.md:172-174`.

## Docs-consistency pins (model-specific)

`test/docs-consistency.test.ts` guards enumeration sites so a role
added to `ROLES` (`src/models.ts:1-8#"export const ROLES: Role[] = ["`) cannot silently go undocumented in
model-facing docs, each targeting the specific list rather than the whole
file — the guard proved itself for real at 0.21.0: every site below failed
red on the advisor addition until each listed doc was updated to name the
fifth role, the same "did I update every place a role is enumerated" check
the "Solution-neutral notes" section below describes.

- README's model-preselection table has one row per role
  (`test/docs-consistency.test.ts:37-38#"expect(readmeMd).toMatch(new RegExp("`, matches `^\| <role> \|`).
- `INSTALL-AGENT.md`'s `--models` example names every role
  (`:52-56`, checks for `<role>=<model>` per role).
- `INSTALL-AGENT.md`'s manifest example JSON has one `models` key per role
  (`:58-68`, parses the fenced JSON block and compares sorted keys).
- `agents-md-section.md`'s "Per-role model preferences (...)" parenthetical
  lists every role (`:70-79`).

A fifth, adjacent test guards the read-only-role brace lists
(`agents/{explorer,task-slicer,implementer,reviewer,advisor}.md`) in
`INSTALL-AGENT.md` (`:43-50`); it is role-enumeration generally, not
model-specific, but shares the same drift-prevention purpose.

Since 0.19.0, a standalone `describe` (`:1151-1208`) guards a tier-specific
enumeration site: README's "Effort tiers" role/tier table against
`ROLE_TIERS` and `DEFAULT_TIER` directly, per role and column
(tiers-available list order, default-tier value, and a row-count check with
no extras or omissions), so a tier added to or removed from either
`models.ts` map without a matching table edit fails loudly the same way a
role addition already does for the four sites above — since 0.21.0 this
also covers the advisor row (`ROLE_TIERS.advisor = ["high", "xhigh"]`,
`DEFAULT_TIER.advisor = "high"`), the test iterating `ROLES` so the new
per-role assertions came for free from the `models.ts` addition alone, no
test edit required. Since fix-round-1
(review finding L4), a second, sibling `describe` (`:1221-1286`) guards
README's other tier-shaped table, Tier -> model class -> model alias ->
requested effort, against `TIER_DEFS`/`CLASS_MODELS` directly, the same
way; before this fix nothing guarded that second table, so it could drift
from its source maps silently (this table is keyed by `Tier`, not `Role`,
so it is unaffected by the role count itself). Since fix-round-2 (review finding R2-M1), a
third, site-specific `describe` (`:1275-1321`, appended at the file's end)
guards the opencode-effort prose in README's "Effort tiers" section
directly: it isolates that prose block by its own lead-in phrase and the
next bold lead-in that follows it, then asserts the prose contains the
family-based framing ("Claude-family") and does not contain either of the
two stale claims R2-M1 corrected (the "provider-dependent" framing and the
scope phrase `` `anthropic/...` model ids ``, plus the pre-fix-round-1
"model: will be omitted" wording), so a regression back to either stale
claim fails a targeted assertion instead of only showing up as an
unguarded prose diff.

Since 0.22.0, a fourth, site-specific `describe`
(`test/docs-consistency.test.ts:1759-1904#"must not sit inside the tiers-gated clause"`) guards the pinned-default-effort
policy in `agents-md-section.md`'s Scaling delegation bullet list and
`SKILL.md` step 6: a derivation-based check (not a hand-maintained role
list, the same discipline the 0.20.0 tier-selection-policy guard above
uses) parses the medium/high role split the prose claims and asserts it
against `ROLES.filter((role) => TIER_DEFS[DEFAULT_TIER[role]].effort ===
"medium"/"high")` directly, plus a positional check that the bullet sits
strictly after the pre-existing tiers-gated bullet's own "use the default."
close, so the pinned-default-effort bullet cannot be folded back inside the
`--tiers`-conditional framing without failing a dedicated assertion.

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
