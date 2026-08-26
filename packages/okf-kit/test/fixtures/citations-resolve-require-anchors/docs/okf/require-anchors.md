---
type: reference
title: Fixture doc for the --require-anchors opt-in
sources:
  - README.md
  - src/note.md
  - src/target.ts
  - src/target.test.ts
  - src/straddle.test.ts
  - src/straddle-plain.ts
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
line but crosses into a different block's own `describe(` head line,
straddling out of the block it started in: `src/target.test.ts:4-10`.

A full citation into a test file whose range ends on an `it(` head line:
`src/straddle.test.ts:6-8`.

A full citation into a test file whose range contains an `it(` head line
strictly inside it, not on the last line: `src/straddle.test.ts:6-9`.

A full citation into a test file starting on a `describe(` head and
staying inside its body, ending before the nested block head:
`src/straddle.test.ts:13-14`.

A full citation entirely inside an `it(` body: `src/straddle.test.ts:21-22`.

A full citation into a non-test `.ts` file whose content happens to
contain the text `it(`: never checked for straddling since the target is
not a test file: `src/straddle-plain.ts:1-3`.
