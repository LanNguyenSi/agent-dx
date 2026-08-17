---
type: module
title: Install fence mechanics
description: How orchestrator-workflow's installer writes, fences, updates, and removes its surface in a target repo.
tags: [installer, marker-fence, manifest, agents-md, harness-adapters, uninstall]
timestamp: 2026-08-17T21:00:00Z
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

`runInit` (src/init.ts:198) is the single entry point for both a fresh install and a re-run; there is no separate "update" mode, idempotency and upgrade are properties of how each individual write is decided.

## What `init` writes

- `.ai/workflow/templates/00-goal.md` through `06-handoff.md`, one per name from `listTemplateNames()` (init.ts:261-266), plus an empty `.ai/runs/.gitkeep` (init.ts:267). See [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md) for how these templates become run directories.
- The marker-fenced `## Agentic Coding Workflow` section in `AGENTS.md`, installed unconditionally regardless of harness selection (init.ts:269-277): Codex and opencode read `AGENTS.md` natively, Claude Code gets it via an import, so the section is always written.
- Per selected harness (`options.harnesses`), and per role `rolesForProfile(profile)` selects for that harness (0.15.0: `full` installs `{explorer,task-slicer,implementer,reviewer}`, `minimal` installs only `{implementer,reviewer}`; see [model-preselection.md](model-preselection.md) and the manifest's `profile` field below):
  - **claude**: `.claude/skills/orchestrator-workflow/SKILL.md` and `.claude/agents/{role}.md` for each installed role (init.ts:281-290), plus the `CLAUDE.md` import (below).
  - **codex**: only `.agents/skills/orchestrator-workflow/SKILL.md` (init.ts:292-294). No per-role agent files are written regardless of profile; README.md:105 states Codex has no standardized project-level subagent definition, the skill instructs running the roles inline instead.
  - **opencode**: `.opencode/skills/orchestrator-workflow/SKILL.md` and `.opencode/agents/{role}.md` for each installed role (init.ts:296-308).
- `.ai/workflow/manifest.json`, written last, only when the computed desired state differs from what is recorded (init.ts:310-346).

INSTALL-AGENT.md:41-55 documents this identical write-surface enumeration for the agent-driven manual-fallback path (used when npx/the registry is unavailable) — INSTALL-AGENT.md:57-60 notes it is the `full`-profile shape, with `minimal` writing only the `implementer`/`reviewer` files — and states the install is "fully reversible" via uninstall (INSTALL-AGENT.md:65-67).

## The AGENTS.md fence contract

Markers: `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->` (writers.ts:54-55). `upsertMarkerSection` (writers.ts:66-111) is the single fence writer:

- No `AGENTS.md`: created as `# Agent instructions` plus the section (writers.ts:58, 72-76).
- File exists, no markers found: the section is appended after existing content, trimmed (writers.ts:85-90).
- Exactly one well-ordered begin/end pair: everything between the markers is replaced with the current shipped content; everything before `begin` and after `end` is untouched (writers.ts:100-111). This is a full replace, not a merge: init.test.ts:151-167 shows a user-mangled heading inside the fence is silently restored on the next `init` run, while content outside the fence survives.
- Zero-or-more-than-one pair, or an end before its begin: reported as `conflicted`, file left alone (writers.ts:91-99). A marker only counts when it is the entire trimmed line (writers.ts:81-84), so prose merely mentioning the marker string inline never shifts or breaks the fence (init.test.ts:181-197).

Net contract: content between the markers is kit-owned and overwritten on every install/upgrade; content outside is user-owned and touched only by one whole-line append when the fence doesn't exist yet.

## CLAUDE.md / AGENTS.md relationship

Claude Code reads `CLAUDE.md`, not `AGENTS.md` (writers.ts:119-122). `ensureClaudeImport` (writers.ts:123-147), called only for the `claude` harness (init.ts:289):

- No `CLAUDE.md`: created verbatim as `CLAUDE_MD_BOILERPLATE`, a heading plus "Project agent instructions live in AGENTS.md." plus the `@AGENTS.md` import line (writers.ts:117).
- `CLAUDE.md` exists: if any line's whitespace-split tokens already include the literal `@AGENTS.md` (writers.ts:130-134), nothing is written, an inline mention like `"Rules: see @AGENTS.md first."` already counts (init.test.ts:238-243). Otherwise a blank line plus `@AGENTS.md` is appended once (writers.ts:138-146); a second `init` run does not duplicate it (init.test.ts:225-236).

Codex and opencode need no such import, both read `AGENTS.md` natively (README.md:105-106).

## manifest.json: shape and consumers

`Manifest` (init.ts:56-69): `kit` (always `"orchestrator-workflow"`), `version` (`PACKAGE_VERSION` from package.json, assets.ts:10-14, currently `0.15.0`), `harnesses` (sorted array), `models` (per `Role`), `profile` (0.15.0: `"minimal"` or `"full"`, which roles were installed), `files` (relative path to sha256 of installed content), `installedAt`.

Consumers are all installer-side; nothing at agent runtime reads it:

- `readInstalledManifest` (init.ts:93-154) is the sole parser and degrades every field independently rather than failing whole: unknown `kit` yields `undefined` (init.ts:104); non-array/invalid `harnesses` entries dropped (init.ts:106-110); invalid model ids dropped per role (init.ts:111-123, init.test.ts:275-306 spawns the CLI against a hand-corrupted manifest and asserts it survives); a missing `profile` field (a pre-0.15.0 manifest, which always installed every role) degrades to `"full"` rather than `"minimal"` (init.ts:136-142, init.test.ts:721-758 pins this fallback end-to-end against a hand-written manifest so a later re-run cannot silently narrow the installed roles); `files` keys are filtered through `isContainedRelativePath` (init.ts:131) inside that same pass.
- `init.ts` uses it as the upgrade baseline (`previous`, init.ts:210).
- `cli.ts:201-211` prints "Found existing install" (now including the profile); `cli.ts:213-224` seeds default `harnesses`, `cli.ts:230-236` seeds `profile`, and `cli.ts:238-241` seeds `models`, all for a plain re-run — the same override-vs-persist rule for all three — which is why an `implementer=haiku` choice made once survives an unflagged second `init` (init.test.ts:921-941). A `full` -> `minimal` downgrade (`previous.profile === "full" && profile !== previous.profile`, init.ts:218-235) additionally pushes a note onto `report.notes` naming the now-untracked `task-slicer.md`/`explorer.md` files and how to remove them (init.test.ts:760-842 covers the note, its absence on a repeated no-op re-run, and that a later `uninstall` still completes without error).
- `uninstall.ts:123-128` requires it; a missing/unreadable manifest throws `"No orchestrator-workflow install found..."` rather than guessing what to remove.

## Re-install / upgrade semantics

`installKitFile` (init.ts:242-259) drives every kit-owned file (templates, skills, per-role agent files):

- Path doesn't exist: write, record hash.
- Path exists and its current sha256 matches the hash recorded in the previous manifest ("unedited"): overwritten with the newly shipped content even without `--force` (init.ts:247-248), this is how a kit version bump propagates (init.test.ts:253-273).
- Path exists and differs from shipped, with either a hash mismatch or no recorded hash: kept as-is and reported `conflicted` unless `--force`; the previous hash record is preserved rather than dropped (init.ts:251-254), so a later upgrade still recognizes the file as edited (init.test.ts:308-325).
- A plain second run with no drift is a byte-for-byte no-op across every file, including the manifest, which is only rewritten when the computed `desired` object differs from `previous` (init.ts:310-346, init.test.ts:127-141).
- 0.15.0: a `full` -> `minimal` downgrade is the one case where a plain re-run is *not* silent — see the manifest.json section above for the leftover-files note it prints.

## Uninstall: exact removal surface

`runUninstall` (uninstall.ts:117-195):

1. For each `manifest.files` entry: re-check `isContainedRelativePath` (init.ts:81-85) defensively, a second time, right before the unlink (uninstall.ts:136-146); unlink when the on-disk sha256 matches the recorded hash or `--force`, otherwise keep and note "locally edited... re-run with --force" (uninstall.ts:157-167). Path traversal is tested directly: an out-of-target or absolute manifest entry is never unlinked, even with `--force` (test/uninstall.test.ts:139-187, unit table at 189-214).
2. `removeAgentsSection` (uninstall.ts:36-72) removes exactly the fenced block via the same begin/end line-scan as install; if what remains is empty or exactly `AGENTS_MD_HEADING`, the file itself is deleted, otherwise the remainder is written back. A broken/duplicated fence is left in place and reported, mirroring install's conflict behavior (uninstall.ts:47-56).
3. `removeClaudeImport` (uninstall.ts:74-93) deletes `CLAUDE.md` only if it is byte-identical to `CLAUDE_MD_BOILERPLATE`, otherwise strips only the `@AGENTS.md` line; an inline mention survives untouched (test/uninstall.test.ts:217-227).
4. `manifest.json` is always deleted (uninstall.ts:172-176).
5. `PRUNE_CANDIDATES` (uninstall.ts:99-115), deepest-first, each removed only via `rmdirSync`, which throws (swallowed) on a non-empty directory (uninstall.ts:178-184), so any directory holding surviving user content is left standing. `runUninstall` itself needs no profile-specific logic: it only ever iterates `manifest.files`, so a `full` -> `minimal` downgrade's now-untracked `task-slicer.md`/`explorer.md` are simply absent from that loop and are left on disk without comment (init.test.ts:817-841 confirms uninstall still completes without error in that case).
6. `.ai/runs/` is never touched by the removal loop and is explicitly noted as kept when present (uninstall.ts:187-192); run history outlives uninstall by design.

## Tests

- test/init.test.ts: fresh-install shape, idempotence, six AGENTS.md-merge cases (preserve, restore-on-mangle, broken-fence conflict, inline-mention immunity, duplicated-fence conflict, empty-file append), CLAUDE.md import (append-once, inline-recognition), three hash-ledger upgrade cases, read-only-role posture on both harnesses including the Bash-guard string tripwire (init.test.ts:364-402), harness/model-mapping matrix, profile selection (minimal vs. full agent-file sets, manifest `profile` field, CLI re-run persist-vs-override semantics, the pre-0.15.0-manifest full-not-minimal fallback, the full -> minimal downgrade note and its uninstall interaction), kit-file conflicts with/without `--force`, input validation, harness detection, CLI smoke for both the default and opencode-catalog-empty paths.
- test/uninstall.test.ts: full init-uninstall roundtrip leaves an empty directory; user AGENTS.md/CLAUDE.md content and run history survive; edited-file retention with/without `--force`; three path-traversal-safety cases; `isContainedRelativePath` unit table; CLAUDE.md inline-import survival; damaged-fence and no-install-found error paths; CLI confirmation gating.
- opencode alias/model resolution (`parseOpencodeCatalog`, `detectProvider`, `resolveAlias`, `resolveOpencodeModels`) is exercised in test/opencode.test.ts; out of scope here, see [model-preselection.md](model-preselection.md) for the resolution rules and the per-role defaults recorded in `manifest.models`.

See [index.md](index.md) for the rest of this bundle.
