---
type: reference
title: Fixture doc for short-form citation tests
sources:
  - src/target.test.ts
  - src/note.md
---

# Short-form citations

Paragraph naming the target once, then citing sub-ranges by short form
alone: `src/target.test.ts:3-13` covers both blocks below. The second block
on its own is pinned again, :9-13; a bad start-line sub-citation is next
(:5-6); a bad end-line sub-citation is next (:4-5); and a colon-form
sub-citation with a bad start line is next, :11-11.

A short-form citation with nothing named earlier in its own paragraph:
(:99-101).

Markdown target, clean boundary: `src/note.md:2-4` establishes the target,
and :2-4 is the notice-free sub-citation.

Markdown target, bracket-only start line (notice, not warning):
`src/note.md:1-3` establishes the target, and :1-3 is the flagged
sub-citation.
