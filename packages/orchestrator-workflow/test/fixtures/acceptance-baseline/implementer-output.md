# Implementer return (illustrative; not measured product evidence)

```yaml
status: done
role: implementer
task_id: T-001
acceptance_baseline:
  id: baseline-demo
  revision: r1
criterion_evidence:
  - criterion_id: P1-AC1
    evidence_refs:
      - results/attempt-01.json
  - criterion_id: P1-AC2
    evidence_refs:
      - reviews/release-note-r7.md
summary:
  - Illustrative delivery with automated and manual evidence.
changed_files:
  - path: release-note.md
    reason: Describe the migration boundary.
tests:
  executed:
    - results/attempt-01.json
  added_or_updated: []
  not_executed_reason: ""
mutation_probes: []
risks: []
open_questions: []
recommendation: review
commits: []
```
