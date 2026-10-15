---
type: reference
title: Fixture doc for okf-citations-resolve .prisma target tests
sources:
  - src/target.ts
  - prisma/schema.prisma
---

# Sample

Range-exceeds-file citation into a `.prisma` target: `prisma/schema.prisma:999`.

Range-exceeds-file control citation into a `.ts` target: `src/target.ts:999`.

In-range `.prisma` citation, real content: `prisma/schema.prisma:7`.

Closing-brace-only `.prisma` citation: `prisma/schema.prisma:10`.
