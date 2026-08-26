---
type: reference
title: Fixture doc for the --require-anchors opt-in
sources:
  - README.md
  - src/note.md
  - src/target.ts
  - src/target.test.ts
---

# Require-anchors opt-in

An anchored full citation, unaffected by the opt-in: `src/note.md:2-2#"Second line"`.

An unanchored full citation into an in-repo file, flagged anchor-required
only when the opt-in is on: `src/target.ts:2`.

An unanchored full citation into an allowlisted target, never flagged:
`README.md:1`.

A string anchor found once but not on the last line of its cited range:
`src/note.md:1-2#"First line"`.

A string anchor occurring twice inside its own cited range:
`src/target.ts:1-4#"dup marker"`.

A full citation into a test file whose range starts on a real `it(` head
line but ends on a different block's own `it(` head line, straddling out
of the block it started in: `src/target.test.ts:4-10`.
