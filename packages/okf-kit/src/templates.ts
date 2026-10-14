/**
 * Scaffold content for `okf-kit init`. Everything here is static except the
 * stamp value, which the caller (src/init.ts) fills in with the real
 * current instant at generation time: never hardcode an artificial
 * midnight datetime here, that is exactly the lesson this kit is built to
 * enforce (see frontmatterGuidance() below).
 *
 * Every template takes the OKF spec version (default `v0.1`, byte-identical
 * to every release before the `--spec` flag existed). Under `v0.2` the
 * bundle-root index.md declares `okf_version: "0.2"` and the doc templates
 * write the `generated: {by, at}` block that replaces `timestamp`, plus one
 * extra guidance bullet about it.
 */

import type { SpecVersion } from "./types.js";

/**
 * The frontmatter stamp block for one template doc: the v0.1
 * `timestamp:` line, or the v0.2 `generated: {by, at}` mapping that
 * replaces it (spec v0.2: "timestamp is replaced by generated: { by, at }",
 * with `at` carrying the same instant semantics and `by` naming the
 * producer). The `human:<id>` placeholder matches the `human:<id>` shape
 * `generated-shape` accepts, so the scaffold checks clean and reads as an
 * obvious "replace me" marker, consistent with every other placeholder
 * here.
 */
function stampBlock(spec: SpecVersion, timestamp: string): string {
  return spec === "v0.2"
    ? `generated:\n  by: human:<id>\n  at: ${timestamp}`
    : `timestamp: ${timestamp}`;
}

/** The guidance bullet explaining the v0.2 `generated` block, appended to every doc's guidance comment under spec v0.2 only. */
function generatedGuidanceNote(spec: SpecVersion): string {
  if (spec !== "v0.2") return "";
  return `
- \`generated\` (OKF v0.2) replaces \`timestamp\` in this doc: \`generated.at\`
  means exactly what \`timestamp\` meant, and \`generated.by\` names who or what
  wrote the doc, in one of the shapes \`<producer>/<version>\` (e.g.
  \`okf-kit/0.19.0\`), \`human:<id>\` or \`process:<id>\`. Replace the \`human:<id>\`
  placeholder; \`generated.at\` must carry an explicit offset (\`Z\` or \`+02:00\`).`;
}

function frontmatterGuidance(spec: SpecVersion): string {
  return `<!--
okf-kit init guidance (delete this comment once the doc is written):
- \`timestamp\` means "last verified against sources", not "created on".
  Bump it (and add a line to this bundle's log.md) every time you
  re-verify this doc against its sources; never hand-write an artificial
  midnight datetime, use the real instant you did the verification.${generatedGuidanceNote(spec)}
- \`sources\` lists the repo-root-relative paths this doc DESCRIBES (code,
  config, or other docs elsewhere in the repo). Never list this bundle's
  own directory: a bundle directory changes on every doc edit, so a
  self-referential \`sources\` entry goes permanently stale. This happened
  to the OKF pilot's own BENCHMARK.md (agent-tasks docs/okf/BENCHMARK.md),
  which is why this template ships with a placeholder instead of a real
  path: \`okf-kit check\` will report that placeholder as a missing source
  path until you replace it, and that is intentional, not a bug.
-->`;
}

function benchmarkGuidance(spec: SpecVersion): string {
  return `<!--
okf-kit init guidance (delete this comment once the doc is written):
- \`timestamp\` means "last verified", not "created on"; bump it (and add a
  line to this bundle's log.md) whenever this record is updated. Never
  hand-write an artificial midnight datetime.${generatedGuidanceNote(spec)}
- This template intentionally has no \`sources:\` key. A benchmark record
  documents a measurement protocol and its results, not a piece of the
  codebase, so there is nothing it "describes" in the sources-shape sense.
  The OKF pilot's own BENCHMARK.md carried \`sources: [docs/okf/]\`,
  pointing at its own bundle directory; that "source" changed on every
  edit to the bundle and was permanently, uselessly stale. Don't repeat
  that mistake: omit \`sources\` here rather than pointing it at yourself.
-->`;
}

function incidentGuidance(spec: SpecVersion): string {
  return `<!--
okf-kit init guidance (delete this comment once the doc is written):
- This template intentionally has no \`sources:\` key. An incident analysis
  is a historical record of what broke and why, not a description of the
  current code, so it must not go stale when that code changes later.
- \`timestamp\` means "last updated"; bump it (and add a line to this
  bundle's log.md) whenever the record or a lesson's status changes. Never
  hand-write an artificial midnight datetime.${generatedGuidanceNote(spec)}
- No personal data: name roles ("the on-call reviewer"), never people.
  Reference tickets and trackers by key, do not copy their content.
- \`lessons[].status\` is one of proposed | adopted | rejected. Once a
  lesson is adopted into a runbook, uncomment its \`runbook:\` line and
  point it at that runbook.
- If incident analyses must not ship with the repository, keep this bundle
  outside the shipped repository and let it point INTO the shipped bundle,
  never the reverse, so a shipped runbook does not reveal that internal
  analyses exist.
-->`;
}

