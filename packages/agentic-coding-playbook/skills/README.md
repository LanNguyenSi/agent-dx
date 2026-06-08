# Skills

## English

Reusable agent-role prompts that operationalize the playbook's roles for local
coding workflows. A skill is short and bounded: an executable role, not a
playbook.

| Skill | Role |
|---|---|
| [`task-slicer.md`](./task-slicer.md) | Split a requested change into small, reviewable tasks. |
| [`implementation-agent.md`](./implementation-agent.md) | Implement exactly one assigned task (short form of the [Implementation Agent Standard](../standards/implementation-agent-standard.md)). |
| [`reviewer-agent.md`](./reviewer-agent.md) | Review a change against spec, evals, and constraints. |
| [`skeptic-agent.md`](./skeptic-agent.md) | Hunt for the ways a change could be wrong, unsafe, or misleading. |
| [`release-gate-agent.md`](./release-gate-agent.md) | Verify release readiness without deploying. |

Each skill has a German companion with the `.de.md` suffix. The skills are
tool-agnostic; paste them into whatever agent runtime you use.

## Deutsch

Wiederverwendbare Agentenrollen-Prompts, die die Rollen des Playbooks für
lokale Coding-Workflows operationalisieren. Ein Skill ist kurz und abgegrenzt:
eine ausführbare Rolle, kein Playbook.

| Skill | Rolle |
|---|---|
| [`task-slicer.de.md`](./task-slicer.de.md) | Eine angeforderte Änderung in kleine, reviewbare Tasks schneiden. |
| [`implementation-agent.de.md`](./implementation-agent.de.md) | Genau einen zugewiesenen Task umsetzen (Kurzform des [Implementierungs-Agent-Standards](../standards/implementierungs-agent-standard.md)). |
| [`reviewer-agent.de.md`](./reviewer-agent.de.md) | Eine Änderung gegen Spec, Evals und Constraints prüfen. |
| [`skeptic-agent.de.md`](./skeptic-agent.de.md) | Nach den Wegen suchen, auf denen eine Änderung falsch, unsicher oder irreführend sein könnte. |
| [`release-gate-agent.de.md`](./release-gate-agent.de.md) | Release-Reife prüfen, ohne zu deployen. |

Jeder Skill hat ein englisches Gegenstück ohne das `.de.md`-Suffix. Die Skills
sind tool-agnostisch; füge sie in die von dir genutzte Agent-Runtime ein.
