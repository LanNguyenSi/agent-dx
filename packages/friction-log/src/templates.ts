import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Friction, Priority, RenderedTemplate, Template } from './types.js';

const DEFAULT_TEMPLATE_NAME = 'workflow-friction';

function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'templates'),
    resolve(here, '..', '..', 'templates'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`friction-log: cannot locate bundled templates (looked in ${candidates.join(', ')})`);
}

export function loadTemplate(name: string): Template {
  const path = join(templatesDir(), `${name}.yml`);
  if (!existsSync(path)) {
    throw new Error(`friction-log: unknown template "${name}" (no file at ${path})`);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as Partial<Template> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`friction-log: template "${name}" is not a valid YAML object`);
  }
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  if (!title || !body) {
    throw new Error(`friction-log: template "${name}" must define both title and body`);
  }
  const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((l): l is string => typeof l === 'string') : [];
  const priority: Priority =
    parsed.priority === 'LOW' ||
    parsed.priority === 'MEDIUM' ||
    parsed.priority === 'HIGH' ||
    parsed.priority === 'CRITICAL'
      ? parsed.priority
      : 'MEDIUM';
  return {
    name,
    title,
    body,
    labels,
    priority,
    metadata: parsed.metadata,
  };
}

export function listTemplates(): string[] {
  return readdirSync(templatesDir())
    .filter((f) => f.endsWith('.yml'))
    .map((f) => f.replace(/\.yml$/, ''))
    .sort();
}

export function pickTemplateForCategory(category: string | null | undefined): string {
  if (!category) return DEFAULT_TEMPLATE_NAME;
  return listTemplates().includes(category) ? category : DEFAULT_TEMPLATE_NAME;
}

export function render(template: Template, friction: Friction, extra: Record<string, string> = {}): RenderedTemplate {
  const vars: Record<string, string> = {
    id: String(friction.id),
    title: friction.title,
    description: friction.description ?? '',
    tool: friction.toolSurface ?? '',
    category: friction.category ?? '',
    severity: friction.severity ?? '',
    capturedAt: friction.capturedAt,
    sessionId: friction.sessionId ?? '',
    source: friction.source,
    ...extra,
  };
  return {
    title: substitute(template.title, vars),
    body: substitute(template.body, vars),
    labels: template.labels,
    priority: template.priority,
    metadata: template.metadata,
  };
}

function substitute(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    return vars[key] ?? '';
  });
}
