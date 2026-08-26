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

A stray hash in prose, not glued to any citation range at all, is not a
citation and produces nothing: this doc uses # to mark headings.
