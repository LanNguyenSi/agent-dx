# Goal

## Acceptance Baseline

Acceptance contract: acceptance-baseline/v1

```yaml
acceptance_baseline:
  id: baseline-demo
  revision: r2
acceptance_criteria:
  - id: P1-AC1
    required: true
    text: Automated artifact references resolve.
    verification: npm test exits 0.
    negative_space: Does not establish manual review quality.
  - id: P1-AC2
    required: true
    text: A reviewer judges the updated release note.
    verification: Reviewer examines release-note.md; passes only when the note names the revised migration boundary.
    negative_space: Does not establish command output.
```
