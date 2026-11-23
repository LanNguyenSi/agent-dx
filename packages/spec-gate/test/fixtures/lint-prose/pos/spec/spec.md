---
id: tiny-valid
source: source/meta.json
base_commit: 0123456789abcdef0123456789abcdef01234567
commands_ref: 0123456789abcdef0123456789abcdef01234567
status: draft
---

## Goal

- GOAL: Reject a token that was issued before a password change.

## Acceptance

- AC-1: A token issued before a password change is rejected with HTTP 401.
  - source: SL-1
  - owner: alice

## Non-goals

- NG-1: The token format does not change.

## Source ledger

- SL-1: L1-0123456789ab -> AC-1, NG-1
