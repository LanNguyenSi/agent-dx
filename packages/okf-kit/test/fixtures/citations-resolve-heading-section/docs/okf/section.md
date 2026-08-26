---
type: reference
title: Fixture doc for heading-section citation tests
sources:
  - src/CHANGELOG.md
---

# Heading-section citations

A good whole-section citation, no content anchor: `src/CHANGELOG.md:#2.0.0`.

A good content anchor, present exactly once in the section:
`src/CHANGELOG.md:#2.0.0#"important detail noted once here"`.

A content anchor absent from the section:
`src/CHANGELOG.md:#2.0.0#"nonexistent phrase xyz"`.

A content anchor present on two lines of the section:
`src/CHANGELOG.md:#2.0.0#"TODO"`.

A heading that does not exist anywhere in the target:
`src/CHANGELOG.md:#9.9.9`.

A heading whose text matches more than one heading in the target:
`src/CHANGELOG.md:#1.0.0`.

A heading whose section has no non-blank content before the next heading:
`src/CHANGELOG.md:#0.9.0`.

A level-3 heading name, capped out by the level-2 search (pins the level cap):
`src/CHANGELOG.md:#Fixed`.

A `#`-led line inside a fenced code block in the target is not collected as
a heading (pins fence awareness):
`src/CHANGELOG.md:#fakeheading`.

The same fence does not act as a section boundary either: the 2.0.0 section
still reaches past it to content that comes after the fence in the target:
`src/CHANGELOG.md:#2.0.0#"delta"`.

A content anchor present once inside the cited section and once in a
different section resolves against the cited section only (section-scoped
counting, not a global count across the whole target):
`src/CHANGELOG.md:#2.0.0#"cross-section marker phrase"`.

A content anchor present only outside the cited section is not found
(section-scoped counting again, the other direction):
`src/CHANGELOG.md:#2.0.0#"outside-only phrase"`.

A malformed heading-section citation attempt, an unterminated content-anchor
quote, is still reported rather than silently vanishing:
`src/CHANGELOG.md:#2.0.0#"unclosed`.

A malformed heading-section citation attempt, an unquoted third segment:
`src/CHANGELOG.md:#2.0.0#extra`.

A malformed heading-section citation attempt, a non-`.md` target (the strict
form never matches a non-Markdown path at all):
`package.json:#version`.
