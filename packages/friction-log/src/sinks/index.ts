import type { Sink } from '../types.js';

export type SinkName =
  | 'markdown-file'
  | 'stdout-json'
  | 'github-issues'
  | 'agent-tasks'
  | 'linear';

export const availableSinks: readonly SinkName[] = [
  'markdown-file',
  'stdout-json',
  'github-issues',
  'agent-tasks',
  'linear',
];

// Each entry imports its module on first request. The Linear client, the
// agent-tasks REST helper, and the github-issues spawn wrapper all live behind
// a dynamic import so an install that never uses them never pays the load
// cost. Tests can override the loader via `registerSinkFactory` to inject a
// fake without touching the filesystem.
type SinkFactory = () => Promise<Sink>;

const factories: Record<SinkName, SinkFactory> = {
  'markdown-file': async () => {
    const m = await import('./markdown-file.js');
    return new m.MarkdownFileSink();
  },
  'stdout-json': async () => {
    const m = await import('./stdout-json.js');
    return new m.StdoutJsonSink();
  },
  'github-issues': async () => {
    const m = await import('./github-issues.js');
    return new m.GithubIssuesSink();
  },
  'agent-tasks': async () => {
    const m = await import('./agent-tasks.js');
    return new m.AgentTasksSink();
  },
  linear: async () => {
    const m = await import('./linear.js');
    return new m.LinearSink();
  },
};

export async function loadSink(name: string): Promise<Sink> {
  const factory = factories[name as SinkName];
  if (!factory) {
    throw new Error(
      `friction-log: unknown sink "${name}". Known sinks: ${availableSinks.join(', ')}.`
    );
  }
  return factory();
}

/**
 * Replace a sink factory for the duration of a test. Returns a restore
 * function. Production code never calls this.
 */
export function registerSinkFactory(name: SinkName, factory: SinkFactory): () => void {
  const previous = factories[name];
  factories[name] = factory;
  return () => {
    factories[name] = previous;
  };
}
