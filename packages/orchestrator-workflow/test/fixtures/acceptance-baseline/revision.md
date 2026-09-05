# Acceptance baseline revision (illustrative; not measured product evidence)

- Old revision: baseline-demo / r1
- New revision: baseline-demo / r2
- Affected IDs: P1-AC2
- Decision authority: [D-002 approval](decisions/D-002.md)
- Reason: operator-approved scope clarification.

```yaml
old_record:
  id: P1-AC2
  required: true
  text: A reviewer judges the release note.
  verification: Reviewer examines release-note.md; passes only when the note names the migration boundary.
  negative_space: Does not establish command output.
new_record:
  id: P1-AC2
  required: true
  text: A reviewer judges the updated release note.
  verification: Reviewer examines release-note.md; passes only when the note names the revised migration boundary.
  negative_space: Does not establish command output.
```

- Invalidated evidence: [prior manual review](reviews/release-note-r7.md); rerun required and pending for P1-AC2 at r2.
- Revised frozen records: [r2 baseline](revised-00-goal.md) and [r2 task](revised-02-tasks.md).
- Carry-forward for P1-AC1: [verified comparison](reviews/carry-forward-r2.md) compares the unchanged record, producer artifact, repository state, and check definition; only that evidence remains valid at r2.
- Acceptance: pending; the invalidated required manual criterion still blocks acceptance.
