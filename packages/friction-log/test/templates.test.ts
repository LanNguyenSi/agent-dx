import { describe, expect, it } from 'vitest';
import { listTemplates, loadTemplate, pickTemplateForCategory, render } from '../src/templates.js';
import type { Friction } from '../src/types.js';

const friction: Friction = {
  id: 7,
  sessionId: 'sess',
  toolSurface: 'mcp:foo/bar',
  title: 'short title',
  description: 'long desc',
  capturedAt: '2026-05-17T19:00:00.000Z',
  severity: 'medium',
  category: 'tool-error',
  status: 'open',
  recurrenceOfId: null,
  source: 'manual',
};

describe('templates', () => {
  it('lists at least the three M1 templates', () => {
    const names = listTemplates();
    expect(names).toEqual(expect.arrayContaining(['tool-error', 'output-overflow', 'workflow-friction']));
  });

  it('loads tool-error and renders mustache vars', () => {
    const t = loadTemplate('tool-error');
    const rendered = render(t, friction);
    expect(rendered.title).toBe('mcp:foo/bar: short title');
    expect(rendered.body).toContain('long desc');
    expect(rendered.body).toContain('mcp:foo/bar');
    expect(rendered.priority).toBe('MEDIUM');
    expect(rendered.labels).toContain('friction');
  });

  it('falls back to workflow-friction for unknown category', () => {
    expect(pickTemplateForCategory(null)).toBe('workflow-friction');
    expect(pickTemplateForCategory('not-a-real-category')).toBe('workflow-friction');
  });

  it('uses the category as template name when one exists', () => {
    expect(pickTemplateForCategory('tool-error')).toBe('tool-error');
    expect(pickTemplateForCategory('output-overflow')).toBe('output-overflow');
  });

  it('rejects unknown template by name', () => {
    expect(() => loadTemplate('nonexistent-template')).toThrow(/unknown template/);
  });
});
