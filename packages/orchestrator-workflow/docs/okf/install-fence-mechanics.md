---
type: module
title: Install fence mechanics
description: How orchestrator-workflow's installer writes, fences, updates, and removes its surface in a target repo.
tags: [installer, marker-fence, manifest, agents-md, harness-adapters, uninstall]
timestamp: 2026-07-16T12:07:00Z
sources:
  - packages/orchestrator-workflow/src/init.ts
  - packages/orchestrator-workflow/src/uninstall.ts
  - packages/orchestrator-workflow/src/writers.ts
  - packages/orchestrator-workflow/src/assets.ts
  - packages/orchestrator-workflow/src/models.ts
  - packages/orchestrator-workflow/src/detect.ts
  - packages/orchestrator-workflow/src/cli.ts
  - packages/orchestrator-workflow/assets/agents-md-section.md
  - packages/orchestrator-workflow/test/init.test.ts
  - packages/orchestrator-workflow/test/uninstall.test.ts
  - packages/orchestrator-workflow/test/opencode.test.ts
  - packages/orchestrator-workflow/INSTALL-AGENT.md
  - packages/orchestrator-workflow/README.md
---

# Install fence mechanics

`runInit` (src/init.ts:178) is the single entry point for both a fresh install and a re-run; there is no separate "update" mode, idempotency and upgrade are properties of how each individual write is decided.

## What `init` writes

- `.ai/workflow/templates/00-goal.md` through `06-handoff.md`, one per name from `listTemplateNames()` (init.ts:216-221), plus an empty `.ai/runs/.gitkeep` (init.ts:222). See [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md) for how these templates become run directories.
- The marker-fenced `## Agentic Coding Workflow` section in `AGENTS.md`, installed unconditionally regardless of harness selection (init.ts:224-232): Codex and opencode read `AGENTS.md` natively, Claude Code gets it via an import, so the section is always written.
- Per selected harness (`options.harnesses`):
  - **claude**: `.claude/skills/orchestrator-workflow/SKILL.md` and `.claude/agents/{explorer,task-slicer,implementer,reviewer}.md` (init.ts:236-244), plus the `CLAUDE.md` import (below).
  - **codex**: only `.agents/skills/orchestrator-workflow/SKILL.md` (init.ts:247-249). No per-role agent files are written; README.md:104 states Codex has no standardized project-level subagent definition, the skill instructs running the roles inline instead.
  - **opencode**: `.opencode/skills/orchestrator-workflow/SKILL.md` and `.opencode/agents/{role}.md` (init.ts:251-263).
- `.ai/workflow/manifest.json`, written last, only when the computed desired state differs from what is recorded (init.ts:265-299).

INSTALL-AGENT.md:39-53 documents this identical write-surface enumeration for the agent-driven manual-fallback path (used when npx/the registry is unavailable), and states the install is "fully reversible" via uninstall (INSTALL-AGENT.md:59-61).

## The AGENTS.md fence contract

Markers: `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->` (writers.ts:52-53). `upsertMarkerSection` (writers.ts:64-109) is the single fence writer:

- No `AGENTS.md`: created as `# Agent instructions` plus the section (writers.ts:56, 70-74).
- File exists, no markers found: the section is appended after existing content, trimmed (writers.ts:83-88).
- Exactly one well-ordered begin/end pair: everything between the markers is replaced with the current shipped content; everything before `begin` and after `end` is untouched (writers.ts:98-109). This is a full replace, not a merge: init.test.ts:149-165 shows a user-mangled heading inside the fence is silently restored on the next `init` run, while content outside the fence survives.
- Zero-or-more-than-one pair, or an end before its begin: reported as `conflicted`, file left alone (writers.ts:89-97). A marker only counts when it is the entire trimmed line (writers.ts:79-82), so prose merely mentioning the marker string inline never shifts or breaks the fence (init.test.ts:179-195).

Net contract: content between the markers is kit-owned and overwritten on every install/upgrade; content outside is user-owned and touched only by one whole-line append when the fence doesn't exist yet.

## CLAUDE.md / AGENTS.md relationship

Claude Code reads `CLAUDE.md`, not `AGENTS.md` (writers.ts:117-120). `ensureClaudeImport` (writers.ts:121-145), called only for the `claude` harness (init.ts:244):

- No `CLAUDE.md`: created verbatim as `CLAUDE_MD_BOILERPLATE`, a heading plus "Project agent instructions live in AGENTS.md." plus the `@AGENTS.md` import line (writers.ts:115).
- `CLAUDE.md` exists: if any line's whitespace-split tokens already include the literal `@AGENTS.md` (writers.ts:128-132), nothing is written, an inline mention like `"Rules: see @AGENTS.md first."` already counts (init.test.ts:236-241). Otherwise a blank line plus `@AGENTS.md` is appended once (writers.ts:136-144); a second `init` run does not duplicate it (init.test.ts:223-234).

Codex and opencode need no such import, both read `AGENTS.md` natively (README.md:104-105).

## manifest.json: shape and consumers

