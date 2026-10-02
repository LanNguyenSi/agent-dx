# Output shape

The JSON envelope every agent-primitives command returns, the global flags that shape it, and the `-m/--max-chars` reduction algorithm. Part of the [agent-primitives](../README.md) CLI.

Every result carries a common envelope (`tool`, `version`, `command`,
`status`, `durationMs`, `cwd`, `truncated`, `logs`, `warnings`) first, in
that order, followed by the subcommand-specific fields. `status` classes
into `ok` (exit 0), `finding` (exit 1), or `cannot-conclude` (exit 2,
includes `usage_error`), so a caller can gate on the exit code alone
without parsing the body.

The same machinery is importable for callers building their own bounded
output: `buildEnvelope` produces the whole envelope, and `applyCaps`
applies the four structural caps (`CapLimits`) to a plain object in one
pass, returning a new structure with every cut marked in place.

## Global options

Every subcommand accepts:

- `-f, --format <format>`: `json` (default) or `text`.
- `-C, --cwd <dir>`: working directory (defaults to the process cwd).
- `-m, --max-chars <n>`: requested bound on the serialized result
  (default `8000`). A result that would exceed it is reduced
  structurally, never by cutting the JSON text: four caps derived from the
  bound (how many characters of a string, how many elements of an array,
  how many keys of an object, and how deep a subtree is kept) are applied
  in one pass over the result, and a bounded search over a single scale
  factor driving all four picks the largest setting that fits. Every
  cut is marked in place with an honest count: a trailing array element,
  a `...` key in an object, a suffix on a string, a placeholder for a
  pruned subtree, each naming how much of the original is missing. Equally
  sized siblings are therefore cut alike, and a large collection is
  trimmed entry by entry rather than deleted whole. An object key is kept
  whole or its entry is dropped; a result keyed by very long strings
  therefore reduces on the key count alone. Depth is part of the
  search as well, so a result too deeply nested to fit at any width comes
  back as a shallower sketch of itself, each pruned subtree naming the
  depth it was cut at, instead of vanishing; when not even the shallowest
  structure fits, a warning says the result was reduced to the fixed
  fields alone and points at the full result on disk. The full untruncated
  result is written to the log directory and its path returned in `logs`.
  The reduction reads no clock and does no work proportional to how far
  over the bound a result is: within one process the same result always
  yields the same envelope, and between processes the only thing that
  differs is the run id in the full-result path. A handful of fixed fields
  (`tool`, `version`, `command`, `status`, `durationMs`, `cwd`,
  `truncated`, `logs`, `warnings`) are held out of the reduction entirely
  and lead the serialized object, so the real bound is `max(-m, size of
those fixed fields)`, not `-m` unconditionally; when even that cannot be
  honored, a warning names the envelope's true final length instead of
  silently exceeding what was asked for. `-f text` output is bounded the
  same way and never exceeds `-m`: its truncation marker names the full
  length, and below the marker's own size the marker itself is cut short.
- `-l, --log-dir <dir>`: directory for logs and full (untruncated)
  results (defaults to `$AGENT_PRIMITIVES_LOG_DIR`, or a fresh directory
  under the OS temp dir otherwise). Relative values are supported and are
  resolved once against the invocation cwd, including `./` and `../`.
- `--json`: a no-op alias for `-f json` (already the default), for the
  common instinct to ask for JSON explicitly. Combined with an explicit
  `-f text` it is `status: "usage_error"`, `reason: "format_conflict"`,
  exit `2`; `-f json --json` is accepted, since the two agree.

An unrecognized option's message names a common alias when it has one
(`--text` -> use `-f text`; `--json` is itself a real global option, so
it never reaches this hint), and an invalid `-f`/`--format` value that
looks like a path adds a hint that `-f` is the global `--format` and
`probe`'s file option is `--file`.

## Complete result artifacts

CLI `verify`, `probe`, and `probe --plan` write a complete pre-envelope-reduction
JSON result to `result-full-<run-id>.json` in the log directory even when the
result fits `--max-chars`. Its path appears in `logs` near the start of the
returned envelope. Each CLI invocation has a fresh run id, so invocations
sharing a log directory keep separate artifacts. The saved result is rendered
before its own path is added to `logs`; it does not link to itself. Existing
verify failure caps still use `verify-full-<run-id>.json` for uncapped checks.
Read that artifact too when the failure cap removed entries before envelope
construction.

`truncated` describes agent-primitives' own reduction, including command-level
caps. It cannot detect a surrounding tool clipping stdout. A result with
`truncated: false` may still be clipped downstream; use the result artifact
for complete evidence when the transport omitted fields. Artifact paths and
write-failure warnings count toward the envelope bound. A failed write emits
an explicit warning, advertises no result artifact, and preserves the command's
verdict and exit semantics. Nonserializable library payloads retain their
existing warning and cannot be saved as complete JSON. Parser errors emitted
as `command: "unknown"` have no completed verify/probe result to persist.

Artifacts contain the same redacted result fields as the envelope, before
size reduction, and may be larger than stdout. This adds one disk write per
completed invocation. Files follow the existing log lifecycle: no automatic
cleanup or indefinite retention is promised. Temp-directory artifacts can be
removed by the OS; choose `--log-dir` on durable storage and manage retention
when evidence must survive temporary storage cleanup. Other commands and
library callers keep their existing persistence behavior unless a library
caller explicitly enables `persistFullResult`.
