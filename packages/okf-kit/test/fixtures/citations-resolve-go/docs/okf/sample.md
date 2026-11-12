---
type: reference
title: Fixture doc for okf-citations-resolve .go targets and the extension-unrecognised notice
sources:
  - internal/main.go
---

# Sample

In-range `.go` citation, real content: `internal/main.go:5`.

Missing-file citation into a `.go` target: `internal/missing.go:5`.

Range-exceeds-file citation into a `.go` target: `internal/main.go:999`.

Range whose end is past EOF: `internal/main.go:5-999`.

String anchor that lives outside the cited range: `internal/main.go:5-6#"needle in helper"`.

Closing-brace-only `.go` citation: `internal/main.go:7`.

Range ending on a lone closing brace (normal, not drift): `internal/main.go:5-7`.

Unrecognised extension, backticked, exactly one notice: `src/lib.rs:12`.

The same citation shape without backticks, no notice: src/lib.rs:34.

A URL with a port, no notice: `https://example.com:8080`.

A host and port, no notice: `db.internal:5432`.

An absolute path (out of scope for the main scan too), no notice: `/srv/src/lib.rs:12`.

A directory-less single-segment token, no notice: `a.b:3`.

A digits-only extension, no notice: `scripts/tool.123:45`.
