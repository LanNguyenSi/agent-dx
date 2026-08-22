---
type: reference
title: Fixture doc for okf-citations-resolve tests
sources:
  - src/target.ts
  - src/note.md
---

# Sample

Good citation, lands on real content: `src/target.ts:1`.

Drifted citation, an edit shifted `bar` down and this now lands on the
blank line where `foo`'s closing brace used to be followed by: `src/target.ts:4`.

Closing-brace-only citation, a classic "still in range, still non-blank,
still wrong" post-edit citation: `src/target.ts:3`.

Range-exceeds-file citation: `src/target.ts:50`.

Missing-file citation: `does-not-exist.ts:1`.

Markdown-target blank-start citation: `src/note.md:1`.
