---
type: reference
title: Fixture doc for okf-citations-resolve .tsx targets, JSX closing lines, directory-less notices and the governor reset
sources:
  - src/App.tsx
  - src/App.test.tsx
  - internal/main_test.go
---

# Sample

A correct `.tsx` citation on real content, no finding: `src/App.tsx:11`.

A `.tsx` citation past the end of file fails like a `.ts` one: `src/App.tsx:999`.

A `.tsx` citation starting on a self-closing `/>` line: `src/App.tsx:14`.

A `.tsx` citation starting on a `</div>` line: `src/App.tsx:15`.

A `.tsx` citation starting on a fragment-closing `</>` line: `src/App.tsx:16`.

A `.tsx` citation starting on a `)}` line: `src/App.tsx:30`.

A range ending on JSX closing lines is normal, not drift: `src/App.tsx:6-17`.

An anchored `.tsx` citation whose needle sits on the cited line: `src/App.tsx:35#"marker for anchored citations"`.

An anchored `.tsx` range whose needle sits above trailing JSX closing lines, clean under `--require-anchors` too: `src/App.tsx:6-15#"onDone();"`.

An anchored `.tsx` range whose needle sits ON a JSX closing line, flagged under `--require-anchors`: `src/App.tsx:6-15#"/>"`.

A recognised `.tsx` citation with an unparsed anchor gets `anchor-malformed`, never an extension notice: `src/App.tsx:2#`.

Continuation after a recognised citation is checked: `src/App.tsx:5` then `:998` names the `.tsx` file.

An unrecognised citation between them breaks the chain: `src/App.tsx:5`, then `src/lib.rs:12`, then `:997`-`996` and (`995`) must not be attributed to the `.tsx` file.

Directory-less RANGE citation, unrecognised extension, one notice: `install.sh:561-618`.

Directory-less ANCHORED citation, unrecognised extension, one notice: `deploy.sh:5#"install"`.

Directory-less single-number citation stays silent, it is the host:port shape: `foo.sh:12`.

Host and port look-alikes stay silent, single and range form: `localhost:8080`, `db.internal:5432`, `example.com:80-90`, `db.internal:1-1024`.

Malformed anchors on unrecognised extensions, notices rather than silence: `src/lib.rs:1#"unterminated` and `src/lib.rs:2#`.

Test-file targets: `src/App.test.tsx:3-7`, and :3-7, and :5-6, and :4-5.

Go test files count as test files too: `internal/main_test.go:5`, and :9-13.
