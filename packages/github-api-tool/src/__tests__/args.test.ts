import { describe, expect, it } from 'vitest';
import { parsePositiveInteger } from '../utils/args.js';

describe('parsePositiveInteger', () => {
  it('parses positive integer values', () => {
    expect(parsePositiveInteger('1', '--limit')).toBe(1);
    expect(parsePositiveInteger('42', '--issue')).toBe(42);
  });

  it('rejects non-integers and non-positive values', () => {
    expect(() => parsePositiveInteger('0', '--limit')).toThrow(
      'Invalid --limit: "0". Expected a positive integer.'
    );
    expect(() => parsePositiveInteger('-5', '--limit')).toThrow(
      'Invalid --limit: "-5". Expected a positive integer.'
    );
    expect(() => parsePositiveInteger('abc', '--issue')).toThrow(
      'Invalid --issue: "abc". Expected a positive integer.'
    );
  });
});
