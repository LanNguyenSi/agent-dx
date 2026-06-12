# Installing via a coding agent

The interactive installer asks a human questions on a TTY. When the install
should be done by a coding agent instead (Claude Code, Codex, opencode), the
agent takes over that interactivity: it asks the operator the same questions
in chat, then runs the non-interactive CLI, or scaffolds manually where npx
is unavailable.

Paste the prompt below to your agent, as is.

---

Install the orchestrator-workflow kit into this repository.

1. Detect existing harness configs in the repo root: `.claude/` or
   `CLAUDE.md` (Claude Code), `.opencode/`, `opencode.json` or
   `opencode.jsonc` (opencode), `.agents/` or `.codex/` (Codex). Tell the
   operator what you found.

2. Ask the operator, do not guess:
   - Which harnesses should get adapters: claude, codex, opencode?
     Suggest the detected ones.
   - Which model for each subagent role? Suggest the defaults:
     task-slicer `sonnet`, implementer `sonnet`, reviewer `opus`.
     Accept the aliases `sonnet`, `opus`, `haiku` or a full model id.

3. Run the non-interactive installer with the operator's answers:

   ```bash
   npx orchestrator-workflow init --yes \
     --harness <claude,codex,opencode> \
     --models "task-slicer=<model>,implementer=<model>,reviewer=<model>"
   ```

   If the command reports conflicts, show them to the operator and ask
   before re-running with --force.

4. Only if npx or the registry is unavailable, scaffold manually from
   https://github.com/LanNguyenSi/agent-dx/tree/master/packages/orchestrator-workflow/assets

   - `.ai/workflow/templates/00-goal.md` through `06-handoff.md` from
     `assets/templates/`, unchanged.
   - `.ai/runs/.gitkeep`, empty.
   - Append the content of `assets/agents-md-section.md` to `AGENTS.md`
     (create the file when missing). Never change anything outside the
     `<!-- orchestrator-workflow:begin -->` / `<!-- orchestrator-workflow:end -->`
     markers.
   - Claude Code: `.claude/skills/orchestrator-workflow/SKILL.md` from
     `assets/skill/SKILL.md`. For each role, `.claude/agents/<role>.md` from
     `assets/agents/<role>.md` with `model: <operator's choice>` added as a
     new line directly after the `description:` line (that placement matches
     the installer's output byte for byte). Ensure `CLAUDE.md` exists and
     contains a line `@AGENTS.md`.
   - Codex: `.agents/skills/orchestrator-workflow/SKILL.md`, same skill file.
   - opencode: `.opencode/agents/<role>.md` from `assets/agents/<role>.md`,
     with the frontmatter rewritten to exactly this order: `description:`
     (unchanged), then `mode: subagent`, then `model: <provider/model-id>`;
     the `name:` line is dropped. Aliases map to
     `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-8`,
     `anthropic/claude-haiku-4-5`.
   - `.ai/workflow/manifest.json`, exactly this shape (harnesses MUST be an
     array, models keyed by role):

     ```json
     {
       "kit": "orchestrator-workflow",
       "version": "0.1.0",
       "harnesses": ["claude", "opencode"],
       "models": {
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
