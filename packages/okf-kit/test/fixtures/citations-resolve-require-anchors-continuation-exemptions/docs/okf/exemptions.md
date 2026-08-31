---
type: reference
title: Fixture doc for anchor-required-continuation's own exemptions
sources:
  - src/target.ts
---

# Continuation exemptions

An allowlisted target: a colon-form continuation chained off an anchored
full citation whose path matches `requireAnchors.allow`, exempt from
`anchor-required-continuation` the same way `anchor-required` exempts an
allowlisted full citation: `src/target.ts:1#"alpha"`, then `:2` here.

An out-of-scope governing citation: a leading-`/` citedPath is never
resolved, so `governing` resets to none and the continuation right after
it has nothing to validate against: `/etc/app.yml:1`, then `:2` here.

A missing-file governing citation: an unresolvable citedPath also resets
`governing` to none, so the continuation right after it is likewise
skipped, not flagged: `does-not-exist.ts:1`, then `:2` here.
