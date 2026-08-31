---
type: reference
title: Fixture doc for the --require-anchors continuation check
sources:
  - src/target.ts
---

# Require-anchors continuations

A colon-form continuation of an anchored full citation, resolving cleanly
in default mode: `src/target.ts:1#"foo"`, then `:2` here.

A dash-form split range whose end legitimately lands on a closing brace,
resolving cleanly in default mode: `src/target.ts:5#"bar"`-`7`.

A parenthesized fresh continuation on real content, resolving cleanly in
default mode: `src/target.ts:9#"baz"` (`10`).

An anchored full citation with no continuation at all in this sentence:
`src/target.ts:13#"qux"`.

A colon-form continuation drifted onto a blank line, already flagged in
default mode by the existing blank-start-line check:
`src/target.ts:2#"return 1"`, then `:4` here.

A dash-form split range whose end drifted past the end of the file,
already flagged in default mode by the existing range-exceeds-file check:
`src/target.ts:6#"return 2"`-`50`.

A short-form continuation of an anchored full range citation, resolving
cleanly in default mode: `src/target.ts:17-19#"return 5"`, and :17-19
later in the same sentence.

A colon-form fresh continuation chained further by a dash-form extension,
both off a single anchored full citation, resolving cleanly in default
mode: `src/target.ts:17#"quux"`, then `:18` here, continuing to -`19`.
