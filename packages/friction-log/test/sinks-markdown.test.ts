import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownFileSink } from '../src/sinks/markdown-file.js';
import { loadTemplate, render } from '../src/templates.js';
import type { Friction } from '../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-log-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function friction(overrides: Partial<Friction> = {}): Friction {
  return {
    id: 42,
    sessionId: 'sess-1',
    toolSurface: 'mcp:agent-tasks/tasks_list',
    title: 'tasks_list returns >100kB',
    description: 'A 149kB blob overflows the agent context window.',
    capturedAt: '2026-05-17T19:00:00.000Z',
    severity: 'high',
    category: 'output-overflow',
    status: 'open',
    recurrenceOfId: null,
    source: 'manual',
    ...overrides,
  };
}

describe('MarkdownFileSink', () => {
  it('writes a markdown file with frontmatter and rendered body', async () => {
    const sink = new MarkdownFileSink(tmp);
    const t = loadTemplate('output-overflow');
    const rendered = render(t, friction());
    const result = await sink.file(friction(), rendered, {});
    expect(result.ok).toBe(true);
    expect(result.sinkTarget.startsWith(tmp)).toBe(true);
    const content = readFileSync(result.sinkTarget, 'utf8');
    expect(content).toContain('friction_id: 42');
    expect(content).toContain('priority: HIGH');
    expect(content).toContain('mcp:agent-tasks/tasks_list');
    expect(content).toContain('# mcp:agent-tasks/tasks_list: output overflows agent context');
  });

  it('honors sinkTarget override directory', async () => {
    const sink = new MarkdownFileSink(tmp);
    const override = join(tmp, 'subdir');
    const t = loadTemplate('workflow-friction');
    const rendered = render(t, friction());
    const result = await sink.file(friction(), rendered, { sinkTarget: override });
    expect(result.sinkTarget.startsWith(override)).toBe(true);
  });

  it('builds a date-id-slug filename', async () => {
    const sink = new MarkdownFileSink(tmp);
    const t = loadTemplate('workflow-friction');
    const rendered = render(t, friction());
    const result = await sink.file(friction(), rendered, {});
    expect(result.sinkTarget).toMatch(/2026-05-17-42-tasks-list-returns-100kb\.md$/);
  });
});
