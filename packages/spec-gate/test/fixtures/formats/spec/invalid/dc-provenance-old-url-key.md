---
id: password-change-logout
source: source/meta.json
base_commit: 0123456789abcdef0123456789abcdef01234567
commands_ref: 0123456789abcdef0123456789abcdef01234567
status: draft
retired_ids: [AC-9, NG-4]
---

# Password change logs the user out everywhere

## Goal

- GOAL: After a password change, every existing session of that user ends.

## Context

Free prose. The parser skips it, whatever it contains.

- AC-77: this line is Context and is not parsed.

```
a code block in Context, which is skipped like the rest
```

Inline ```npm test``` runs the suite.

 ## Acceptance, indented, so it is prose here

### A deeper heading is fine here

## Acceptance

- AC-1: A token issued before a password change is rejected with HTTP 401.
  - source: SL-1, SL-2
  - owner: alice
- AC-2: A token issued after the change is accepted.
  - source: SL-3
  - owner: none

## Non-goals

- NG-1: The token format does not change.
  - paths: src/auth/token.ts, src/auth/**
- NG-2: Login latency stays within its current range.

## Defaults

- DF-1: Revoked tokens are deleted after 30 days.
  - reason: Matches the retention of the existing audit log.
  - affects_behavior: true
- DF-2: The log message is in English.
  - reason: All existing log messages are English.
  - affects_behavior: false

## Decisions

- DC-1: Sessions of other devices end as well.
  - question: QN-1
  - provenance:
    - channel: comment
    - author: alice
    - time: 2000-01-31T12:00:00Z
    - url: https://example.com/issues/1#comment-2

## Residuals

- RS-1: Behaviour for service accounts is undecided.
  - class: blind-spot
  - status: open
  - question: QN-2

## Source ledger

- SL-1: L1-0123456789ab -> AC-1
- SL-2: L2-123456789abc -> AC-1, NG-1
- SL-3: L3-23456789abcd -> AC-2
- SL-4: L4-3456789abcde -> out
  - reason: Greeting, carries no requirement.
