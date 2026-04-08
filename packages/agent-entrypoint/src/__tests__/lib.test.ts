import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  detectDocs,
  detectComponents,
  detectStartCommands,
  generateManifest,
  validateManifest,
  FILENAME,
} from '../lib';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-'));
}

describe('detectDocs', () => {
  it('returns empty array when no docs exist', () => {
    const dir = makeTmpDir();
    expect(detectDocs(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  it('detects README.md', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
    expect(detectDocs(dir)).toContain('README.md');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects multiple docs', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '');
    fs.writeFileSync(path.join(dir, 'CONTRIBUTING.md'), '');
    const docs = detectDocs(dir);
    expect(docs).toContain('README.md');
    expect(docs).toContain('CONTRIBUTING.md');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detectComponents', () => {
  it('returns empty for flat repo', () => {
    const dir = makeTmpDir();
    expect(detectComponents(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  it('detects subdirectories as components', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'api'));
    fs.mkdirSync(path.join(dir, 'frontend'));
    const components = detectComponents(dir);
    const names = components.map(c => c.name);
    expect(names).toContain('api');
    expect(names).toContain('frontend');
    fs.rmSync(dir, { recursive: true });
  });

  it('assigns correct roles', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'my-agent'));
    fs.mkdirSync(path.join(dir, 'cli-tool'));
    fs.mkdirSync(path.join(dir, 'core-lib'));
    const components = detectComponents(dir);
    expect(components.find(c => c.name === 'my-agent')?.role).toBe('agent');
    expect(components.find(c => c.name === 'cli-tool')?.role).toBe('cli tool');
    expect(components.find(c => c.name === 'core-lib')?.role).toBe('shared library');
    fs.rmSync(dir, { recursive: true });
  });

  it('ignores node_modules and dist', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'dist'));
    expect(detectComponents(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  it('caps at 6 components', () => {
    const dir = makeTmpDir();
    for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(dir, `module${i}`));
    expect(detectComponents(dir).length).toBeLessThanOrEqual(6);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detectStartCommands', () => {
  it('returns fallback when nothing found', () => {
    const dir = makeTmpDir();
    const cmds = detectStartCommands(dir);
    expect(cmds).toContain('check README.md for start instructions');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects package.json', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'ts-node src/index.ts' } }));
    const cmds = detectStartCommands(dir);
    expect(cmds).toContain('npm install && npm run build');
    expect(cmds).toContain('npm run dev');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects docker-compose', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'version: "3"');
    expect(detectStartCommands(dir)).toContain('docker compose up');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('generateManifest', () => {
  it('generates valid manifest structure', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '');
    const manifest = generateManifest(dir, 'test-project');
    expect(manifest.project).toBe('test-project');
    expect(manifest.primary_docs).toContain('README.md');
    expect(manifest.components.length).toBeGreaterThanOrEqual(1);
    expect(manifest.first_checks.length).toBeGreaterThan(0);
    expect(manifest.do_not_assume.length).toBeGreaterThan(0);
    expect(manifest.authoritative_sources.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true });
  });

  it('uses dir name as default project name', () => {
    const dir = makeTmpDir();
    const manifest = generateManifest(dir);
    expect(manifest.project).toBe(path.basename(dir));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('validateManifest', () => {
  it('fails when file missing', () => {
    const dir = makeTmpDir();
    const result = validateManifest(dir);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain('not found');
    fs.rmSync(dir, { recursive: true });
  });

  it('fails on invalid YAML', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, FILENAME), ': invalid: yaml: {{{');
    const result = validateManifest(dir);
    expect(result.valid).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it('fails when required fields missing', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, FILENAME), yaml.dump({ project: 'test' }));
    const result = validateManifest(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes('primary_docs'))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('fails when referenced doc does not exist', () => {
    const dir = makeTmpDir();
    const manifest = {
      project: 'test',
      primary_docs: ['MISSING.md'],
      components: [{ name: 'app', role: 'main' }],
      first_checks: ['check something'],
      do_not_assume: ['nothing'],
      authoritative_sources: ['MISSING.md'],
    };
    fs.writeFileSync(path.join(dir, FILENAME), yaml.dump(manifest));
    const result = validateManifest(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes('MISSING.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes with valid manifest', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
    const manifest = {
      project: 'test',
      primary_docs: ['README.md'],
      components: [{ name: 'app', role: 'main' }],
      first_checks: ['run npm start'],
      do_not_assume: ['env is set'],
      authoritative_sources: ['README.md'],
    };
    fs.writeFileSync(path.join(dir, FILENAME), yaml.dump(manifest));
    const result = validateManifest(dir);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    fs.rmSync(dir, { recursive: true });
  });
});
