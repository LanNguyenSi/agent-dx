---
type: module
title: Install fence mechanics
description: How orchestrator-workflow's installer writes, fences, updates, and removes its surface in a target repo.
tags: [installer, marker-fence, manifest, agents-md, harness-adapters, uninstall]
timestamp: 2026-08-26T23:59:00Z
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

`runInit` (src/init.ts:363#"export function runInit(options: InitOptions): Report {") is the single entry point for both a fresh install and a re-run; there is no separate "update" mode, idempotency and upgrade are properties of how each individual write is decided.

## What `init` writes

- `.ai/workflow/templates/00-goal.md` through `06-handoff.md`, one per name from `listTemplateNames()` (init.ts:484-487#"readAsset(join("), plus an empty `.ai/runs/.gitkeep` (init.ts:490#".gitkeep"). See [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md) for how these templates become run directories.
- The marker-fenced `## Agentic Coding Workflow` section in `AGENTS.md`, installed unconditionally regardless of harness selection (init.ts:487-495#"// fenced section and the import line are ever touched."): Codex and opencode read `AGENTS.md` natively, Claude Code gets it via an import, so the section is always written.
- Per selected harness (`options.harnesses`), and per role `rolesForProfile(profile)` selects for that harness (0.15.0: `full` installs `{explorer,task-slicer,implementer,reviewer}`, `minimal` installs only `{implementer,reviewer}`; since 0.21.0 `full` also installs `advisor` (`{explorer,task-slicer,implementer,reviewer,advisor}`), the fifth role added purely by extending `ROLES`/`MINIMAL_PROFILE_ROLES` in `src/models.ts`, `rolesForProfile` itself unchanged, `minimal` still filters against the same two-role `MINIMAL_PROFILE_ROLES` set, so advisor is dropped from `minimal` for free, the same way explorer/task-slicer already are; see [model-preselection.md](model-preselection.md) and the manifest's `profile` field below):
  - **claude**: `.claude/skills/orchestrator-workflow/SKILL.md` and `.claude/agents/{role}.md` for each installed role (init.ts:504-509#"composeClaudeAgent(role, options.models[role]),"), plus the `CLAUDE.md` import (init.ts:521#"ensureClaudeImport(report, join(targetDir,").
  - **codex**: only `.agents/skills/orchestrator-workflow/SKILL.md` (init.ts:524-525#", SKILL_NAME,"). No per-role agent files are written regardless of profile; README.md:105 states Codex has no standardized project-level subagent definition, the skill instructs running the roles inline instead.
  - **opencode**: `.opencode/skills/orchestrator-workflow/SKILL.md` and `.opencode/agents/{role}.md` for each installed role (init.ts:525-537#"modelValue,").
- `.ai/workflow/manifest.json`, written last, only when the computed desired state differs from what is recorded (init.ts:578-611#"${JSON.stringify(manifest, null, 2)}\n").

Since 0.22.0, every **claude** and **opencode** default (unsuffixed) file
above also carries a pinned default effort baked in unconditionally
(`composeClaudeAgent`/`composeOpencodeAgent`, not gated on `options.tiers`
at all); see [model-preselection.md](model-preselection.md)'s "Pinned
default effort (0.22.0)" subsection for the full rule. Separately, since
0.19.0, when `options.tiers` is on, the **claude** and **opencode**
bullets above each additionally write one `.{claude,opencode}/agents/<role>-<tier>.md`
per non-default tier the role has, right after that role's base file
(init.ts:506-511#"if (tiers) {" claude, :538-569 opencode); see
[model-preselection.md](model-preselection.md)'s "Effort tiers" section for
the full composition and family-dependent frontmatter rules. Codex gets
no tier-variant files either, for the same reason it gets no per-role files
at all.

The opencode side of that rendering carries one extra guard since
fix-round-1 (review finding M1), hardened again in fix-round-2 (review
finding R2-L1): before writing an opencode variant, `init.ts:543-557#"// (e.g. a low/medium tier on a Claude-family model, or any"` checks
whether the variant's class model resolved at all (`variantModelValue !==
undefined`) and skips the `installKitFile` call (and the manifest ledger
entry) entirely when it did not resolve, rather than writing a file that
carries neither a `model:` nor an effort line, a no-op duplicate of the
base file's own (possibly also unresolved) `model:` state, previously
written silently with no warning anywhere. Fix-round-2 simplified this
check and its comment: the original fix-round-1 form computed the effort
line first and gated on `variantModelValue === undefined && effortLine ===
undefined`, but `opencodeEffortLine` (renamed from `opencodeVariantEffortLine`
in 0.22.0 since the function now also serves the default file, `init.ts:297-322#"variant: max"`)
always returns `undefined` when its own `modelValue` argument is `undefined` (it
short-circuits on that first), so the second clause never added any
filtering the first did not already provide, an equivalence the reviewer
proved rather than assumed. `init.ts:558#"// Ollama model) is NOT skipped by this check: it still renders"` now computes the effort line only
*after* the resolved-model check passes, and passes it into
`composeOpencodeAgentVariant` (`init.ts:333-354#"frontmatter.push(effortLine);"`) as a fourth parameter
instead of that function recomputing it internally, not because the
composer needs `effortLine` to decide whether to write the file (it does
not decide that at all; the skip check above depends only on
`variantModelValue`, per the same equivalence proof), but so there is a
single computed value for it instead of two independent call sites
computing it (review round 3, R3-L2: an earlier draft of this sentence and
the composer's own JSDoc both wrongly gave the skip-decision reason instead
of this one). The fixed comment also states explicitly what is NOT skipped
by this check: a *resolved* model with no effort line (a low/medium tier on
a Claude-family model, or any Ollama model, or a resolved id with no
provider prefix, R3-L4) still renders normally with just its `model:` line. The matching CLI-side half of that fix (`cli.ts:291-322#"// and need no live catalog lookup, so they are unaffected)."`)
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
(`cli.ts:184-186#"explicitly turn effort-tier subagent variants off, overriding a previously installed --tiers value"`), so a re-run can now explicitly ask for the transition
instead of only ever being able to turn tiers on. `runInit` now detects the
transition the same way it detects a `full` -> `minimal` profile downgrade,
via a dedicated block (`init.ts:409-425#"const variantPath = join(harnessDir,"`, guarded by
`previous && previous.tiers && !tiers`) that, for every role the *current*
profile still installs, pushes one `report.notes` entry per non-default
tier's `<role>-<tier>.md` path that is actually present in
`previous.files`, naming it and how to remove it. The profile-downgrade
note loop itself also gained a fix-round-1 extension (review finding M3): a
dropped role's variant files get notes too, not just its base file
(`init.ts:384-398#"// A full -> minimal downgrade drops explorer/task-slicer from the roles"`, the sub-loop inside the existing per-dropped-role
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
that exact relative path is a key of `previous.files` (`init.ts:346-363#"export function runInit(options: InitOptions): Report {"`
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

Markers: `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->` (writers.ts:54-55#"<!-- orchestrator-workflow:end -->"). `upsertMarkerSection` (writers.ts:66-109#"write(path, replaced);") is the single fence writer:

- No `AGENTS.md`: created as `# Agent instructions` plus the section (writers.ts:58#"export const AGENTS_MD_HEADING =", 72-76).
- File exists, no markers found: the section is appended after existing content, trimmed (writers.ts:85-87#"${base}\n\n${block}\n").
- Exactly one well-ordered begin/end pair: everything between the markers is replaced with the current shipped content; everything before `begin` and after `end` is untouched (writers.ts:100-109#"write(path, replaced);"). This is a full replace, not a merge: init.test.ts:160-175#"expect(restored).toContain(" shows a user-mangled heading inside the fence is silently restored on the next `init` run, while content outside the fence survives. Since 0.21.0 the shipped fenced content itself carries the advisor escalation paragraph in Scaling delegation (see [subagent-contracts-superset.md](subagent-contracts-superset.md)); the merge mechanics this section documents are unaffected, since the fence is still replaced as one opaque block regardless of what changed inside it.
- Zero-or-more-than-one pair, or an end before its begin: reported as `conflicted`, file left alone (writers.ts:91-97#"report.conflicted.push(path);"). A marker only counts when it is the entire trimmed line (writers.ts:81-83#"if (line.trim() === SECTION_END) endLines.push(index);"), so prose merely mentioning the marker string inline never shifts or breaks the fence (init.test.ts:190-201#"Never deploy on Fridays").

Net contract: content between the markers is kit-owned and overwritten on every install/upgrade; content outside is user-owned and touched only by one whole-line append when the fence doesn't exist yet.

## CLAUDE.md / AGENTS.md relationship

Claude Code reads `CLAUDE.md`, not `AGENTS.md` (writers.ts:119-121#"* imports AGENTS.md so the policy section is loaded there too."). `ensureClaudeImport` (writers.ts:123-144#"${base}\n\n${CLAUDE_IMPORT_LINE}\n"), called only for the `claude` harness (init.ts:521#"ensureClaudeImport(report, join(targetDir,"):

- No `CLAUDE.md`: created verbatim as `CLAUDE_MD_BOILERPLATE`, a heading plus "Project agent instructions live in AGENTS.md." plus the `@AGENTS.md` import line (writers.ts:117#"# CLAUDE.md\n\nProject agent instructions live in AGENTS.md.\n\n${CLAUDE_IMPORT_LINE}\n").
- `CLAUDE.md` exists: if any line's whitespace-split tokens already include the literal `@AGENTS.md` (writers.ts:130-134#".some((line) => line.split(/\s+/).includes(CLAUDE_IMPORT_LINE));"), nothing is written, an inline mention like `"Rules: see @AGENTS.md first."` already counts (init.test.ts:247-251#"expect(claudeMd).toBe("). Otherwise a blank line plus `@AGENTS.md` is appended once (writers.ts:139-144#"${base}\n\n${CLAUDE_IMPORT_LINE}\n"); a second `init` run does not duplicate it (init.test.ts:234-244#"expect(importCount).toBe(1);").

Codex and opencode need no such import, both read `AGENTS.md` natively (README.md:105-106).

## manifest.json: shape and consumers

`Manifest` (init.ts:76-90#"installedAt: string;"): `kit` (always `"orchestrator-workflow"`), `version` (`PACKAGE_VERSION` from package.json, assets.ts:10-14#").version;"), `harnesses` (sorted array), `models` (per `Role`), `profile` (0.15.0: `"minimal"` or `"full"`, which roles were installed), `tiers` (0.19.0: boolean, whether effort-tier variants were rendered, `init.ts:83-84#"tiers: boolean;"`), `files` (relative path to sha256 of installed content), `installedAt`.

Consumers are all installer-side; nothing at agent runtime reads it:

- `readInstalledManifest` (init.ts:115-181#"typeof candidate.installedAt ===") is the sole parser and degrades every field independently rather than failing whole: unknown `kit` yields `undefined` (init.ts:126#"if (candidate.kit !== SKILL_NAME) return undefined;"); non-array/invalid `harnesses` entries dropped (init.ts:128-131#"(HARNESSES as string[]).includes(value as string),"); invalid model ids dropped per role (init.ts:133-142#"// Invalid model ids are dropped; the role falls back to defaults.", init.test.ts:278-308#"expect(manifest.models.implementer).toBe(" spawns the CLI against a hand-corrupted manifest and asserts it survives); a missing `profile` field (a pre-0.15.0 manifest, which always installed every role) degrades to `"full"` rather than `"minimal"` (init.ts:158-164#": DEFAULT_PROFILE;", init.test.ts:762-791#"should exist under the full-profile fallback" pins this fallback end-to-end against a hand-written manifest so a later re-run cannot silently narrow the installed roles); since 0.19.0, a missing `tiers` field (a pre-0.19.0 manifest, which never rendered variant files) degrades to `false` the same way (init.ts:166-170#"const tiers = typeof candidate.tiers ===", init.test.ts:1170-1215#"explorer.md has no frontmatter block"); `files` keys are filtered through `isContainedRelativePath` (init.ts:153#"&& isContainedRelativePath(key)) {") inside that same pass.
- `init.ts` uses it as the upgrade baseline (`previous`, init.ts:376#"readInstalledManifest(targetDir)").
- `cli.ts:217-227#"? previous.harnesses.join("` prints "Found existing install" (now including the profile and, since fix-round-1, the `tiers` value too); `cli.ts:229-240#"harnesses = interactive"` seeds default `harnesses`, `cli.ts:242-252#"if (opts.profile) {"` seeds `profile`, `cli.ts:254-260#"...DEFAULT_MODELS,"` seeds `models`, and (since 0.19.0) `cli.ts:267-277#"const tiers = opts.tiers ?? previous?.tiers ?? false;"` seeds `tiers`, since fix-round-1 via `opts.tiers ?? previous?.tiers ?? false`, the same override-vs-persist rule for all four, still no interactive branch for `tiers` unlike the other three, which is why an `implementer=haiku` choice made once survives an unflagged second `init` (init.test.ts:1146-1165#"model: haiku"). A `full` -> `minimal` downgrade (`previous.profile === "full" && profile !== previous.profile`, init.ts:403-428#"${variantPath}: now untracked after the full -> ${profile} profile downgrade; run \", the block grew since fix-round-1 to also note dropped roles' tier-variant files) additionally pushes a note onto `report.notes` naming the now-untracked `task-slicer.md`/`explorer.md` files and how to remove them (init.test.ts:801-832#"expect(existsSync(join(target, claudeExplorer))).toBe(true);" covers the note; init.test.ts:835-854#"expect(again.notes).toEqual([]);" covers its absence on a repeated no-op re-run; init.test.ts:857-872#"task-slicer.md/explorer.md are no longer in the manifest's file" covers that a later `uninstall` still completes without error; init.test.ts:883-920#"The variant files themselves are untouched, only untracked, same as" covers the fix-round-1 tier-variant-file extension specifically, pinning the note count). Since 0.21.0, `droppedRoles` (`rolesForProfile(previous.profile).filter((role) => !rolesForProfile(profile).includes(role))`, init.ts:371-373#"const tiers = options.tiers ?? false;") is computed generically from the two profiles' resolved role sets rather than a hardcoded pair, so a `full` -> `minimal` downgrade with the advisor role installed now also names `advisor.md` (and, with tiers on, `advisor-xhigh.md`) with no code change of its own required: the note counts in `init.test.ts:883-906#"expect(report.notes.length).toBe(8);"` moved from 6 to 8 for the base-plus-tiers case (explorer/task-slicer contribute 1+2 notes each, advisor contributes 1+1 since its only non-default tier is `xhigh`) purely from `ROLES` growing by one in `src/models.ts`. Since fix-round-1, `tiers` now has an analogous downgrade-note code path of its own (init.ts:409-425#"const variantPath = join(harnessDir,"); before the fix it had none. Since fix-round-2 (review finding R2-M2), both of these note code paths, and the tier-variant sub-loop inside the profile-downgrade one (init.ts:384-398#"// A full -> minimal downgrade drops explorer/task-slicer from the roles", review finding M3's original addition), are ledger-driven rather than enumeration-driven: see "What `init` writes" above for the full mechanics and why the prior `ROLE_TIERS`/`options.harnesses`-driven form produced both phantom and missing notes.

## Re-install / upgrade semantics

`installKitFile` (init.ts:465-481#"installedFiles[relativePath] = sha256(content);") drives every kit-owned file (templates, skills, per-role agent files, and, since 0.19.0, per-role-per-tier variant files, since the tier-rendering loops call the exact same closure):

- Path doesn't exist: write, record hash.
- Path exists and its current sha256 matches the hash recorded in the previous manifest ("unedited"): overwritten with the newly shipped content even without `--force` (init.ts:437-438#"// leftover shape as the full -> minimal profile downgrade above (a role"), this is how a kit version bump propagates (init.test.ts:255-275#"expect(readFileSync(templatePath,").
- Path exists and differs from shipped, with either a hash mismatch or no recorded hash: kept as-is and reported `conflicted` unless `--force`; the previous hash record is preserved rather than dropped (init.ts:439-443#"for (const harnessDir of previousHarnessDirs.map((harness) =>"), so a later upgrade still recognizes the file as edited (init.test.ts:311-326#"createHash(").
- A plain second run with no drift is a byte-for-byte no-op across every file, including the manifest, which is only rewritten when the computed `desired` object differs from `previous` (init.ts:578-611#"${JSON.stringify(manifest, null, 2)}\n", init.test.ts:129-142#"expect(report.updated).toEqual([]);"); since 0.19.0 this no-op also covers a `tiers: true` re-run, `test/init.test.ts:1594-1610#"reasoningEffort: high"` pins a second `tiers: true` run changing no file.
- 0.15.0: a `full` -> `minimal` downgrade is the one case where a plain re-run is *not* silent, see the manifest.json section above for the leftover-files note it prints. Since fix-round-1, `tiers: true` -> `tiers: false` is the same kind of not-silent case, via its own dedicated note block rather than by accreting onto the profile-downgrade one; before the fix it was a structurally identical leftover-files case that printed nothing at all (review finding M2, see "What `init` writes" above).

## Uninstall: exact removal surface

`runUninstall` (uninstall.ts:117-194#"return report;"):

1. For each `manifest.files` entry: re-check `isContainedRelativePath` (init.ts:103-106#"&& !normalized.startsWith(") defensively, a second time, right before the unlink (uninstall.ts:136-145#"continue;"); unlink when the on-disk sha256 matches the recorded hash or `--force`, otherwise keep and note "locally edited... re-run with --force" (uninstall.ts:157-164#"${path}: locally edited since install; re-run with --force to remove."). Path traversal is tested directly: an out-of-target or absolute manifest entry is never unlinked, even with `--force` (test/uninstall.test.ts:139-185#"rmSync(victim, { force: true });", unit table at 189-214).
2. `removeAgentsSection` (uninstall.ts:36-71#"${path} (workflow section)") removes exactly the fenced block via the same begin/end line-scan as install; if what remains is empty or exactly `AGENTS_MD_HEADING`, the file itself is deleted, otherwise the remainder is written back. A broken/duplicated fence is left in place and reported, mirroring install's conflict behavior (uninstall.ts:47-54#"${path}: marker fence is broken or duplicated; section left in place.").
3. `removeClaudeImport` (uninstall.ts:74-92#"${path} (@AGENTS.md import line)") deletes `CLAUDE.md` only if it is byte-identical to `CLAUDE_MD_BOILERPLATE`, otherwise strips only the `@AGENTS.md` line; an inline mention survives untouched (test/uninstall.test.ts:217-225#"Rules: see @AGENTS.md for the workflow.\n").
4. `manifest.json` is always deleted (uninstall.ts:172-175#"report.removed.push(manifestPath);").
5. `PRUNE_CANDIDATES` (uninstall.ts:99-110#".agents"), deepest-first, each removed only via `rmdirSync`, which throws (swallowed) on a non-empty directory (uninstall.ts:178-183#"// Not empty or not present; either way it stays."), so any directory holding surviving user content is left standing. `runUninstall` itself needs no profile- or tiers-specific logic: it only ever iterates `manifest.files`, so a `full` -> `minimal` downgrade's now-untracked `task-slicer.md`/`explorer.md`/`advisor.md` (since 0.21.0) are simply absent from that loop and are left on disk without comment (init.test.ts:857-872#"task-slicer.md/explorer.md are no longer in the manifest's file" confirms uninstall still completes without error in that case). Since 0.19.0, an install with `tiers: true` writes every `<role>-<tier>.md` path into `manifest.files` the same as any other kit-owned file (no separate ledger), so uninstalling a tiers-on install removes them the same way as the base agent files with no dedicated code (`test/init.test.ts:1730-1741#"expect(existsSync(explorerLowPath)).toBe(false);"` covers a fresh `tiers: true` install followed by `uninstall`, asserting a rendered variant file is gone afterward).
6. `.ai/runs/` is never touched by the removal loop and is explicitly noted as kept when present (uninstall.ts:187-190#"${runsDir}: run history kept; remove manually if no longer needed."); run history outlives uninstall by design.

## Tests

- test/init.test.ts: fresh-install shape, idempotence, six AGENTS.md-merge cases (preserve, restore-on-mangle, broken-fence conflict, inline-mention immunity, duplicated-fence conflict, empty-file append), CLAUDE.md import (append-once, inline-recognition), three hash-ledger upgrade cases, read-only-role posture on both harnesses including the Bash-guard string tripwire, since review round 1 (M2) iterating `READ_ONLY_ROLES` rather than a hardcoded `["explorer", "reviewer"]` pair so the advisor is covered automatically (init.test.ts:367-406#"expect(implementer).not.toContain(GUARD);"), plus a dedicated advisor-prompt substring-pin test for its necessity-check, never-decides, and first-turn-tool-call rules added the same round (init.test.ts:410-433#"Begin your very first turn with a tool call"), harness/model-mapping matrix, profile selection (minimal vs. full agent-file sets, manifest `profile` field, CLI re-run persist-vs-override semantics, the pre-0.15.0-manifest full-not-minimal fallback, the full -> minimal downgrade note and its uninstall interaction), kit-file conflicts with/without `--force`, input validation, harness detection, CLI smoke for both the default and opencode-catalog-empty paths. Since 0.19.0, a dedicated `describe("tier variants (\`--tiers\`)")` block (init.test.ts:1169-1726#"expect(report.updated).toEqual([]);") covers: the pre-0.19.0-manifest `tiers`-not-`false` degradation fallback, now with a content assertion on the default-file frontmatter shape since fix-round-1 review finding L1 (:1170-1227, five lines including the 0.22.0 `effort: medium` pin, not four); since 0.22.0, a dedicated two-target diff test asserting every role's default file is byte-for-byte identical whether `tiers` is `true` or `false` (:1229-1265); the exact file count (13 before 0.21.0, 15 since, advisor adds its own default file plus one `xhigh` variant, its only non-default tier) plus per-file model/effort assertions for `--profile full`, including a 0.21.0 anti-downgrade check that `advisor.md` stays `opus`, now with `effort: high` since 0.22.0 (was no `effort:` line before it), mirroring the pre-existing `reviewer.md` check (:1267-1323); the collision-free file set, since 0.21.0 also asserting `advisor-high.md` (advisor's own `DEFAULT_TIER`) is never rendered (:1325-1340); since 0.22.0, a dedicated opencode default-file test asserting reviewer/advisor get `variant: high` on an anthropic-resolved model while the three medium-default roles get no effort field, matching the pre-0.22.0 byte shape on that one axis (:1342-1386); the anthropic- and ollama-resolved-class tier-variant outcomes (Claude family gets `variant:`, Ollama gets no effort field, :1388-1446); a resolved class id with no provider prefix at all (no `/`) gets a `model:` line but likewise no effort field, the same no-op-field outcome as Ollama but reached via `opencodeEffortLine`'s (renamed from `opencodeVariantEffortLine` in 0.22.0) `provider === undefined` branch rather than its `provider === "ollama"` one (review round 3, R3-L4, :1448-1474, added after this bundle's own re-verification found the README's "Every other non-Claude-family model" bullet had silently implied this case did not exist); the non-Claude-family `reasoningEffort:` outcome (:1476-1496), extended since fix-round-1 (review finding M4) with two family-over-provider-id cases, `github-copilot/claude-*` and the nested `openrouter/anthropic/claude-*` (:1498-1546), and the unresolved-class-model no-file guard from review finding M1 (:1548-1586); a standalone tier-data invariant test, `DEFAULT_TIER[role]` is always a member of `ROLE_TIERS[role]` (:1588-1592); idempotence (:1594-1612); uninstall coverage (:1614-1626); the manifest `tiers: true` record (:1628-1634); and a nested `describe("CLI --tiers override-vs-persist")` (:1636-1725) covering the pre-existing persist-vs-override case plus, since fix-round-1, the `--no-tiers` default-off flagless-init case (review finding M5, the mutation tripwire for a hardcoded `const tiers = true` CLI resolution, since 0.21.0 asserting the 5-file default set), `--no-tiers` on a fresh install, the true -> false transition with its leftover note, and the tiers status appearing in both the "Found existing install" line and the closing summary (sub-citations not individually re-derived in this pass, out of the 0.22.0 diff's own scope: none of this nested describe's own content changed). Fix-round-1 also added two CLI-level tests in the opencode-catalog-empty `describe` (init.test.ts:1929-1948#"5 default files since 0.21.0 (advisor added, full-profile-only)") covering the unresolved-model-class stderr warning, and init.test.ts:1959-1979#"5 default files since 0.21.0 (advisor added, full-profile-only)" covering the fully-qualified-`--models`-does-not-bypass-class-resolution case (review finding M1); fix-round-2 (review finding R2-M3) strengthened both to assert the corrected warning's full wording (the real "no variant file rendered" effect and the opencode-only scope) instead of just the model-class name. Fix-round-2 also added a standalone `describe("leftover notes are ledger-driven, not enumeration-driven (review round 2, R2-M2)")` block (init.test.ts:941-1005#"The .opencode harness was only just added this run and was never", right after the profile-downgrade describe and before the kit-owned-file-conflicts one) with two `runInit`-level tests: an opencode install with every tier-class model unresolved (so the M1 guard writes zero variant files) followed by a tiers-off re-run asserts exactly 0 leftover notes, where the pre-fix `ROLE_TIERS`-driven loop would have produced 9 phantom notes (a historical figure from the four-role era this test's mutation probe measured; not re-measured against the current five-role `ROLES` since the pre-fix code path no longer exists to run); and a claude install with tiers on followed by a re-run that switches to `--harness opencode --no-tiers` asserts the real `.claude` variant leftovers are named for explorer, task-slicer, implementer, and reviewer, and that none mention `.opencode` (the test's own assertions never enumerated advisor's variant path or a total count, so this doc does not claim whether an `advisor-xhigh.md` note is now also present since 0.21.0; not re-verified here, out of this pass's scope), the harness-dropped case the pre-fix `options.harnesses`-driven loop missed entirely (it would have produced 0 notes since `.claude` was no longer in `options.harnesses`). Review round 3 (R3-L1) added a sibling `describe("profile-downgrade variant-file notes are ledger-driven too (review round 3, R3-L1)")` block (init.test.ts:1029-1063#"note) => !note.includes("), right after the R2-M2 block above: the R2-M2 mutation probe only ever exercised the *tiers-off* note loop's `previous.files`-gate, leaving the sibling gate inside the *full -> minimal profile-downgrade* loop's own tier-variant sub-loop (init.ts ~418) untested — a mutant that always pushes the note there (`if (true)`) survived the full suite even though the two loops share the same ledger-driven shape. The test combines an opencode install whose tier-class models never resolved (so, again, zero variant files were ever written) with a full -> minimal downgrade that still has tiers on, and asserts exactly the dropped roles' base-file notes with no phantom `-low.md`/`-high.md` variant notes; since 0.21.0 this is three dropped roles' worth of notes (explorer, task-slicer, advisor) rather than two, the test's own title and assertions updated to match (`test/init.test.ts:1030-1063#"note) => !note.includes("`) with no change to the ledger-driven mechanics itself, purely a consequence of `ROLES` growing by one.
- test/uninstall.test.ts: full init-uninstall roundtrip leaves an empty directory; user AGENTS.md/CLAUDE.md content and run history survive; edited-file retention with/without `--force`; three path-traversal-safety cases; `isContainedRelativePath` unit table; CLAUDE.md inline-import survival; damaged-fence and no-install-found error paths; CLI confirmation gating.
- opencode alias/model resolution (`parseOpencodeCatalog`, `detectProvider`, `resolveAlias`, `resolveOpencodeModels`) is exercised in test/opencode.test.ts; out of scope here, see [model-preselection.md](model-preselection.md) for the resolution rules and the per-role defaults recorded in `manifest.models`.

See [index.md](index.md) for the rest of this bundle.
