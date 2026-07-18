---
type: module
title: Model preselection
description: How each subagent role's model is chosen, flows through the CLI and manifest into per-harness frontmatter, and survives re-installs.
tags: [models, cli, manifest, per-role, harness-adapters]
timestamp: 2026-07-18T12:00:00Z
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
the session's main model (`src/models.ts:23-25`, policy restated below).

Defaults (`src/models.ts:27-32`, documented in
`README.md:124-129`):

| Role | Default | Rationale (README) |
|---|---|---|
| explorer | `sonnet` | read-only terrain mapping is broad reading, not deep reasoning |
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |

`ModelAlias` is `"sonnet" | "opus" | "haiku"` (`src/models.ts:19-21`); a
role's value may also be a full model id or, for opencode, a fully-qualified
`provider/model-id` string (see below).

## Flow: `--models` → manifest → subagent frontmatter

1. **CLI input.** `orchestrator-workflow init` accepts `--models
   "role=model,role=model"`, parsed by `parseModelsSpec` on top of a base
   map (`src/models.ts:76-101`). Unknown roles and malformed pairs throw;
   each value is validated by `assertValidModelId`, which rejects empty
   strings, leading/trailing whitespace, and any of `:"'#\n\\` since the
   value is interpolated as a plain YAML scalar into subagent frontmatter
   (`src/models.ts:61-70`).
2. **Base resolution + interactive fallback.** The CLI builds the base map
   as `DEFAULT_MODELS` overlaid with the *previous* manifest's models (if
   any), then applies `--models` on top; when running interactively with no
   `--models`, it prompts per role instead, defaulting each prompt to the
   already-resolved value (`src/cli.ts:195-200`, prompt UI at
   `src/cli.ts:67-109`).
3. **Manifest.** `runInit` writes the resolved map to
   `.ai/workflow/manifest.json` under `models` (`src/init.ts:267-294`),
   alongside `kit`, `version`, `harnesses`, and per-file hashes. On the next
   run, `readInstalledManifest` reads it back and re-validates every value
   with `assertValidModelId`; an invalid stored id is silently dropped
   (falling back to `DEFAULT_MODELS` for that role) rather than crashing
   (`src/init.ts:82-134`, specifically 100-111).
4. **Per-harness frontmatter.** For each selected harness, `runInit` calls a
   `compose*Agent` function per role that turns the resolved model string
   into that harness's frontmatter shape (`src/init.ts:140-176`,
   invocations at `src/init.ts:236-263`).

## Per-harness frontmatter behavior

- **Claude Code.** `composeClaudeAgent` always emits a `model:` line;
  `claudeModelValue` is the identity function, so aliases and full ids pass
  through unchanged (`src/models.ts:42-44`, `src/init.ts:140-154`). The
  read-only roles (`explorer`, `reviewer`, per `READ_ONLY_ROLES` at
  `src/models.ts:14-17`) additionally get
  `disallowedTools: Edit, Write, NotebookEdit` right after `model:`
  (`src/init.ts:149-151`). Test coverage:
  `test/init.test.ts:98-104` (`model: sonnet` / `model: opus` present) and
  `:456-501` (per-role alias mix installs correctly for Claude while
  opencode differs, see below).
- **opencode.** opencode needs a fully-qualified `provider/model-id`.
  `opencodeModelValue` (the pure fallback used when the CLI has not already
  resolved a catalog) passes through any value containing `/` and returns
  `undefined` otherwise (`src/models.ts:53-55`). The real CLI path is
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
  (`src/init.ts:156-176`, comment at 166-167). Nested-path providers such as
  `openrouter/anthropic/claude-...` are never alias-auto-resolved and must be
  passed as fully-qualified `--models` entries (`README.md:147-150`,
  confirmed by `test/init.test.ts:503-526`, `openrouter/some-model` passes
  through unchanged). Confirmed end-to-end when the `opencode` binary is
  absent: every role's file omits `model:` (`test/init.test.ts:705-717`),
  and the disambiguation hint goes to stderr, never stdout
  (`test/init.test.ts:719-726`).
