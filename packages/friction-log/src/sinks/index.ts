import type { Sink } from '../types.js';
import { MarkdownFileSink } from './markdown-file.js';

export type SinkName = 'markdown-file';

export function loadSink(name: string): Sink {
  switch (name) {
    case 'markdown-file':
      return new MarkdownFileSink();
    default:
      throw new Error(
        `friction-log: unknown sink "${name}". Available in M1: markdown-file. ` +
          `Other sinks (github-issues, agent-tasks, linear, stdout-json) land in M4.`
      );
  }
}

export const availableSinks: readonly string[] = ['markdown-file'];
