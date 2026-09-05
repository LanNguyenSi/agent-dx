# Tasks

## Delegated Acceptance Baseline

- **Baseline ID / revision:** baseline-demo / r1

| Criterion ID | Required | Exact criterion text | Verification definition | Negative space |
|---|---|---|---|---|
| P1-AC1 | yes | Automated artifact references resolve. | `npm test` exits 0. | Does not establish manual review quality. |
| P1-AC2 | yes | A reviewer judges the release note. | Reviewer examines `release-note.md`; passes only when the note names the migration boundary. | Does not establish command output. |
