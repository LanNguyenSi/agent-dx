# First Implementation Slice: Fresh Preflight Diagnostics

## Decision

Extend the grounding MCP evaluator to return the diagnostics from the single
preflight invocation it already performs. Keep the signed verdict marker,
readiness/blocker folding, and gate key unchanged. The returned diagnostics are
unsigned, informational data; they must never be accepted as marker authority
or treated as executable instructions.

This is a future implementation brief. It makes no change today.

## Scope and boundaries

**Owned files for the future change**

- `agent-grounding/packages/grounding-mcp/src/solution-verdict.ts`
- `agent-grounding/packages/grounding-mcp/src/server.ts`
- `agent-grounding/packages/grounding-mcp/tests/solution-verdict.test.ts`
- `agent-grounding/packages/grounding-mcp/tests/grounding-gate-mcp-roundtrip.test.ts`
- `agent-grounding/packages/grounding-mcp/README.md`

`solution_evaluate` already invokes preflight through
[`evaluateSolution`](https://github.com/LanNguyenSi/agent-grounding/blob/master/packages/grounding-mcp/src/solution-verdict.ts).
The change should parse and return its fresh result once, beside the unchanged
`EvaluateResult` verdict/marker fields. The MCP handler in
[`server.ts`](https://github.com/LanNguyenSi/agent-grounding/blob/master/packages/grounding-mcp/src/server.ts)
continues to forward that result. No second direct preflight invocation is
allowed for a response that already came from that evaluation.

Do not change signing, the marker's signed shape, gate keys, `solution_gate`,
or the existing ready/blocker policy. Do not add a runner, wrapper, cache,
result schema for reuse, external result ingestion, retry history store, or
timeout protocol. This slice does not improve transport timeouts.

## Response contract

Add an optional `diagnostics` field to the evaluation response. When available,
it represents the full, just-completed structured preflight response. Preserve
all documented producer fields and any additive structured fields; do not
silently reduce it to a selected summary. The envelope also contains:

- the overall preflight readiness/result status and documented exit outcome;
- invocation duration and timestamp, or an explicit unavailable/unknown
  indication when the producer did not supply either value;
- each check's status, including waived or skipped checks with acknowledged
  reasons;
- warnings, limitations, and parse/output completeness indicators;
- details and log paths when supplied by the producer; and
- a clear unavailable/error form when the preflight executable cannot run or
  its JSON is absent or malformed.

Preserve the producer's semantics: preflight reports a not-ready finding with
exit 1 and valid JSON. Parse that JSON before deciding whether it is usable.
Malformed/missing JSON and unavailable execution must be explicit diagnostics,
not a fabricated passing result. The existing parser currently has permissive
handling around nonzero process outcomes; this slice must document and test the
diagnostic boundary rather than claim the whole system is already fail-closed
for every execution error. Broader error-hardening is separate work.

Diagnostics must remain outside `Verdict`, outside the signed marker payload,
and outside the fields `solution_gate` evaluates. A consumer can display them,
but cannot convert them into a ready decision or execute their contents.

## Compatibility acceptance criteria

1. A ready preflight result with a waived/acknowledged check returns the
   unchanged ready verdict and complete diagnostics, including the waiver
   reason.
2. A not-ready valid preflight result (including its documented nonzero exit)
   returns the unchanged not-ready verdict and preserves blockers and check
   diagnostics.
3. Malformed or missing JSON produces explicit unavailable/error diagnostics;
   it does not report a made-up successful assessment.
4. An orchestrator-workflow block keeps its current verdict folding behavior;
   diagnostics do not change it.
5. A complete valid payload exposes checks, warnings, limitations, details,
   and log paths without turning any diagnostic into signed authority.
6. The test seam observes exactly one preflight process invocation per
   `evaluateSolution` call.
7. Tests assert that the written signed marker contains no diagnostics field.

Use fixture payloads rather than a live preflight executable. Cover both the
unit evaluator and MCP round trip where the current tests establish those
boundaries.

## Verification plan for that future change

Run from an `agent-grounding` checkout after implementation:

```sh
cd packages/grounding-mcp
agent-primitives verify -c focused -x 'focused=npx vitest run tests/solution-verdict.test.ts tests/grounding-gate-mcp-roundtrip.test.ts'
# After the final change, run the complete relevant package checks once.
agent-primitives verify -c build,typecheck,lint,test
```

The generic verifier contract is represented by
[`agent-primitives`](../../agent-primitives/src/verify/index.ts)
and its [result types](../../agent-primitives/src/verify/types.ts).
Its configured commands must be checked in the target workspace before the
generic `build,typecheck,lint,test` run is relied on.

Generate these run-owned, temporary fixture patches as part of the future
implementation, then run them through `agent-primitives probe --plan` with a
plan in the same temporary directory. Do not add them under `tests/` or commit
them:

| Future fixture patch | Mutant objective |
| --- | --- |
| `<run-dir>/waiver-removed.patch` | Remove an acknowledged waiver reason; the diagnostics-preservation test must fail. |
| `<run-dir>/second-preflight.patch` | Make the evaluator start a second preflight process; the invocation-count test must fail. |
| `<run-dir>/marker-leak.patch` | Add diagnostics to the marker projection; the signed-marker boundary test must fail. |

```json
{
  "test": "npx vitest run tests/solution-verdict.test.ts tests/grounding-gate-mcp-roundtrip.test.ts",
  "mutants": [
    { "patch": "<run-dir>/waiver-removed.patch" },
    { "patch": "<run-dir>/second-preflight.patch" },
    { "patch": "<run-dir>/marker-leak.patch" }
  ]
}
```

Save that JSON as
`<run-dir>/mutation-plan.json`, replace
`<run-dir>` consistently with an absolute, writable temporary run directory, and run:

```sh
agent-primitives probe --plan "<run-dir>/mutation-plan.json"
```

The implementation must generate these patches and plan file; none exists yet
and no probe has run for this documentation task.

## Dependencies, risk, and rollback

The change depends on the current preflight JSON providing the intended check
fields and on test seams that can stub its process result. Configuration is
resolved from the evaluated working tree, so a future reuse design must not
assume a committed configuration alone identifies context. The preflight result
also does not by itself provide the provenance/context binding required for
reuse.

The main risk is accidentally treating informational output as gate authority,
or changing the current folding while adding data. Keep the diagnostic adapter
separate from verdict projection and marker serialization. Roll back by
removing the additive response field and its adapter/tests; no marker migration
or cached state exists in this slice.

When the evaluator is the sole preflight caller for the same repository,
working directory, configuration, check coverage, settings, and unchanged code,
its diagnostics allow a caller to remove one duplicate direct preflight
invocation. Those equality conditions are required; otherwise run the needed
check. This conditional optimization does not override any installed
verification requirement today. It is a structural reduction only, with no
performance claim.

## Ordered follow-ups

1. Implement and test this diagnostics passthrough.
2. Specify caller/transport handles, terminal polling, timeout preservation,
   and append-only retry history.
3. Evaluate security and parser/error-hardening boundaries as separate reviewed
   work; do not infer safety from the current parser.
4. Only then specify provenance- and snapshot-bound reuse with before/after
   stability checks; keep independent empirical reviewer runs outside
   deduplication.
