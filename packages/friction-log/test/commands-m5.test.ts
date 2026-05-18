import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runImport, parseMarkdownContent } from '../src/commands/import.js';
import { mergeConfigYaml, mergeStopHook, runInit } from '../src/commands/init.js';
import { FrictionDb } from '../src/db.js';
import { listTemplates, loadTemplate, pickTemplateForCategory } from '../src/templates.js';

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'friction-log-m5-'));
  dbPath = join(workDir, 'db.sqlite');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('m5 templates', () => {
  it('loads all four new templates plus the three from M1', () => {
    const names = listTemplates();
    for (const n of [
      'tool-error',
      'output-overflow',
      'workflow-friction',
      'tool-missing-capability',
      'auth-expiry',
      'schema-drift',
      'doc-gap',
    ]) {
      expect(names).toContain(n);
      const tpl = loadTemplate(n);
      expect(tpl.title.length).toBeGreaterThan(0);
      expect(tpl.body.length).toBeGreaterThan(0);
    }
  });

  it('auto-picks the new templates by category match', () => {
    expect(pickTemplateForCategory('auth-expiry')).toBe('auth-expiry');
    expect(pickTemplateForCategory('schema-drift')).toBe('schema-drift');
    expect(pickTemplateForCategory('doc-gap')).toBe('doc-gap');
    expect(pickTemplateForCategory('tool-missing-capability')).toBe('tool-missing-capability');
  });
});

describe('import markdown-frontmatter', () => {
  function seedDir(files: Record<string, string>): string {
    const root = join(workDir, 'memory');
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      writeFileSync(makeDir(path), content);
    }
    return root;
  }

  function makeDir(filepath: string): string {
    const { dirname } = require('node:path') as typeof import('node:path');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(dirname(filepath), { recursive: true });
    return filepath;
  }

  it('parses YAML frontmatter and falls back to H1 + body when keys are absent', () => {
    const parsed = parseMarkdownContent(
      '---\ntitle: a friction\ntool_surface: mcp:foo\nseverity: high\ncategory: tool-error\n---\nbody line\n'
    );
    expect(parsed?.title).toBe('a friction');
    expect(parsed?.toolSurface).toBe('mcp:foo');
    expect(parsed?.severity).toBe('high');
    expect(parsed?.description).toBe('body line');

    const fromH1 = parseMarkdownContent('# headline title\n\ndetailed body\n');
    expect(fromH1?.title).toBe('headline title');
    expect(fromH1?.description).toBe('detailed body');
  });

  it('imports a directory, preserves unknown frontmatter as tags, and is idempotent on rerun', () => {
    const root = seedDir({
      'a.md':
        '---\ntitle: tasks_list overflow\ntool_surface: mcp:agent-tasks/tasks_list\ncategory: output-overflow\nseverity: high\npriority: HIGH\n---\nbody\n',
      'subdir/b.md':
        '---\ntitle: gh JWT 401\ntool_surface: gh-token.sh\ncategory: auth-expiry\nseverity: medium\n---\nshort body\n',
      'notes.md': '# untitled-from-h1\n\nsome content\n',
      'ignore.txt': 'not markdown\n',
    });
    const first = runImport({ format: 'markdown-frontmatter', path: root, dbPath });
    expect(first.scanned).toBe(3);
    expect(first.imported).toBe(3);
    expect(first.skipped).toBe(0);

    const db = new FrictionDb(dbPath);
    try {
      const all = db.listFrictions({ source: 'import' });
      expect(all).toHaveLength(3);
      const overflowTags = db.tagsFor(all.find((f) => f.title === 'tasks_list overflow')!.id);
      expect(overflowTags.some((t) => t.startsWith('imported-from:a.md'))).toBe(true);
      expect(overflowTags.some((t) => t.startsWith('import-hash:'))).toBe(true);
      expect(overflowTags).toContain('priority:HIGH');
    } finally {
      db.close();
    }

    const second = runImport({ format: 'markdown-frontmatter', path: root, dbPath });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('rejects unknown formats', () => {
    expect(() => runImport({ format: 'csv' as never, path: workDir, dbPath })).toThrow(/not supported/);
  });
});

describe('init', () => {
  it('writes a fresh config.yml with the chosen sink and returns next-steps', async () => {
    const configPath = join(workDir, 'config.yml');
    const out = await runInit({
      configPath,
      sink: 'markdown-file',
      yes: true,
      installStopHook: false,
      detect: () => ({
        claudeCodeSettingsPath: null,
        ghAvailable: false,
        linearKeyPresent: false,
        agentTasksTokenPresent: false,
      }),
    });
    expect(out.configWritten).toBe(true);
    expect(out.configExistedBefore).toBe(false);
    expect(out.defaultSink).toBe('markdown-file');
    expect(out.stopHookWrittenTo).toBeNull();
    const written = readFileSync(configPath, 'utf8');
    expect(written).toMatch(/default_sink:\s*markdown-file/);
    expect(written).toContain('sinks:');
    expect(out.nextSteps.join('\n')).toContain('first friction');
  });

  it('is idempotent on re-run with the same sink', async () => {
    const configPath = join(workDir, 'config.yml');
    const noopDetect = () => ({
      claudeCodeSettingsPath: null,
      ghAvailable: false,
      linearKeyPresent: false,
      agentTasksTokenPresent: false,
    });
    await runInit({ configPath, sink: 'stdout-json', yes: true, detect: noopDetect });
    const second = await runInit({ configPath, sink: 'stdout-json', yes: true, detect: noopDetect });
    expect(second.configWritten).toBe(false);
    expect(second.configExistedBefore).toBe(true);
  });

  it('installs the Stop-hook into a Claude settings.json when asked', async () => {
    const claudeSettings = join(workDir, 'claude', 'settings.json');
    const configPath = join(workDir, 'config.yml');
    const out = await runInit({
      configPath,
      sink: 'markdown-file',
      yes: true,
      installStopHook: true,
      detect: () => ({
        claudeCodeSettingsPath: claudeSettings,
        ghAvailable: false,
        linearKeyPresent: false,
        agentTasksTokenPresent: false,
      }),
    });
    expect(out.stopHookWrittenTo).toBe(claudeSettings);
    const json = JSON.parse(readFileSync(claudeSettings, 'utf8')) as {
      hooks: { Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const group = json.hooks.Stop[0];
    expect(group.matcher).toBe('');
    expect(group.hooks.some((h) => h.command.includes('friction-log scan'))).toBe(true);
  });

  it('mergeStopHook is idempotent and merges into an existing Stop group', () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'other' }] }] },
    });
    const once = mergeStopHook(existing);
    const twice = mergeStopHook(once);
    expect(once).toBe(twice);
    const parsed = JSON.parse(once) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
    const commands = parsed.hooks.Stop[0].hooks.map((h) => h.command);
    expect(commands).toContain('other');
    expect(commands.some((c) => c.includes('friction-log scan'))).toBe(true);
  });

  it('mergeConfigYaml preserves user-set fields outside the touched sink', () => {
    const existing = 'sinks:\n  github-issues:\n    repo: x/y\nsome_user_key: kept\n';
    const merged = mergeConfigYaml(existing, 'markdown-file');
    expect(merged).toContain('repo: x/y');
    expect(merged).toContain('some_user_key: kept');
    expect(merged).toContain('default_sink: markdown-file');
  });
});
