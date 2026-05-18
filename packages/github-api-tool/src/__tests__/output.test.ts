import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { error, output, success, warn } from '../utils/output.js';

describe('output', () => {
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits valid pretty-printed JSON when json:true', () => {
    output({ name: 'release', count: 3 }, { json: true });
    const parsed = JSON.parse(logs.join('\n')) as Record<string, unknown>;
    expect(parsed).toEqual({ name: 'release', count: 3 });
  });

  it('emits the same JSON shape for arrays under json:true', () => {
    output([{ id: 1 }, { id: 2 }], { json: true });
    const parsed = JSON.parse(logs.join('\n')) as unknown[];
    expect(parsed).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('renders a "(no results)" hint for an empty array in human mode', () => {
    output([]);
    expect(logs.some((line) => line.includes('(no results)'))).toBe(true);
  });

  it('renders object key/value pairs in human mode', () => {
    output({ name: 'release', count: 3 });
    const combined = logs.join('\n');
    expect(combined).toContain('name:');
    expect(combined).toContain('release');
    expect(combined).toContain('count:');
    expect(combined).toContain('3');
  });

  it('renders multiple rows with a blank line between them in human mode', () => {
    output([{ id: 1 }, { id: 2 }]);
    // first row + blank separator + second row → at least one empty entry
    expect(logs).toContain('');
  });

  it('success() prints to stdout with the message', () => {
    success('done');
    expect(logs.join('\n')).toContain('done');
    expect(errs).toEqual([]);
  });

  it('warn() prints to stdout with the message', () => {
    warn('careful');
    expect(logs.join('\n')).toContain('careful');
    expect(errs).toEqual([]);
  });

  it('error() prints to stderr with the message and an optional cause', () => {
    error('failed to fetch', new Error('network down'));
    const combined = errs.join('\n');
    expect(combined).toContain('failed to fetch');
    expect(combined).toContain('network down');
    expect(logs).toEqual([]);
  });

  it('error() without a cause omits the gray detail line', () => {
    error('something');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('something');
  });
});
