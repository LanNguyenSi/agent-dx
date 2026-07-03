/**
 * Scaffold content for `okf-kit init`. Everything here is static except the
 * `timestamp` value, which the caller (src/init.ts) fills in with the real
 * current instant at generation time: never hardcode an artificial
 * midnight datetime here, that is exactly the lesson this kit is built to
 * enforce (see FRONTMATTER_GUIDANCE below).
 */

const FRONTMATTER_GUIDANCE = `<!--
okf-kit init guidance (delete this comment once the doc is written):
- \`timestamp\` means "last verified against sources", not "created on".
  Bump it (and add a line to this bundle's log.md) every time you
  re-verify this doc against its sources; never hand-write an artificial
  midnight datetime, use the real instant you did the verification.
- \`sources\` lists the repo-root-relative paths this doc DESCRIBES (code,
  config, or other docs elsewhere in the repo). Never list this bundle's
  own directory: a bundle directory changes on every doc edit, so a
  self-referential \`sources\` entry goes permanently stale. This happened
  to the OKF pilot's own BENCHMARK.md (agent-tasks docs/okf/BENCHMARK.md),
  which is why this template ships with a placeholder instead of a real
  path: \`okf-kit check\` will report that placeholder as a missing source
  path until you replace it, and that is intentional, not a bug.
-->`;

const BENCHMARK_FRONTMATTER_GUIDANCE = `<!--
okf-kit init guidance (delete this comment once the doc is written):
- \`timestamp\` means "last verified", not "created on"; bump it (and add a
  line to this bundle's log.md) whenever this record is updated. Never
  hand-write an artificial midnight datetime.
- This template intentionally has no \`sources:\` key. A benchmark record
  documents a measurement protocol and its results, not a piece of the
  codebase, so there is nothing it "describes" in the sources-shape sense.
  The OKF pilot's own BENCHMARK.md carried \`sources: [docs/okf/]\`,
  pointing at its own bundle directory; that "source" changed on every
  edit to the bundle and was permanently, uselessly stale. Don't repeat
  that mistake: omit \`sources\` here rather than pointing it at yourself.
-->`;

const BODY_GUIDANCE = `<!--
Write dense, source-verified prose: name exact mechanisms (function/class/
route names), exact file paths, and exact identifiers (config keys, env
vars, error codes). Avoid filler like "this module handles X" without
naming the function that does it. Every sentence here should be checkable
against a source in \`sources:\` above.
-->`;

export function indexTemplate(): string {
  return `# Knowledge bundle index

Scaffolded by \`okf-kit init\`. Replace this placeholder index with a real
map of the docs in this bundle as you add and rename them.

## Overview

- [Overview template](overview-template.md), start here for the big picture: what this area covers and where to read next.

## Modules

- [Module template](module-template.md), one doc per module: responsibility, entry points, key files.

## Invariants

- [Invariant template](invariant-template.md), one doc per invariant: the guarantee, where it's enforced, what would break it.

## Runbooks

- [Runbook template](runbook-template.md), one doc per operational procedure: preconditions, steps, verification.

## Benchmark

- [Benchmark template](benchmark-template.md), measure whether this bundle actually improves discovery, before and after it lands.
`;
}

export function logTemplate(timestamp: string): string {
  return `# Log

- ${timestamp}, bundle scaffolded by \`okf-kit init\`.
`;
}

export function overviewTemplate(timestamp: string): string {
  return `---
type: overview
title: <component/area> overview
description: Orientation doc, what this area covers and where to start reading.
tags: [overview]
timestamp: ${timestamp}
sources:
  - path/to/covered/source
---

${FRONTMATTER_GUIDANCE}

# <Component/area> overview

${BODY_GUIDANCE}

## What this covers

- <One or two sentences: what area of the system this overview orients a reader to.>

## Where to start reading

- <Exact entry-point file and function/route, e.g. \`src/server.ts\`, \`createApp()\`.>

## Key modules

- [Module template](module-template.md), <one line: what this module doc models, once renamed.>
`;
}

export function moduleTemplate(timestamp: string): string {
  return `---
type: module
title: <module name>
description: What this module owns, its entry points, and its key files.
tags: [module]
timestamp: ${timestamp}
sources:
  - path/to/covered/source
---

${FRONTMATTER_GUIDANCE}

# <Module name>

${BODY_GUIDANCE}

## Responsibility

- <One sentence: what this module owns, and one sentence on what it explicitly does NOT own.>

## Entry points

- <Exact function/class/route name>, \`<file path>\`

## Key files

- \`<path>\`, <one line: what lives here>

## Invariants enforced here

- [Invariant template](invariant-template.md), <link to the specific invariant doc, once renamed, if this module enforces one>
`;
}

