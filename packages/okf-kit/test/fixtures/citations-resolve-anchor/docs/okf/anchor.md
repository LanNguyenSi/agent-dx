---
type: reference
title: Fixture doc for anchored citation tests
sources:
  - src/CHANGELOG.md
  - src/note.md
---

# Anchored citations

A good heading-anchored citation, fully enclosed by its own release section:
`src/CHANGELOG.md:7-8#2.0.0`.

Bracket-wrapped heading anchor form, same release, a different sub-range:
`src/CHANGELOG.md:8-9#[2.0.0]`.

A heading-anchored citation whose range crosses into the next release
section: `src/CHANGELOG.md:9-19#2.0.0`.

A heading-anchored citation whose enclosing section is correct but whose
anchor text names the wrong release: `src/CHANGELOG.md:13-13#1.0.0`.

A heading-anchored citation landing above the target's first heading:
`src/CHANGELOG.md:1-1#2.0.0`.

A good string-anchored citation: `src/note.md:2-2#"Second line"`.

A string-anchored citation whose text does not occur in the cited range:
`src/note.md:2-3#"nonexistent phrase"`.

An ordinary anchorless citation, unaffected by any of the above:
`src/note.md:1`.
