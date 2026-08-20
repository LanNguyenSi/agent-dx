---
type: module
title: Install fence mechanics
description: How orchestrator-workflow's installer writes, fences, updates, and removes its surface in a target repo.
tags: [installer, marker-fence, manifest, agents-md, harness-adapters, uninstall]
timestamp: 2026-08-20T23:59:00Z
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

`runInit` (src/init.ts:330) is the single entry point for both a fresh install and a re-run; there is no separate "update" mode, idempotency and upgrade are properties of how each individual write is decided.

## What `init` writes

- `.ai/workflow/templates/00-goal.md` through `06-handoff.md`, one per name from `listTemplateNames()` (init.ts:451-456), plus an empty `.ai/runs/.gitkeep` (init.ts:457). See [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md) for how these templates become run directories.
- The marker-fenced `## Agentic Coding Workflow` section in `AGENTS.md`, installed unconditionally regardless of harness selection (init.ts:459-467): Codex and opencode read `AGENTS.md` natively, Claude Code gets it via an import, so the section is always written.
- Per selected harness (`options.harnesses`), and per role `rolesForProfile(profile)` selects for that harness (0.15.0: `full` installs `{explorer,task-slicer,implementer,reviewer}`, `minimal` installs only `{implementer,reviewer}`; see [model-preselection.md](model-preselection.md) and the manifest's `profile` field below):
  - **claude**: `.claude/skills/orchestrator-workflow/SKILL.md` and `.claude/agents/{role}.md` for each installed role (init.ts:473-477), plus the `CLAUDE.md` import (init.ts:488).
  - **codex**: only `.agents/skills/orchestrator-workflow/SKILL.md` (init.ts:491-493). No per-role agent files are written regardless of profile; README.md:105 states Codex has no standardized project-level subagent definition, the skill instructs running the roles inline instead.
  - **opencode**: `.opencode/skills/orchestrator-workflow/SKILL.md` and `.opencode/agents/{role}.md` for each installed role (init.ts:497-505).
- `.ai/workflow/manifest.json`, written last, only when the computed desired state differs from what is recorded (init.ts:541-579).

Since 0.19.0, when `options.tiers` is on, the **claude** and **opencode**
bullets above each additionally write one `.{claude,opencode}/agents/<role>-<tier>.md`
per non-default tier the role has, right after that role's base file
(init.ts:478-486 claude, :506-538 opencode); see
[model-preselection.md](model-preselection.md)'s "Effort tiers" section for
the full composition and family-dependent frontmatter rules. Codex gets
no tier-variant files either, for the same reason it gets no per-role files
at all.

The opencode side of that rendering carries one extra guard since
fix-round-1 (review finding M1), hardened again in fix-round-2 (review
finding R2-L1): before writing an opencode variant, `init.ts:511-525` checks
whether the variant's class model resolved at all (`variantModelValue !==
undefined`) and skips the `installKitFile` call (and the manifest ledger
entry) entirely when it did not resolve, rather than writing a file that
carries neither a `model:` nor an effort line, a no-op duplicate of the
base file's own (possibly also unresolved) `model:` state, previously
written silently with no warning anywhere. Fix-round-2 simplified this
check and its comment: the original fix-round-1 form computed the effort
line first and gated on `variantModelValue === undefined && effortLine ===
undefined`, but `opencodeVariantEffortLine` (`init.ts:282-296`) always
returns `undefined` when its own `modelValue` argument is `undefined` (it
short-circuits on that first), so the second clause never added any
filtering the first did not already provide, an equivalence the reviewer
proved rather than assumed. `init.ts:526` now computes the effort line only
*after* the resolved-model check passes, and passes it into
`composeOpencodeAgentVariant` (`init.ts:305-328`) as a fourth parameter
instead of that function recomputing it internally — not because the
composer needs `effortLine` to decide whether to write the file (it does
not decide that at all; the skip check above depends only on
`variantModelValue`, per the same equivalence proof), but so there is a
single computed value for it instead of two independent call sites
computing it (review round 3, R3-L2: an earlier draft of this sentence and
the composer's own JSDoc both wrongly gave the skip-decision reason instead
of this one). The fixed comment also states explicitly what is NOT skipped
by this check: a *resolved* model with no effort line (a low/medium tier on
a Claude-family model, or any Ollama model, or a resolved id with no
provider prefix, R3-L4) still renders normally with just its `model:` line. The matching CLI-side half of that fix (`cli.ts:291-322`)
warns once per unresolved model class on stderr instead of staying silent;
fix-round-2 (review finding R2-M3) also corrected the warning's own wording,
which had claimed "model: will be omitted" when the real, fix-round-1
effect was always "no variant file is rendered for this class at all", and
made the opencode-only scope explicit (Claude Code variants need no live
catalog lookup and are unaffected); see
[model-preselection.md](model-preselection.md)'s "Unresolved-class guard"
paragraph for both halves together.

A `tiers: true` -> `tiers: false` re-run **no longer** prints no note: that
was the pre-fix-round-1 behavior (review finding M2), which this bundle's
own re-verification pass originally flagged as a documentation-only finding
against T-002's release. Fix-round-1 closed the gap in `src/`, not just in
docs: `--tiers` gained a commander-negatable counterpart, `--no-tiers`
(`cli.ts:179-182`), so a re-run can now explicitly ask for the transition
instead of only ever being able to turn tiers on. `runInit` now detects the
transition the same way it detects a `full` -> `minimal` profile downgrade,
via a dedicated block (`init.ts:409-425`, guarded by
`previous && previous.tiers && !tiers`) that, for every role the *current*
profile still installs, pushes one `report.notes` entry per non-default
tier's `<role>-<tier>.md` path that is actually present in
`previous.files`, naming it and how to remove it. The profile-downgrade
note loop itself also gained a fix-round-1 extension (review finding M3): a
dropped role's variant files get notes too, not just its base file
(`init.ts:384-398`, the sub-loop inside the existing per-dropped-role
loop); before the fix, dropping a role while tiers were on silently
orphaned that role's variant files with no note at all, since the original
downgrade-note loop only knew about `<role>.md`.

Fix-round-2 (review finding R2-M2) changed how *both* of these note
loops decide whether a given path is actually a leftover: neither the
`previous.tiers` boolean gate on the profile-downgrade sub-loop
(fix-round-1's form) nor an unconditional loop over `ROLE_TIERS[role]`/
`options.harnesses` (both note loops' original form) is sufficient, since
neither one checks whether the previous install actually *wrote* that
specific file. Both loops now push a note for a candidate path only when
that exact relative path is a key of `previous.files` (`init.ts:346-363`
computes `previousHarnessDirs` from `previous.harnesses`, not
`options.harnesses`, as the shared harness-set input to both loops), so
`ROLE_TIERS[role]` is now used only to enumerate the *candidate* tier
suffixes to probe against the ledger, never as the source of truth for
whether a note is due. This closes two review-round-2 defects the
fix-round-1 form had: (a) a phantom note for a variant file that was never
written at all, e.g. an opencode install with tiers on whose class models
never resolved (the M1 guard above skipped every variant write, so
`previous.files` never gained those keys, but the old `previous.tiers`
gate alone could not tell the difference between "tiers was on and wrote
files" and "tiers was on but wrote nothing"); and (b) a missing note for a
real leftover whose harness was dropped from `options.harnesses` this run
even though that harness's files are still sitting on disk, since the old
loops iterated `options.harnesses` (what this run selects) instead of
`previous.harnesses` (what the previous install actually wrote to). The two
note loops still never overlap: the profile-downgrade loop iterates roles
the profile *drops*, the tiers-transition loop iterates roles the *current*
profile still installs, so a simultaneous profile downgrade and tiers-off
carries at most one note per affected file, from whichever loop actually
owns that role. Turning tiers back off is therefore no longer a case that
requires running `orchestrator-workflow uninstall` first to avoid a silent,
unexplained leftover: the note itself now says so, whenever the ledger
confirms the file is a real leftover, though uninstall remains available
for a fully clean removal, same as the profile-downgrade case.

INSTALL-AGENT.md:46-58 documents this identical write-surface enumeration for the agent-driven manual-fallback path (used when npx/the registry is unavailable), extended since 0.19.0 with a paragraph (INSTALL-AGENT.md:60-82, since fix-round-1 also naming `--no-tiers`) stating both the tier-variant naming scheme and that the manual fallback never renders those files at all. INSTALL-AGENT.md:60-63 notes it is the `full`-profile shape, with `minimal` writing only the `implementer`/`reviewer` files, and states the install is "fully reversible" via uninstall (INSTALL-AGENT.md:77-79).

## The AGENTS.md fence contract

Markers: `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->` (writers.ts:54-55). `upsertMarkerSection` (writers.ts:66-111) is the single fence writer:

- No `AGENTS.md`: created as `# Agent instructions` plus the section (writers.ts:58, 72-76).
- File exists, no markers found: the section is appended after existing content, trimmed (writers.ts:85-90).
- Exactly one well-ordered begin/end pair: everything between the markers is replaced with the current shipped content; everything before `begin` and after `end` is untouched (writers.ts:100-111). This is a full replace, not a merge: init.test.ts:153-169 shows a user-mangled heading inside the fence is silently restored on the next `init` run, while content outside the fence survives.
- Zero-or-more-than-one pair, or an end before its begin: reported as `conflicted`, file left alone (writers.ts:91-99). A marker only counts when it is the entire trimmed line (writers.ts:81-84), so prose merely mentioning the marker string inline never shifts or breaks the fence (init.test.ts:183-199).

Net contract: content between the markers is kit-owned and overwritten on every install/upgrade; content outside is user-owned and touched only by one whole-line append when the fence doesn't exist yet.

## CLAUDE.md / AGENTS.md relationship

Claude Code reads `CLAUDE.md`, not `AGENTS.md` (writers.ts:119-122). `ensureClaudeImport` (writers.ts:123-147), called only for the `claude` harness (init.ts:488):

- No `CLAUDE.md`: created verbatim as `CLAUDE_MD_BOILERPLATE`, a heading plus "Project agent instructions live in AGENTS.md." plus the `@AGENTS.md` import line (writers.ts:117).
- `CLAUDE.md` exists: if any line's whitespace-split tokens already include the literal `@AGENTS.md` (writers.ts:130-134), nothing is written, an inline mention like `"Rules: see @AGENTS.md first."` already counts (init.test.ts:240-245). Otherwise a blank line plus `@AGENTS.md` is appended once (writers.ts:138-146); a second `init` run does not duplicate it (init.test.ts:227-238).

Codex and opencode need no such import, both read `AGENTS.md` natively (README.md:105-106).

## manifest.json: shape and consumers

`Manifest` (init.ts:76-91): `kit` (always `"orchestrator-workflow"`), `version` (`PACKAGE_VERSION` from package.json, assets.ts:10-14), `harnesses` (sorted array), `models` (per `Role`), `profile` (0.15.0: `"minimal"` or `"full"`, which roles were installed), `tiers` (0.19.0: boolean, whether effort-tier variants were rendered, `init.ts:83-84`), `files` (relative path to sha256 of installed content), `installedAt`.

Consumers are all installer-side; nothing at agent runtime reads it:

- `readInstalledManifest` (init.ts:115-183) is the sole parser and degrades every field independently rather than failing whole: unknown `kit` yields `undefined` (init.ts:126); non-array/invalid `harnesses` entries dropped (init.ts:128-132); invalid model ids dropped per role (init.ts:133-145, init.test.ts:277-308 spawns the CLI against a hand-corrupted manifest and asserts it survives); a missing `profile` field (a pre-0.15.0 manifest, which always installed every role) degrades to `"full"` rather than `"minimal"` (init.ts:158-164, init.test.ts:723-760 pins this fallback end-to-end against a hand-written manifest so a later re-run cannot silently narrow the installed roles); since 0.19.0, a missing `tiers` field (a pre-0.19.0 manifest, which never rendered variant files) degrades to `false` the same way (init.ts:166-170, init.test.ts:1128-1181); `files` keys are filtered through `isContainedRelativePath` (init.ts:153) inside that same pass.
- `init.ts` uses it as the upgrade baseline (`previous`, init.ts:343).
- `cli.ts:217-227` prints "Found existing install" (now including the profile and, since fix-round-1, the `tiers` value too); `cli.ts:229-240` seeds default `harnesses`, `cli.ts:242-252` seeds `profile`, `cli.ts:254-260` seeds `models`, and (since 0.19.0) `cli.ts:262-272` seeds `tiers`, since fix-round-1 via `opts.tiers ?? previous?.tiers ?? false`, the same override-vs-persist rule for all four, still no interactive branch for `tiers` unlike the other three, which is why an `implementer=haiku` choice made once survives an unflagged second `init` (init.test.ts:1104-1124). A `full` -> `minimal` downgrade (`previous.profile === "full" && profile !== previous.profile`, init.ts:370-401, the block grew since fix-round-1 to also note dropped roles' tier-variant files) additionally pushes a note onto `report.notes` naming the now-untracked `task-slicer.md`/`explorer.md` files and how to remove them (init.test.ts:762-843 covers the note, its absence on a repeated no-op re-run, and that a later `uninstall` still completes without error; init.test.ts:845-885 covers the fix-round-1 tier-variant-file extension specifically, pinning the note count). Since fix-round-1, `tiers` now has an analogous downgrade-note code path of its own (init.ts:409-425); before the fix it had none. Since fix-round-2 (review finding R2-M2), both of these note code paths, and the tier-variant sub-loop inside the profile-downgrade one (init.ts:384-398, review finding M3's original addition), are ledger-driven rather than enumeration-driven: see "What `init` writes" above for the full mechanics and why the prior `ROLE_TIERS`/`options.harnesses`-driven form produced both phantom and missing notes.

## Re-install / upgrade semantics

`installKitFile` (init.ts:432-449) drives every kit-owned file (templates, skills, per-role agent files, and, since 0.19.0, per-role-per-tier variant files, since the tier-rendering loops call the exact same closure):

- Path doesn't exist: write, record hash.
- Path exists and its current sha256 matches the hash recorded in the previous manifest ("unedited"): overwritten with the newly shipped content even without `--force` (init.ts:437-438), this is how a kit version bump propagates (init.test.ts:255-275).
- Path exists and differs from shipped, with either a hash mismatch or no recorded hash: kept as-is and reported `conflicted` unless `--force`; the previous hash record is preserved rather than dropped (init.ts:439-444), so a later upgrade still recognizes the file as edited (init.test.ts:310-327).
- A plain second run with no drift is a byte-for-byte no-op across every file, including the manifest, which is only rewritten when the computed `desired` object differs from `previous` (init.ts:541-579, init.test.ts:129-143); since 0.19.0 this no-op also covers a `tiers: true` re-run, `test/init.test.ts:1432-1450` pins a second `tiers: true` run changing no file.
- 0.15.0: a `full` -> `minimal` downgrade is the one case where a plain re-run is *not* silent, see the manifest.json section above for the leftover-files note it prints. Since fix-round-1, `tiers: true` -> `tiers: false` is the same kind of not-silent case, via its own dedicated note block rather than by accreting onto the profile-downgrade one; before the fix it was a structurally identical leftover-files case that printed nothing at all (review finding M2, see "What `init` writes" above).

## Uninstall: exact removal surface

`runUninstall` (uninstall.ts:117-195):

1. For each `manifest.files` entry: re-check `isContainedRelativePath` (init.ts:103-107) defensively, a second time, right before the unlink (uninstall.ts:136-146); unlink when the on-disk sha256 matches the recorded hash or `--force`, otherwise keep and note "locally edited... re-run with --force" (uninstall.ts:157-167). Path traversal is tested directly: an out-of-target or absolute manifest entry is never unlinked, even with `--force` (test/uninstall.test.ts:139-187, unit table at 189-214).
2. `removeAgentsSection` (uninstall.ts:36-72) removes exactly the fenced block via the same begin/end line-scan as install; if what remains is empty or exactly `AGENTS_MD_HEADING`, the file itself is deleted, otherwise the remainder is written back. A broken/duplicated fence is left in place and reported, mirroring install's conflict behavior (uninstall.ts:47-56).
3. `removeClaudeImport` (uninstall.ts:74-93) deletes `CLAUDE.md` only if it is byte-identical to `CLAUDE_MD_BOILERPLATE`, otherwise strips only the `@AGENTS.md` line; an inline mention survives untouched (test/uninstall.test.ts:217-227).
4. `manifest.json` is always deleted (uninstall.ts:172-176).
5. `PRUNE_CANDIDATES` (uninstall.ts:99-115), deepest-first, each removed only via `rmdirSync`, which throws (swallowed) on a non-empty directory (uninstall.ts:178-184), so any directory holding surviving user content is left standing. `runUninstall` itself needs no profile- or tiers-specific logic: it only ever iterates `manifest.files`, so a `full` -> `minimal` downgrade's now-untracked `task-slicer.md`/`explorer.md` are simply absent from that loop and are left on disk without comment (init.test.ts:819-843 confirms uninstall still completes without error in that case). Since 0.19.0, an install with `tiers: true` writes every `<role>-<tier>.md` path into `manifest.files` the same as any other kit-owned file (no separate ledger), so uninstalling a tiers-on install removes them the same way as the base agent files with no dedicated code (`test/init.test.ts:1452-1465` covers a fresh `tiers: true` install followed by `uninstall`, asserting a rendered variant file is gone afterward).
6. `.ai/runs/` is never touched by the removal loop and is explicitly noted as kept when present (uninstall.ts:187-192); run history outlives uninstall by design.

## Tests

- test/init.test.ts: fresh-install shape, idempotence, six AGENTS.md-merge cases (preserve, restore-on-mangle, broken-fence conflict, inline-mention immunity, duplicated-fence conflict, empty-file append), CLAUDE.md import (append-once, inline-recognition), three hash-ledger upgrade cases, read-only-role posture on both harnesses including the Bash-guard string tripwire (init.test.ts:366-404), harness/model-mapping matrix, profile selection (minimal vs. full agent-file sets, manifest `profile` field, CLI re-run persist-vs-override semantics, the pre-0.15.0-manifest full-not-minimal fallback, the full -> minimal downgrade note and its uninstall interaction), kit-file conflicts with/without `--force`, input validation, harness detection, CLI smoke for both the default and opencode-catalog-empty paths. Since 0.19.0, a dedicated `describe("tier variants (\`--tiers\`)")` block (init.test.ts:1127-1563) covers: the pre-0.19.0-manifest `tiers`-not-`false` degradation fallback, now with a content assertion on the legacy default-file frontmatter shape since fix-round-1 review finding L1 (:1128-1181); the exact 13-file count plus per-file model/effort assertions for `--profile full` (:1183-1212); the collision-free file set (no `<role>-<defaultTier>.md` ever written, :1214-1225); the anthropic- and ollama-resolved-class outcomes (Claude family gets `variant:`, Ollama gets no effort field, :1227-1285); a resolved class id with no provider prefix at all (no `/`) gets a `model:` line but likewise no effort field, the same no-op-field outcome as Ollama but reached via `opencodeVariantEffortLine`'s `provider === undefined` branch rather than its `provider === "ollama"` one (review round 3, R3-L4, :1287-1313, added after this bundle's own re-verification found the README's "Every other non-Claude-family model" bullet had silently implied this case did not exist); the non-Claude-family `reasoningEffort:` outcome (:1315-1335), extended since fix-round-1 (review finding M4) with two family-over-provider-id cases, `github-copilot/claude-*` and the nested `openrouter/anthropic/claude-*` (:1337-1385), and the unresolved-class-model no-file guard from review finding M1 (:1387-1424); a standalone tier-data invariant test, `DEFAULT_TIER[role]` is always a member of `ROLE_TIERS[role]` (:1426-1430); idempotence (:1432-1450); uninstall coverage (:1452-1465); the manifest `tiers: true` record (:1466-1472); and a nested `describe("CLI --tiers override-vs-persist")` (:1474-1563) covering the pre-existing persist-vs-override case plus, since fix-round-1, the `--no-tiers` default-off flagless-init case (review finding M5, :1499-1514, the mutation tripwire for a hardcoded `const tiers = true` CLI resolution), `--no-tiers` on a fresh install (:1516-1526), the true -> false transition with its leftover note (:1528-1552), and the tiers status appearing in both the "Found existing install" line and the closing summary (:1554-1561). Fix-round-1 also added two CLI-level tests in the opencode-catalog-empty `describe` (init.test.ts:1649-1704) covering the unresolved-model-class stderr warning and the fully-qualified-`--models`-does-not-bypass-class-resolution case (review finding M1); fix-round-2 (review finding R2-M3) strengthened both to assert the corrected warning's full wording (the real "no variant file rendered" effect and the opencode-only scope) instead of just the model-class name. Fix-round-2 also added a standalone `describe("leftover notes are ledger-driven, not enumeration-driven (review round 2, R2-M2)")` block (init.test.ts:888-971, right after the profile-downgrade describe and before the kit-owned-file-conflicts one) with two `runInit`-level tests: an opencode install with every tier-class model unresolved (so the M1 guard writes zero variant files) followed by a tiers-off re-run asserts exactly 0 leftover notes, where the pre-fix `ROLE_TIERS`-driven loop would have produced 9 phantom notes; and a claude install with tiers on followed by a re-run that switches to `--harness opencode --no-tiers` asserts the real `.claude` variant leftovers are named (9 notes) and that none mention `.opencode`, the harness-dropped case the pre-fix `options.harnesses`-driven loop missed entirely (it would have produced 0 notes since `.claude` was no longer in `options.harnesses`). Review round 3 (R3-L1) added a sibling `describe("profile-downgrade variant-file notes are ledger-driven too (review round 3, R3-L1)")` block (init.test.ts:989-1025), right after the R2-M2 block above: the R2-M2 mutation probe only ever exercised the *tiers-off* note loop's `previous.files`-gate, leaving the sibling gate inside the *full -> minimal profile-downgrade* loop's own tier-variant sub-loop (init.ts ~393) untested — a mutant that always pushes the note there (`if (true)`) survived the full suite even though the two loops share the same ledger-driven shape. The new test combines an opencode install whose tier-class models never resolved (so, again, zero variant files were ever written) with a full -> minimal downgrade that still has tiers on, and asserts exactly the two dropped roles' base-file notes with no phantom `-low.md`/`-high.md` variant notes.
- test/uninstall.test.ts: full init-uninstall roundtrip leaves an empty directory; user AGENTS.md/CLAUDE.md content and run history survive; edited-file retention with/without `--force`; three path-traversal-safety cases; `isContainedRelativePath` unit table; CLAUDE.md inline-import survival; damaged-fence and no-install-found error paths; CLI confirmation gating.
- opencode alias/model resolution (`parseOpencodeCatalog`, `detectProvider`, `resolveAlias`, `resolveOpencodeModels`) is exercised in test/opencode.test.ts; out of scope here, see [model-preselection.md](model-preselection.md) for the resolution rules and the per-role defaults recorded in `manifest.models`.

See [index.md](index.md) for the rest of this bundle.