`Manifest` (init.ts:47-58): `kit` (always `"orchestrator-workflow"`), `version` (`PACKAGE_VERSION` from package.json, assets.ts:10-14, currently `0.12.0`), `harnesses` (sorted array), `models` (per `Role`), `files` (relative path to sha256 of installed content), `installedAt`.

Consumers are all installer-side; nothing at agent runtime reads it:

- `readInstalledManifest` (init.ts:82-134) is the sole parser and degrades every field independently rather than failing whole: unknown `kit` yields `undefined` (init.ts:93); non-array/invalid `harnesses` entries dropped (init.ts:95-99); invalid model ids dropped per role (init.ts:100-112, init.test.ts:267-298 spawns the CLI against a hand-corrupted manifest and asserts it survives); `files` keys are filtered through `isContainedRelativePath` (init.ts:120) inside that same pass.
- `init.ts` uses it as the upgrade baseline (`previous`, init.ts:189).
- `cli.ts:170-180` prints "Found existing install" and `cli.ts:186-200` seeds default `harnesses`/`models` for a plain re-run, which is why an `implementer=haiku` choice made once survives an unflagged second `init` (init.test.ts:631-651).
- `uninstall.ts:123-128` requires it; a missing/unreadable manifest throws `"No orchestrator-workflow install found..."` rather than guessing what to remove.

## Re-install / upgrade semantics

`installKitFile` (init.ts:197-214) drives every kit-owned file (templates, skills, per-role agent files):

- Path doesn't exist: write, record hash.
- Path exists and its current sha256 matches the hash recorded in the previous manifest ("unedited"): overwritten with the newly shipped content even without `--force` (init.ts:202-203), this is how a kit version bump propagates (init.test.ts:244-265).
- Path exists and differs from shipped, with either a hash mismatch or no recorded hash: kept as-is and reported `conflicted` unless `--force`; the previous hash record is preserved rather than dropped (init.ts:206-209), so a later upgrade still recognizes the file as edited (init.test.ts:300-317).
- A plain second run with no drift is a byte-for-byte no-op across every file, including the manifest, which is only rewritten when the computed `desired` object differs from `previous` (init.ts:275-299, init.test.ts:118-134).

## Uninstall: exact removal surface

`runUninstall` (uninstall.ts:117-195):

1. For each `manifest.files` entry: re-check `isContainedRelativePath` (init.ts:70-74) defensively, a second time, right before the unlink (uninstall.ts:136-146); unlink when the on-disk sha256 matches the recorded hash or `--force`, otherwise keep and note "locally edited... re-run with --force" (uninstall.ts:157-167). Path traversal is tested directly: an out-of-target or absolute manifest entry is never unlinked, even with `--force` (test/uninstall.test.ts:105-153, unit table at 155-180).
2. `removeAgentsSection` (uninstall.ts:36-72) removes exactly the fenced block via the same begin/end line-scan as install; if what remains is empty or exactly `AGENTS_MD_HEADING`, the file itself is deleted, otherwise the remainder is written back. A broken/duplicated fence is left in place and reported, mirroring install's conflict behavior (uninstall.ts:47-56).
3. `removeClaudeImport` (uninstall.ts:74-93) deletes `CLAUDE.md` only if it is byte-identical to `CLAUDE_MD_BOILERPLATE`, otherwise strips only the `@AGENTS.md` line; an inline mention survives untouched (test/uninstall.test.ts:182-194).
4. `manifest.json` is always deleted (uninstall.ts:172-176).
5. `PRUNE_CANDIDATES` (uninstall.ts:99-115), deepest-first, each removed only via `rmdirSync`, which throws (swallowed) on a non-empty directory (uninstall.ts:178-184), so any directory holding surviving user content is left standing.
6. `.ai/runs/` is never touched by the removal loop and is explicitly noted as kept when present (uninstall.ts:187-192); run history outlives uninstall by design.

## Tests

- test/init.test.ts: fresh-install shape, idempotence, five AGENTS.md-merge cases (preserve, restore-on-mangle, broken-fence conflict, inline-mention immunity, duplicated-fence conflict), CLAUDE.md import (append-once, inline-recognition), three hash-ledger upgrade cases, read-only-role posture on both harnesses including the Bash-guard string tripwire (init.test.ts:356-394), harness/model-mapping matrix, kit-file conflicts with/without `--force`, input validation, harness detection, CLI smoke for both the default and opencode-catalog-empty paths.
- test/uninstall.test.ts: full init-uninstall roundtrip leaves an empty directory; user AGENTS.md/CLAUDE.md content and run history survive; edited-file retention with/without `--force`; three path-traversal-safety cases; `isContainedRelativePath` unit table; CLAUDE.md inline-import survival; damaged-fence and no-install-found error paths; CLI confirmation gating.
- opencode alias/model resolution (`parseOpencodeCatalog`, `detectProvider`, `resolveAlias`, `resolveOpencodeModels`) is exercised in test/opencode.test.ts; out of scope here, see [model-preselection.md](model-preselection.md) for the resolution rules and the per-role defaults recorded in `manifest.models`.

See [index.md](index.md) for the rest of this bundle.
