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

- Invalidated evidence: `reviews/release-note-r7.md`; rerun required and pending.
- Carry-forward comparison for P1-AC1: command `npm test`, repository state
  `abc123+dirty:sha256:example`, and artifact `results/attempt-01.json` are
  unchanged between r1 and r2; its evidence remains valid.