const BODY_GUIDANCE = `<!--
Write dense, source-verified prose: name exact mechanisms (function/class/
route names), exact file paths, and exact identifiers (config keys, env
vars, error codes). Avoid filler like "this module handles X" without
naming the function that does it. Every sentence here should be checkable
against a source in \`sources:\` above.
-->`;

export function indexTemplate(spec: SpecVersion = "v0.1"): string {
  // OKF v0.2 lets exactly one file carry frontmatter: the bundle-root
  // index.md, with exactly one key, the version declaration itself (the
  // reserved-files-bare exception; the quoted form keeps YAML handing back
  // the string "0.2", the form the spec spells).
  const versionDeclaration =
    spec === "v0.2" ? '---\nokf_version: "0.2"\n---\n\n' : "";
  return `${versionDeclaration}# Knowledge bundle index

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

## Incidents

- [Incident template](incident-template.md), one doc per defect analysis: symptom, cause, why it escaped, the lesson and the runbook that adopted it.

## Benchmark

- [Benchmark template](benchmark-template.md), measure whether this bundle actually improves discovery, before and after it lands.
`;
}

export function logTemplate(timestamp: string): string {
  return `# Log

<!-- Add new entries at the top, newest first. -->

- ${timestamp}, bundle scaffolded by \`okf-kit init\`.
`;
}

export function overviewTemplate(
  timestamp: string,
  spec: SpecVersion = "v0.1",
): string {
  return `---
type: overview
title: <component/area> overview
description: Orientation doc, what this area covers and where to start reading.
tags: [overview]
${stampBlock(spec, timestamp)}
sources:
  - path/to/covered/source
---

${frontmatterGuidance(spec)}

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

export function moduleTemplate(
  timestamp: string,
  spec: SpecVersion = "v0.1",
): string {
  return `---
type: module
title: <module name>
description: What this module owns, its entry points, and its key files.
tags: [module]
${stampBlock(spec, timestamp)}
sources:
  - path/to/covered/source
---

${frontmatterGuidance(spec)}

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

export function invariantTemplate(
  timestamp: string,
  spec: SpecVersion = "v0.1",
): string {
  return `---
type: invariant
title: <invariant name>
description: A falsifiable invariant, where it is enforced, and what breaks it.
tags: [invariant]
${stampBlock(spec, timestamp)}
sources:
  - path/to/covered/source
---

${frontmatterGuidance(spec)}

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

const RUNBOOK_APPLIES_TO_GUIDANCE = `<!--
Runbook wiring (delete this comment too): \`applies_to\` lists the paths
this procedure is run for (files or directories). \`okf-kit docs-for\`
finds the runbook when any of them changes, but \`sources-fresh\` ignores
the field, so a broad directory does not make the runbook stale on every
edit there. Use \`sources\` instead (or as well) when the runbook cites
concrete lines that must stay true: a change there then marks it stale.
-->`;

export function runbookTemplate(
  timestamp: string,
  spec: SpecVersion = "v0.1",
): string {
  return `---
type: runbook
title: <runbook name>
description: Step-by-step operational procedure with preconditions and verification.
tags: [runbook]
${stampBlock(spec, timestamp)}
applies_to:
  - path/to/covered/source
---

${frontmatterGuidance(spec)}

${RUNBOOK_APPLIES_TO_GUIDANCE}

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

export function incidentTemplate(
  timestamp: string,
  spec: SpecVersion = "v0.1",
): string {
  return `---
type: incident
title: <short symptom>
description: <one line>
tags: [incident]
${stampBlock(spec, timestamp)}
area: <cluster key, ideally the topic of a runbook>
root_cause: <term from the bundle's vocabulary>
escape_reason: <why checks before release did not catch it>
applies_when: <the kind of work where this lesson matters>
lessons:
  - id: L1
    rule: <what to do differently>
    check: <how to verify it>
    status: proposed
    # runbook: <path of the runbook that adopted this lesson, once adopted>
related: []
---

${incidentGuidance(spec)}

# <Short symptom>

## Symptom

- <What was observed, by whom (role), and where.>

## Cause

- <The defect itself, with the file or component it lived in.>

## Why it escaped

- <Which check, review, or test should have caught it, and why it did not.>

## Fix

- <What changed, referenced by PR or ticket key.>

## Lesson / runbook change

- <The rule from \`lessons\` above and which runbook adopted it, or why none did.>
`;
}

export function benchmarkTemplate(
  timestamp: string,
  spec: SpecVersion = "v0.1",
): string {
  return `---
type: benchmark
title: <bundle name> discovery benchmark
description: Before/after measurement of discovery quality for this bundle.
tags: [benchmark]
${stampBlock(spec, timestamp)}
---

${benchmarkGuidance(spec)}

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
