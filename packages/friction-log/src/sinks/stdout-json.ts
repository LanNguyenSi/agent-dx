import type { FileOptions, FileResult, Friction, RenderedTemplate, Sink } from '../types.js';

/**
 * Emit a structured JSON record to stdout. No side effects beyond stdout.
 * Useful for piping into custom workflows:
 *
 *   friction-log file 7 --sink stdout-json | jq '.rendered.body'
 *
 * The record shape is stable: any future field is additive.
 */
export class StdoutJsonSink implements Sink {
  readonly name = 'stdout-json';

  // Tests inject a fake writer so we don't pollute the test runner's stdout.
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(line)) {}

  async file(friction: Friction, rendered: RenderedTemplate, _opts: FileOptions): Promise<FileResult> {
    const record = {
      sink: this.name,
      emittedAt: new Date().toISOString(),
      friction: {
        id: friction.id,
        sessionId: friction.sessionId,
        toolSurface: friction.toolSurface,
        title: friction.title,
        description: friction.description,
        capturedAt: friction.capturedAt,
        severity: friction.severity,
        category: friction.category,
        status: friction.status,
        recurrenceOfId: friction.recurrenceOfId,
        source: friction.source,
      },
      rendered: {
        title: rendered.title,
        body: rendered.body,
        labels: rendered.labels,
        priority: rendered.priority,
        metadata: rendered.metadata,
      },
    };
    this.write(JSON.stringify(record) + '\n');
    return {
      ok: true,
      sinkTarget: 'stdout',
      message: 'emitted JSON record to stdout',
    };
  }
}
