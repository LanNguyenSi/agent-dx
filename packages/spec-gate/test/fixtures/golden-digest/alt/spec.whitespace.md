---
id: golden-sample
source: source/meta.json
base_commit: 0123456789abcdef0123456789abcdef01234567
commands_ref: 2bec419bfd7eb7f3e546fee3ee4de72a32494e9c
status: draft
retired_ids: [AC-9, NG-4]
---

# Golden sample

## Goal

- GOAL:   After a password   change, every existing session of that user ends.   

## Context

Free prose. Nobody checks it, whatever it says.

## Acceptance

- AC-1: A token issued before a password change is rejected with HTTP 401.
  - source: SL-1, SL-2
  - owner:    alice  
- AC-2: A token  issued after the change    is accepted.
  - source: SL-3
  - owner: none
- AC-10: Tokens of the other devices of the user end as well.
  - source: SL-4
  - owner: bob

## Non-goals

- NG-1: The token format does not change.
  - paths:  src/auth/token.ts ,   src/auth/**  
- NG-2: Login latency stays within its current range.

## Defaults

- DF-1: Revoked tokens are deleted after 30 days.
  - reason: Matches the retention of the existing audit log.
  - affects_behavior: true
- DF-2: The log message is in English.
  - reason:  All existing   log messages are English.
  - affects_behavior: false

## Decisions

- DC-1: Sessions of other devices end as well.
  - question: QN-1
  - provenance:
    - channel: comment
    - author: alice
    - time: 2000-01-31T12:00:00Z
    - comment_url: https://example.com/issues/1#comment-2
- DC-2: The reset mail keeps its current wording.
  - question: QN-3
  - provenance:
    - channel: chat
    - author:   bob 
    - time: 2000-02-01T08:30:00Z

## Residuals

- RS-1: Behaviour for service accounts is undecided.
  - class: blind-spot
  - status: open
  - question: QN-2
- RS-2: Rate limiting   of the reset endpoint is not covered. 
  - class: untestable
  - status: resolved

## Source ledger

- SL-1: L1-0123456789ab -> AC-1
- SL-2: L2-123456789abc -> AC-1, NG-1
- SL-3: L3-23456789abcd -> AC-2, DF-1
- SL-4: L4-3456789abcde -> AC-10, DC-1
- SL-5: L5-456789abcdef -> RS-1
- SL-6: L6-56789abcdef0 -> out
  - reason: Greeting,   carries no requirement.  
