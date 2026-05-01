import { describe, it, expect } from 'vitest';
import { parseCoverageSummary } from './coverage-check.js';

function makeSummary(overrides: Record<string, unknown> = {}): string {
  const base = {
    total: {
      lines:      { total: 100, covered: 85, skipped: 0, pct: 85 },
      statements: { total: 120, covered: 96, skipped: 0, pct: 80 },
      functions:  { total: 40,  covered: 36, skipped: 0, pct: 90 },
      branches:   { total: 60,  covered: 45, skipped: 0, pct: 75 },
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

describe('parseCoverageSummary', () => {
  it('parses a valid summary and passes when above threshold', () => {
    const result = parseCoverageSummary(makeSummary(), 80);
    expect(result.pct).toBe(80);
    expect(result.passed).toBe(true);
  });

  it('returns all metric fields', () => {
    const result = parseCoverageSummary(makeSummary(), 80);
    expect(result.lines).toBe(85);
    expect(result.statements).toBe(80);
    expect(result.functions).toBe(90);
    expect(result.branches).toBe(75);
  });

  it('returns passed=false when below threshold', () => {
    const result = parseCoverageSummary(makeSummary(), 85);
    expect(result.passed).toBe(false);
  });

  it('returns passed=true when exactly at threshold', () => {
    const result = parseCoverageSummary(makeSummary(), 80);
    expect(result.passed).toBe(true);
  });

  it('falls back to lines.pct when statements is missing', () => {
    const json = JSON.stringify({
      total: {
        lines:     { total: 100, covered: 90, skipped: 0, pct: 90 },
        functions: { total: 10,  covered: 9,  skipped: 0, pct: 90 },
        branches:  { total: 10,  covered: 9,  skipped: 0, pct: 90 },
      },
    });
    const result = parseCoverageSummary(json, 80);
    expect(result.pct).toBe(90);
    expect(result.statements).toBeUndefined();
  });

  it('throws when total key is missing', () => {
    expect(() => parseCoverageSummary(JSON.stringify({ 'src/foo.ts': {} }), 80))
      .toThrow('Coverage file missing "total" key');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseCoverageSummary('not-json', 80))
      .toThrow('Invalid JSON in coverage file');
  });

  it('throws when no pct can be determined', () => {
    const json = JSON.stringify({ total: { functions: { total: 10, covered: 9, skipped: 0, pct: 90 } } });
    expect(() => parseCoverageSummary(json, 80))
      .toThrow('Cannot determine coverage percentage');
  });

  it('uses 100% threshold correctly', () => {
    expect(parseCoverageSummary(makeSummary(), 100).passed).toBe(false);
  });

  it('uses 0% threshold correctly', () => {
    expect(parseCoverageSummary(makeSummary(), 0).passed).toBe(true);
  });
});