- **Codex.** Codex gets no per-role subagent definition files at all: `init`
  installs only `.agents/skills/orchestrator-workflow/SKILL.md` for the
  `codex` harness (`src/init.ts:247-249`); there is no `model:` surface for
  Codex because "there is no standardized project-level subagent
  definition" and the skill instructs running roles inline instead
  (`README.md:104`).

## Re-install behavior

A re-run with no `--models` reuses the previously chosen models rather than
resetting to shipped defaults: `models = { ...DEFAULT_MODELS,
...(previous?.models ?? {}) }` in `src/cli.ts:195-198`. Test:
`test/init.test.ts:631-651` runs `init --models implementer=haiku`, then a
plain `init` re-run, and asserts the manifest and the installed
`.claude/agents/implementer.md` both still carry `haiku`. A hand-edited or
damaged manifest degrades gracefully per-field: a non-object `harnesses`
falls back to `[]` filtered against known harnesses, and each model id is
re-validated, with invalid entries dropped back to that role's default
(`src/init.ts:82-134`; end-to-end proof at `test/init.test.ts:267-298`,
where a malformed `reviewer: 'opus: "x"'` is dropped to `opus` while a valid
sibling `implementer: "haiku"` survives).

The manual/agent install path (`INSTALL-AGENT.md`) mirrors this contract by
hand: step 2 tells the agent to *ask* the operator for harnesses and
per-role models rather than guess, suggesting the same defaults
(`INSTALL-AGENT.md:23-26, 76-82`); step 4's manual fallback spells out
byte-precise placement (`model:` line directly after `description:` for
Claude Code, `INSTALL-AGENT.md:106-113`; conditional `model:` line only for
fully-qualified opencode ids, `INSTALL-AGENT.md:114-140`) and an example
`manifest.json` shape keyed by all four roles (`INSTALL-AGENT.md:141-158`).

## Orchestrator-runs-on-session-model policy

The installed `AGENTS.md` policy section carries a `### Models` subsection
verbatim (`assets/agents-md-section.md:99-105`): "The orchestrator runs on
the session's main model. Use the strongest reasoning model available,"
plus "Per-role model preferences ... are recorded in
`.ai/workflow/manifest.json` and, where the harness supports per-agent
models, in the subagent definitions themselves." README states the same
rule at `README.md:131-133`.

## Docs-consistency pins (model-specific)

`test/docs-consistency.test.ts` guards four enumeration sites so a role
added to `ROLES` (`src/models.ts:3-8`) cannot silently go undocumented in
model-facing docs, each targeting the specific list rather than the whole
file:

- README's model-preselection table has one row per role
  (`test/docs-consistency.test.ts:28-32`, matches `^\| <role> \|`).
- `INSTALL-AGENT.md`'s `--models` example names every role
  (`:43-47`, checks for `<role>=<model>` per role).
- `INSTALL-AGENT.md`'s manifest example JSON has one `models` key per role
  (`:49-59`, parses the fenced JSON block and compares sorted keys).
- `agents-md-section.md`'s "Per-role model preferences (...)" parenthetical
  lists every role (`:61-70`).

A fifth, adjacent test guards the read-only-role brace lists
(`agents/{explorer,task-slicer,implementer,reviewer}.md`) in
`INSTALL-AGENT.md` (`:34-41`); it is role-enumeration generally, not
model-specific, but shares the same drift-prevention purpose.

## Solution-neutral notes for future edits

Any change to `ROLES`, `DEFAULT_MODELS`, or the harness list should expect
`test/docs-consistency.test.ts` to fail loudly in the corresponding doc
before a fix is complete; treat that suite as the authoritative check for
"did I update every place a role/model is enumerated," not just the four
docs quoted above.

See [subagent-contracts-superset.md](subagent-contracts-superset.md) for the
role I/O contracts these models are attached to, and
[install-fence-mechanics.md](install-fence-mechanics.md) for how the
composed frontmatter files are written, conflict-detected, and removed on
uninstall. [index.md](index.md) has the bundle overview.
