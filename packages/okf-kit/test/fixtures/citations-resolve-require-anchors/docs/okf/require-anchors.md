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
  - src/last-line.test.ts
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
not a test file, even though line 3 is a real top-level `it(` call after the range's start: `src/straddle-plain.ts:1-5`.

A full citation citing a whole `describe` block, including its own nested
`it(` heads: the nested heads are not a straddle, they are exactly what
the citation is about: `src/straddle.test.ts:25-33`.

A full citation whose range both straddles into a sibling block's head
line AND carries a string anchor that is not found anywhere in the range
-- both problems are reported, not just the first one found:
`src/straddle.test.ts:6-9#"typo text not present"`.

A whole `it` block citation ending on a bare `});` line, anchored on the
last real content line before it (no finding):
`src/last-line.test.ts:4-7#"expect(value).toBe(1)"`.

The same whole `it` block citation, anchored two content lines up instead
of on the last content line (flagged):
`src/last-line.test.ts:4-7#"const value = 1"`.

A range that itself ends on a real content line (no closing-boilerplate
carve-out applies), anchored on the line before it (flagged, unchanged
behaviour): `src/last-line.test.ts:5-6#"const value = 1"`.

A full citation starting inside one `it` body and running into a top-level
`test.each(` head (the only block head inside the range), a straddle:
`src/straddle.test.ts:31-36`.

A range whose last content line is a comment: the anchor must sit on that
comment line, so an anchor on the expect line above it is flagged:
`src/last-line.test.ts:11-14#"expect(marker).toBe(2)"`.

The same range anchored on the trailing comment line (no finding):
`src/last-line.test.ts:11-14#"// trailing note"`.

An unanchored citation into a note file, used by the glob allowlist tests:
`src/note.md:1-1`.
