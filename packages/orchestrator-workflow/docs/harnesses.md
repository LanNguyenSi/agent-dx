# Harnesses: installed files and read-only posture

See the [package README](../README.md) for install commands and the rest of
the CLI surface.

Each installed skill includes the compact `SKILL.md` entrypoint and every
regular Markdown file from its adjacent `references/` directory. The entrypoint
routes run-state/harness, contracts, evidence/probes, and review/recovery work
to those files; references are part of the installed skill, not optional docs.

| Harness | Files | Notes |
|---|---|---|
| Claude Code | `.claude/skills/orchestrator-workflow/{SKILL.md,references/*.md}`, `.claude/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md`, `CLAUDE.md` | Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the installer adds an additive `@AGENTS.md` import. Subagent models go into the `model:` frontmatter; the read-only explorer, reviewer, and advisor also get `disallowedTools: Edit, Write, NotebookEdit`. |
| OpenAI Codex | `.agents/skills/orchestrator-workflow/{SKILL.md,references/*.md}`, `.codex/agents/{explorer,task-slicer,implementer,reviewer,advisor}.toml` | Codex reads `AGENTS.md` natively. Native custom-agent files carry the canonical role instructions plus `model` and `model_reasoning_effort`. Explorer and advisor request a read-only sandbox; reviewer inherits the caller's sandbox so it can run temporary/build checks, while its prompt prohibits source edits. |
| opencode | `.opencode/skills/orchestrator-workflow/{SKILL.md,references/*.md}`, `.opencode/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md` | opencode reads `AGENTS.md` natively. Subagents get `mode: subagent`; the read-only explorer, reviewer, and advisor also get `permission: edit: deny`. Model resolution is described in [Model routing reference](model-routing-reference.md). |

**Read-only posture, honestly stated.** Claude Code disables file-mutation
tools for explorer, reviewer, and advisor; opencode denies edits for those
roles. Codex requests a read-only sandbox for explorer and advisor. Its
reviewer inherits the caller's sandbox so temporary/build checks remain
possible, while its prompt prohibits source edits. In inherited or otherwise
write-enabled sandboxes, shell-level mutation (`git checkout`,
`git restore`, `git clean`, `git stash`, `git reset`, `sed -i`, redirecting
output into a file, which the reviewer may do only inside its write boundary below) is guarded by instruction only: the agent prompts forbid
it explicitly, but the role definition itself does not prevent it. A native
read-only sandbox can block those writes. This residual has bitten in practice (a
reviewer ran `git checkout` and discarded uncommitted work), which is why the
prompts now name the forbidden commands instead of just saying "read-only".
The reviewer's own write boundary is narrower than "read-only": it may write
to its own scratchpad (a scratch copy or replay of the repository) and to
the run directory's `evidence/`, and nowhere else. It never writes into the
reviewed tree, its index, its refs, or its object store: no `git fetch`, no
`git merge-tree --write-tree`, no `git update-ref`, no `git gc`, on top of
the working-tree and index mutations already forbidden above. A write a
declared check or the probe runner's own isolation leaves behind is expected
wherever that tool places it, not an exception to this rule.
Marker- or verdict-style enforcement of the Bash residual (sandboxing,
PreToolUse hooks) is harness territory and out of this kit's scope.
