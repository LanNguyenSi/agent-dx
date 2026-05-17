import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultMarkdownSinkDir } from '../paths.js';
import type { FileOptions, FileResult, Friction, RenderedTemplate, Sink } from '../types.js';

export class MarkdownFileSink implements Sink {
  readonly name = 'markdown-file';

  constructor(private readonly baseDir: string = defaultMarkdownSinkDir()) {}

  async file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult> {
    const targetDir = opts.sinkTarget ? resolve(opts.sinkTarget) : this.baseDir;
    mkdirSync(targetDir, { recursive: true });
    const filename = buildFilename(friction);
    const fullPath = join(targetDir, filename);
    const content = renderMarkdown(friction, rendered);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
    return {
      ok: true,
      sinkTarget: fullPath,
      message: `wrote ${fullPath}`,
    };
  }
}

function buildFilename(friction: Friction): string {
  const date = friction.capturedAt.slice(0, 10);
  const slug = friction.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `friction-${friction.id}`;
  return `${date}-${friction.id}-${slug}.md`;
}

function renderMarkdown(friction: Friction, rendered: RenderedTemplate): string {
  const frontmatter: string[] = [
    '---',
    `friction_id: ${friction.id}`,
    `captured_at: ${friction.capturedAt}`,
    `priority: ${rendered.priority}`,
    `labels: [${rendered.labels.map((l) => JSON.stringify(l)).join(', ')}]`,
  ];
  if (friction.toolSurface) frontmatter.push(`tool_surface: ${friction.toolSurface}`);
  if (friction.category) frontmatter.push(`category: ${friction.category}`);
  if (friction.severity) frontmatter.push(`severity: ${friction.severity}`);
  if (friction.sessionId) frontmatter.push(`session_id: ${friction.sessionId}`);
  frontmatter.push(`source: ${friction.source}`);
  frontmatter.push('---');
  return `${frontmatter.join('\n')}\n\n# ${rendered.title}\n\n${rendered.body}\n`;
}
