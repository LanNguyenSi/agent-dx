---
id: tiny-valid
source: source/meta.json
base_commit: 0123456789abcdef0123456789abcdef01234567
commands_ref: 0123456789abcdef0123456789abcdef01234567
status: proposed
---

## Goal

- GOAL: Reject a token that was issued before a password change.

## Acceptance

- AC-1: A token issued before a password change is rejected with HTTP 401.
  - source: SL-1
  - owner: alice

## Non-goals

- NG-1: The token format does not change.

## Residuals

- RS-1: The rate limit of the test environment is not the production one.
  - class: blind-spot
  - status: open

## Source ledger

- SL-1: L1-0123456789ab -> AC-1, NG-1
