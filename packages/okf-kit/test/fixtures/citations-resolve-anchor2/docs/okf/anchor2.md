---
type: reference
title: Fixture doc for anchored citation review-round-1 fixes
sources:
  - src/CHANGELOG.md
  - src/note.md
  - src/fenced.md
  - src/fenced-plain.md
  - src/code.ts
---

# Anchored citations, round 2

## Fenced code block exclusion

A heading-anchored citation whose target contains a fenced code block with
a hash-prefixed comment line: src/fenced.md:1-10#3.0.0. The fenced comment
must not be mistaken for a heading.

The same content without fence markers, where the hash-prefixed line
really is a heading and correctly ends the enclosing section:
src/fenced-plain.md:1-8#3.0.0.

A heading-anchored citation whose START line already lies after the fenced
comment, so the backward heading search must skip the fenced line on its
way up: src/fenced.md:10-10#3.0.0.

## Anchor charset

A heading anchor ending a sentence with a trailing period, which must not
become part of the captured anchor text: src/CHANGELOG.md:5-6#2.0.0.

A heading anchor with a hyphenated suffix, captured whole and mismatched
against a heading that only names the base version:
src/CHANGELOG.md:5-7#2.0.0-rc1.

A heading anchor with an internal hyphen and no digits at all, also
captured whole: src/CHANGELOG.md:6-7#some-anchor.

## Bracket stripping

A bracket-wrapped anchor matched against a heading that has no brackets at
all in its own text: src/CHANGELOG.md:11#[3.0.0].

## Single-line anchors and a non-Markdown string anchor

A single-line heading-anchored citation: src/CHANGELOG.md:5#2.0.0.

A string-anchored citation against a non-Markdown target, found:
src/code.ts:1#"verifyVerdict".

A string-anchored citation against a non-Markdown target, not found:
src/code.ts:2#"verifyVerdict".

An anchored full citation followed by a short-form sibling in the same
paragraph, which still binds and is checked: src/CHANGELOG.md:5-8#2.0.0,
:20-21 covers more detail.

## Bounded string anchor

A malformed quoted anchor with no immediate closing quote: src/note.md:1#"unterminated
anchor text that keeps going across this line break and swallows what
comes next: src/note.md:10-11 until it finally reaches a real quote "here.
