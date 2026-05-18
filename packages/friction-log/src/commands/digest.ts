import { FrictionDb, type DigestGroupBy, type DigestRow } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { parseAge } from './list.js';

export interface DigestCommandInput {
  groupBy: DigestGroupBy;
  last?: string;
  dbPath?: string;
}

export interface DigestCommandOutput {
  groupBy: DigestGroupBy;
  sinceIso: string | null;
  rows: DigestRow[];
}

export function runDigest(input: DigestCommandInput): DigestCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const sinceIso = parseAge(input.last) ?? null;
    const rows = db.digest(input.groupBy, sinceIso ?? undefined);
    return { groupBy: input.groupBy, sinceIso, rows };
  } finally {
    db.close();
  }
}

export function formatDigest(output: DigestCommandOutput): string {
  const { groupBy, sinceIso, rows } = output;
  const window = sinceIso ? `since ${sinceIso}` : 'all-time';
  if (rows.length === 0) {
    return `digest by ${groupBy} (${window}): no frictions match`;
  }
  const header = ['group', 'total', 'open', 'filed', 'resolved', 'wontfix', 'open%', 'recurrences', 'avg-h-triage'];
  const body = rows.map((r) => [
    r.group,
    String(r.total),
    String(r.open),
    String(r.filed),
    String(r.resolved),
    String(r.wontfix),
    r.total > 0 ? `${Math.round((r.open / r.total) * 100)}%` : '-',
    String(r.recurrences),
    r.avgHoursToTriage == null ? '-' : r.avgHoursToTriage.toFixed(1),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const fmt = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [`digest by ${groupBy} (${window})`, '', fmt(header), sep, ...body.map(fmt)].join('\n');
}
