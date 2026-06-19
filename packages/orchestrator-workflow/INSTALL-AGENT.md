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

1. **Locate existing harness configs** in the repo root and report them to
   you (Claude Code, opencode, Codex marker files; full list in step 1
   below).
2. **Ask you, not guess**: which harnesses should get adapters, and which
   model each subagent role (explorer, task-slicer, implementer, reviewer)
   should use. Suggested defaults: explorer `sonnet`, task-slicer `sonnet`,
   implementer `sonnet`, reviewer `opus`.
3. **Run the non-interactive installer** with your answers:
   `npx orchestrator-workflow init --yes --harness ... --models ...`.
   If the installer reports conflicts with locally edited files, the agent
   shows them to you and asks before any `--force` re-run.
4. **Manual fallback only when npx or the registry is unavailable**: create
   the same files by hand from this repository's `assets/` directory,
   following the byte-precise rules in step 4 below.
5. **Report back**: which harnesses were installed, which model each role
   uses, and any conflicts left in place.

### Write surface

The install creates or touches only these paths:

- `.ai/workflow/templates/00-goal.md` through `06-handoff.md`,
  `.ai/workflow/manifest.json`, `.ai/runs/.gitkeep` (new files)
- `AGENTS.md`: the marker-fenced workflow section is appended (file created
  when missing); content outside the
  `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->`
  markers is never modified
- `CLAUDE.md`: one `@AGENTS.md` import line appended when missing; the file
  is created with a short heading when absent (Claude Code harness only)
- `.claude/skills/orchestrator-workflow/SKILL.md` and
  `.claude/agents/{explorer,task-slicer,implementer,reviewer}.md` (Claude Code)
- `.agents/skills/orchestrator-workflow/SKILL.md` (Codex)
- `.opencode/skills/orchestrator-workflow/SKILL.md` and
  `.opencode/agents/{explorer,task-slicer,implementer,reviewer}.md` (opencode)

Nothing else in the repository is modified. Locally edited files are
reported as conflicts and left alone, never overwritten silently; the
exceptions are the kit-owned surfaces: `.ai/workflow/manifest.json` (the
kit's state file, rewritten whenever the applied state changes) and the
fenced AGENTS.md section itself, which is restored on re-run. The install
is fully reversible: `npx orchestrator-workflow uninstall` removes exactly
this write surface again, keeping run history under `.ai/runs/` and any
locally edited files. Network access is limited to the npm registry (for
`npx`) and, in the manual fallback, this repository on github.com /
raw.githubusercontent.com.

## Instructions for the agent

You are a coding agent that was pointed at this file. Execute the following
steps in the repository you were asked to install into.

1. Detect existing harness configs in the repo root: `.claude/` or
   `CLAUDE.md` (Claude Code), `.opencode/`, `opencode.json` or
   `opencode.jsonc` (opencode), `.agents/` or `.codex/` (Codex). Tell the
   operator what you found.

2. Ask the operator, do not guess:
   - Which harnesses should get adapters: claude, codex, opencode?
     Suggest the detected ones.
   - Which model for each subagent role? Suggest the defaults:
     explorer `sonnet`, task-slicer `sonnet`, implementer `sonnet`,
     reviewer `opus`. Accept the aliases `sonnet`, `opus`, `haiku` or a
     full model id.

3. Run the non-interactive installer with the operator's answers:

   ```bash
   npx orchestrator-workflow init --yes \
     --harness <claude,codex,opencode> \
     --models "explorer=<model>,task-slicer=<model>,implementer=<model>,reviewer=<model>"
   ```

   If the command reports conflicts, show them to the operator and ask
   before re-running with --force.

4. Only if npx or the registry is unavailable, scaffold manually from
   https://github.com/LanNguyenSi/agent-dx/tree/master/packages/orchestrator-workflow/assets

   - `.ai/workflow/templates/00-goal.md` through `06-handoff.md` from
     `assets/templates/`, unchanged.
   - `.ai/runs/.gitkeep`, empty.
   - Append the content of `assets/agents-md-section.md` to `AGENTS.md`
     (create the file when missing; the installer starts a fresh file with a
     `# Agent instructions` heading). Never change anything outside the
     `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->`
     markers.
   - Claude Code: `.claude/skills/orchestrator-workflow/SKILL.md` from
     `assets/skill/SKILL.md`. For each role, `.claude/agents/<role>.md` from
     `assets/agents/<role>.md` with `model: <operator's choice>` added as a
     new line directly after the `description:` line (that placement matches
     the installer's output byte for byte). For the explorer role
     additionally, `disallowedTools: Edit, Write, NotebookEdit` goes on a new
     line directly after the `model:` line. Ensure `CLAUDE.md` exists and
     contains a line `@AGENTS.md`.
   - Codex: `.agents/skills/orchestrator-workflow/SKILL.md`, same skill file.
   - opencode: `.opencode/skills/orchestrator-workflow/SKILL.md` from
     `assets/skill/SKILL.md`, unchanged.
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
     correct. For the explorer role additionally, `permission:` goes on a new
     line directly after `mode: subagent` (or after `model:` when that line is
     present), followed by `  edit: deny` (two-space indent) on the next line.
     Example explorer frontmatter when no model is resolved:
     ```yaml
     ---
     description: "..."
     mode: subagent
     permission:
       edit: deny
     ---
     ```
   - `.ai/workflow/manifest.json`, exactly this shape (harnesses MUST be an
     array, models keyed by role, version = the kit version you installed):

     ```json
     {
       "kit": "orchestrator-workflow",
       "version": "0.5.0",
       "harnesses": ["claude", "opencode"],
       "models": {
         "explorer": "sonnet",
         "task-slicer": "sonnet",
         "implementer": "sonnet",
         "reviewer": "opus"
       },
       "files": {},
       "installedAt": "2026-06-12T00:00:00.000Z"
     }
     ```

     A manual install may leave the `files` hash map empty; a later `init`
     run then treats existing kit files conservatively and reports conflicts
     rather than overwriting them.

5. Report back to the operator: which harnesses were installed, which model
   each role uses, and any conflicts that were left in place.
