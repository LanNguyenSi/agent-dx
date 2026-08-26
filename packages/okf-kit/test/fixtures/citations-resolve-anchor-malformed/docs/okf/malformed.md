---
type: reference
title: Fixture doc for anchor-malformed citations
sources:
  - src/short.md
  - src/note.md
---

# Malformed anchor citations

A backtick inside a quoted anchor breaks the string grammar and is left
unparsed, not silently treated as a real string anchor: src/short.md:3-3#"body `line` one".

A hash with nothing after it, right at the end of a line, is also left
unparsed: src/note.md:2#

A valid string anchor is unaffected by any of the above: src/short.md:1#"intro".

An ordinary anchorless citation (no `#` at all) is also unaffected: this
is the negative control for "no citation range precedes a stray hash":
src/note.md:1.

A stray hash in prose, not glued to any citation range at all, is not a
citation and produces nothing: this doc uses # to mark headings.

## Out-of-scope citations are not checked at all

A malformed anchor on an absolute (out-of-scope) path is skipped exactly
like every other check on an absolute path: /abs/path.md:1-2#"x.

A malformed anchor on a citedPath containing a `..` segment is rejected as
path-traversal without ever reaching the anchor check, exactly like every
other check on such a path: ../outside.md:1-2#.

## Raw fragment is bounded

A heading-form typo immediately followed by more prose on the same line
must only capture up to the first whitespace, not run on into that prose:
src/short.md:2-2#:~:text=hello here is unrelated prose that must not leak
into the raw fragment.
