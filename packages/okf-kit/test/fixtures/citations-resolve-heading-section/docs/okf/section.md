---
type: reference
title: Fixture doc for heading-section citation tests
sources:
  - src/CHANGELOG.md
---

# Heading-section citations

A good whole-section citation, no content anchor: `src/CHANGELOG.md#2.0.0`.

A good content anchor, present exactly once in the section:
`src/CHANGELOG.md#2.0.0#"important detail noted once here"`.

A content anchor absent from the section:
`src/CHANGELOG.md#2.0.0#"nonexistent phrase xyz"`.

A content anchor present on two lines of the section:
`src/CHANGELOG.md#2.0.0#"TODO"`.

A heading that does not exist anywhere in the target:
`src/CHANGELOG.md#9.9.9`.

A heading whose text matches more than one heading in the target:
`src/CHANGELOG.md#1.0.0`.

A heading whose section has no non-blank content before the next heading:
`src/CHANGELOG.md#0.9.0`.