export function invariantTemplate(timestamp: string): string {
  return `---
type: invariant
title: <invariant name>
description: A falsifiable invariant, where it is enforced, and what breaks it.
tags: [invariant]
timestamp: ${timestamp}
sources:
  - path/to/covered/source
---

${FRONTMATTER_GUIDANCE}

# <Invariant name>

${BODY_GUIDANCE}

## The invariant

- <State the invariant as a single falsifiable sentence.>

## Where it's enforced

- \`<path>:<line or function>\`, <mechanism: a check, a type, a DB constraint, a migration, ...>

## What breaks it

- <A concrete scenario that would violate the invariant if the enforcement above were removed or bypassed.>
`;
}

export function runbookTemplate(timestamp: string): string {
  return `---
type: runbook
title: <runbook name>
description: Step-by-step operational procedure with preconditions and verification.
tags: [runbook]
timestamp: ${timestamp}
sources:
  - path/to/covered/source
---

${FRONTMATTER_GUIDANCE}

# <Runbook name>

${BODY_GUIDANCE}

## When to use this

- <Trigger condition or symptom that means this runbook applies.>

## Preconditions

- <Access, tools, or system state required before starting.>

## Steps

1. <Exact command or action.>
2. <Exact command or action.>

## Verification

- <How to confirm the runbook actually worked.>
`;
}

export function benchmarkTemplate(timestamp: string): string {
  return `---
type: benchmark
title: <bundle name> discovery benchmark
description: Before/after measurement of discovery quality for this bundle.
tags: [benchmark]
timestamp: ${timestamp}
---

${BENCHMARK_FRONTMATTER_GUIDANCE}

# <Bundle name> discovery benchmark

${BODY_GUIDANCE}

Measures whether this curated OKF bundle improves discovery quality (for
example via [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle)
or whatever search/retrieval tool your agents use) for this repo. Distilled
from the OKF Phase-0 pilot protocol (agent-tasks \`docs/okf/BENCHMARK.md\`).

## Methodology

Two runs, identical protocol:

- **Baseline:** current index, no bundle concept docs present.
- **Post-bundle:** after the bundle is merged and the index has been rebuilt.

Record the environment for both runs (index/tool version, embeddings model,
answer-generation model) so a result can be attributed to the bundle and not
to environment drift between runs.

### Integrity rules

- Write the question set and scoring rubric, and commit them, BEFORE any
  bundle authoring starts.
- Keep the bundle author blind to the question set.
- Verify the ground-truth answer key against source with exact evidence
  (file path, line, or identifier), but do not commit it and do not let it
  reach the index until scoring is complete.
- Filter out any search/query hit whose only source is this benchmark
  document itself (self-match): it contains the questions verbatim and
  would otherwise inflate its own post-bundle score.

### Scoring rubric

- **Answer correctness**, judged against the answer key, same judge both runs:
  - 2 = correct: the key facts are present, no materially wrong claim is
    made, AND the answer text itself names at least one concrete pointer to
    a ground-truth file (a path, identifier, or line reference actually
    written in the prose, not merely present in a separate citations list).
  - 1 = partial: right area or mechanism, but a key fact is missing, a minor
    claim is wrong, or the answer never names a concrete pointer in its own
    text.
  - 0 = wrong or missing.
- **Retrieval hit@5**: 1 if a ground-truth file appears in the top-5
  retrieved chunks for that question, else 0.

Do not count citation metadata (a "sources" or "cited from" list attached by
the tool) as satisfying the pointer requirement above. The pilot's original
rubric did exactly that, and it rewarded answers whose retrieved chunks
happened to carry a \`sources:\` frontmatter pointer even when the answer
text itself never named a concrete file or identifier. That is a metric
artifact, not evidence the reader learned anything precise: require the
pointer in the text itself.

## Questions

| # | Question |
|---|----------|
| Q1 | <question> |

## Results

### Baseline

<!-- fill in after the baseline run -->

### Post-bundle

<!-- fill in after the post-bundle run -->

### Decision

<!-- go / no-go, and what you'd change next time -->
`;
}
