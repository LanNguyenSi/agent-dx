---
type: reference
title: Fixture doc for continuation-citation tests
sources:
  - src/target.ts
---

# Continuations

Fresh single-line continuation on real content, no finding: `src/target.ts:1`,
then `:2` here.

Fresh single-line continuation landing on the blank line: `src/target.ts:1`,
then `:4` here.

Dash-form split range whose end legitimately lands on a closing brace, not
drift: `src/target.ts:1`-`3`.

Colon-form split range whose end legitimately lands on a closing brace, not
drift: `src/target.ts:5`–`:7`.

Dash-form split range whose end exceeds the file: `src/target.ts:1`-`50`.

Parenthesized fresh continuation landing on a closing-brace-only line (not
an extension, so it IS flagged, unlike the dash-form range end above):
`src/target.ts:1` (`3`).

Path-traversal citedPath, rejected without ever being resolved:
`../evil.ts:1`.

A continuation right after a rejected citation has nothing to validate
against and is silently skipped, not falsely inherited from further up the
doc: `:4` (the blank line, so a wrong inheritance would actually flag it).

Full citation with an inverted embedded range, end before start:
`src/target.ts:5-3`.

Dash-form split range whose end is before its start, an inverted range:
`src/target.ts:5`-`3`.

Dash-form split range whose start is blank: the full citation alone already
flags it, so the cont-ext extension must not re-flag the same start line a
second time: `src/target.ts:4`-`6`.
