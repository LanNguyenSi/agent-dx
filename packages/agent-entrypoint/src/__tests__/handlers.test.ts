import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { FILENAME } from '../lib';
import { handleGenerate, handleShow, handleValidate } from '../index';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aep-handlers-'));
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('agent-entrypoint handlers', () => {
  let logs: string[];
  let exits: number[];

  beforeEach(() => {
    logs = [];
    exits = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      throw new ExitError(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleGenerate', () => {
    it('writes a manifest with project name and primary docs', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');

      handleGenerate({ dir, project: 'fixture' });

      const outPath = path.join(dir, FILENAME);
      expect(fs.existsSync(outPath)).toBe(true);
      const written = yaml.load(fs.readFileSync(outPath, 'utf-8')) as Record<string, unknown>;
      expect(written.project).toBe('fixture');
      expect(written.primary_docs).toContain('README.md');
      expect(logs.some((l) => l.includes('Generated'))).toBe(true);

      fs.rmSync(dir, { recursive: true });
    });

    it('aborts with exit 1 when the file already exists and --force is not set', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, FILENAME), 'existing: true\n');

      expect(() => handleGenerate({ dir })).toThrow(ExitError);
      expect(exits).toEqual([1]);
      expect(logs.join('\n')).toContain('already exists');

      fs.rmSync(dir, { recursive: true });
    });

    it('overwrites an existing file when --force is set', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, FILENAME), 'old: true\n');

      handleGenerate({ dir, force: true });

      const written = fs.readFileSync(path.join(dir, FILENAME), 'utf-8');
      expect(written).not.toContain('old: true');
      expect(written).toContain('project:');

      fs.rmSync(dir, { recursive: true });
    });
  });

  describe('handleValidate', () => {
    it('passes for a valid manifest', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
      fs.writeFileSync(
        path.join(dir, FILENAME),
        yaml.dump({
          project: 'valid',
          primary_docs: ['README.md'],
          components: [{ name: 'app', role: 'main' }],
          first_checks: ['npm test'],
          do_not_assume: ['env is set'],
          authoritative_sources: ['README.md'],
        }),
      );

      handleValidate({ dir });

      expect(exits).toEqual([]);
      expect(logs.join('\n')).toContain('is valid');

      fs.rmSync(dir, { recursive: true });
    });

    it('exits 1 with a hint when the file is missing', () => {
      const dir = makeTmpDir();

      expect(() => handleValidate({ dir })).toThrow(ExitError);
      expect(exits).toEqual([1]);
      expect(logs.join('\n')).toContain('not found');
      expect(logs.join('\n')).toContain('agent-entrypoint generate');

      fs.rmSync(dir, { recursive: true });
    });

    it('exits 1 on invalid YAML', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, FILENAME), ': not: valid: yaml: {{{');

      expect(() => handleValidate({ dir })).toThrow(ExitError);
      expect(exits).toEqual([1]);
      expect(logs.join('\n')).toContain('YAML parse error');

      fs.rmSync(dir, { recursive: true });
    });

    it('exits 1 and enumerates issues when required fields are missing', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, FILENAME), yaml.dump({ project: 'incomplete' }));

      expect(() => handleValidate({ dir })).toThrow(ExitError);
      expect(exits).toEqual([1]);
      const out = logs.join('\n');
      expect(out).toContain('Validation failed');
      expect(out).toContain('primary_docs');

      fs.rmSync(dir, { recursive: true });
    });
  });

  describe('handleShow', () => {
    it('prints the manifest sections in human-readable form', () => {
      const dir = makeTmpDir();
      fs.writeFileSync(
        path.join(dir, FILENAME),
        yaml.dump({
          project: 'showcase',
          primary_docs: ['README.md'],
          components: [{ name: 'app', role: 'main' }],
          first_checks: ['npm test'],
          do_not_assume: ['env is set'],
          authoritative_sources: ['README.md'],
        }),
      );

      handleShow({ dir });

      const out = logs.join('\n');
      expect(out).toContain('showcase');
      expect(out).toContain('README.md');
      expect(out).toContain('app');
      expect(out).toContain('npm test');

      fs.rmSync(dir, { recursive: true });
    });

    it('exits 1 when the file is missing', () => {
      const dir = makeTmpDir();

      expect(() => handleShow({ dir })).toThrow(ExitError);
      expect(exits).toEqual([1]);
      expect(logs.join('\n')).toContain('not found');

      fs.rmSync(dir, { recursive: true });
    });
  });
});
