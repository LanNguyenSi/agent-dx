---
type: reference
title: Fixture doc for okf-citations-resolve .go targets and the extension-unrecognised notice
sources:
  - internal/main.go
  - internal/sample_test.go
  - web/app.ts
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

Anchored unrecognised `.rs` citation, quoted anchor, exactly one notice: `src/lib.rs:1#"main"`.

Anchored unrecognised `.rs` citation, bare-word anchor, one notice: `src/lib.rs:2#main`.

Anchored `.tsx` citation, quoted anchor with punctuation, now a recognised target so only missing-file (there is no page.tsx here): `src/app/page.tsx:31-33#"router.replace('/login')"`.

Anchored recognised `.go` citation, no notice: `internal/main.go:9-12#"needle in helper"`.

Anchored recognised `.ts` citation, no notice: `web/app.ts:1-2#"needle in app"`.

CITATION_RE prefix look-alikes, never a `.go` citation: `src/x.gomod:3` gets a `.gomod` notice, `src/x.go.bak:3` gets a `.bak` notice, `src/x.golden:3` gets a `.golden` notice.

Go subtest and suite-method heads, short-form boundaries into `internal/sample_test.go`. The suite method `internal/sample_test.go:7-11` and the `t.Run` subtest `internal/sample_test.go:16-20` each bound a whole block (:7-11, :16-20); a subtest ended on a plain brace (:16-19) and a function ended on `})` (:13-20) are both end-not-closing notices.

Shapes that are not Go heads, so a range starting on one is start-not-head drift, named by `internal/sample_test.go:41-46`: an `x.Runner` call (:42-46), a `t.Run` in a comment (:43-45), a `t.Run` in a string (:44-46).

Straddle check, full citations only: `internal/sample_test.go:25-28` straddles a sibling `t.Run`, while `internal/sample_test.go:34-38` nests one deeper and `internal/sample_test.go:16-20` cites a clean whole subtest.

