import { FrictionDb, type ListFrictionsFilter } from '../db.js';
import { defaultDbPath } from '../paths.js';
import type { Friction, FrictionSource, FrictionStatus } from '../types.js';

export interface ListCommandInput {
  status?: FrictionStatus;
  tool?: string;
  category?: string;
  source?: FrictionSource;
  age?: string;
  limit?: number;
  dbPath?: string;
}

export interface ListCommandOutput {
  frictions: Friction[];
}

const AGE_PATTERN = /^(\d+)([dwh])$/;

export function parseAge(age: string | undefined, now: Date = new Date()): string | undefined {
  if (!age) return undefined;
  const match = AGE_PATTERN.exec(age);
  if (!match) {
    throw new Error(`friction-log: invalid --age "${age}". Use e.g. 14d, 4w, 12h`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const ms = unit === 'h' ? n * 3600_000 : unit === 'd' ? n * 86_400_000 : n * 7 * 86_400_000;
  return new Date(now.getTime() - ms).toISOString();
}

export function runList(input: ListCommandInput): ListCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const filter: ListFrictionsFilter = {
      status: input.status,
      tool: input.tool,
      category: input.category,
      source: input.source,
      sinceIso: parseAge(input.age),
      limit: input.limit,
    };
    return { frictions: db.listFrictions(filter) };
  } finally {
    db.close();
  }
}

export function formatTable(frictions: Friction[]): string {
  if (frictions.length === 0) return '(no frictions match)';
  const header = ['id', 'status', 'tool', 'category', 'captured', 'title'];
  const rows = frictions.map((f) => [
    String(f.id),
    f.status,
    f.toolSurface ?? '-',
    f.category ?? '-',
    f.capturedAt.slice(0, 16).replace('T', ' '),
    truncate(f.title, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const fmt = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
