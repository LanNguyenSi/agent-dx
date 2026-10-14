---
type: concept
generated:
  by: okf-kit/0.19.0
  at: 2026-06-01T00:00:00Z
sources:
  - id: retry
    resource: src/client.ts
  - id: otel
    resource: https://opentelemetry.io/docs/
    title: OpenTelemetry docs
  - src/helper.ts
---

# Client

Requests are retried three times.[^retry] Telemetry follows the
collector's conventions.[^otel] The retry loop is cited again here.[^retry]

Code and fences never count as footnote references: `[^not-a-ref]` and

```text
[^also-not-a-ref]
```

[^retry]: Retry loop, `L2-4`.
[^otel]: Upstream documentation.
