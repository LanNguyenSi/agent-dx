import { writeFileSync } from 'node:fs';
import { FrictionDb, type ListFrictionsFilter } from '../db.js';
import { defaultDbPath } from '../paths.js';
import type { Friction, FrictionSource, FrictionStatus } from '../types.js';
import { parseAge } from './list.js';

export type ExportFormat = 'json' | 'csv' | 'md';

export interface ExportCommandInput {
  format: ExportFormat;
  out?: string;
  query?: string;
  status?: FrictionStatus;
  tool?: string;
  category?: string;
  source?: FrictionSource;
  age?: string;
  limit?: number;
  dbPath?: string;
}

export interface ExportRecord {
  id: number;
  sessionId: string | null;
  toolSurface: string | null;
  title: string;
  description: string | null;
  capturedAt: string;
  severity: string | null;
  category: string | null;
  status: string;
  recurrenceOfId: number | null;
  source: string;
  tags: string[];
}

export interface ExportCommandOutput {
  format: ExportFormat;
  rendered: string;
  out: string | null;
  count: number;
}

export function runExport(input: ExportCommandInput): ExportCommandOutput {
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
    const frictions = input.query && input.query.trim()
      ? db.searchFrictions(input.query, filter)
      : db.listFrictions(filter);
    const records: ExportRecord[] = frictions.map((f) => ({
      ...frictionToExport(f),
      tags: db.tagsFor(f.id),
    }));
    const rendered = render(input.format, records);
    if (input.out) {
      writeFileSync(input.out, rendered, 'utf8');
    }
    return { format: input.format, rendered, out: input.out ?? null, count: records.length };
  } finally {
    db.close();
  }
}

function frictionToExport(f: Friction): Omit<ExportRecord, 'tags'> {
  return {
    id: f.id,
    sessionId: f.sessionId,
    toolSurface: f.toolSurface,
    title: f.title,
    description: f.description,
    capturedAt: f.capturedAt,
    severity: f.severity,
    category: f.category,
    status: f.status,
    recurrenceOfId: f.recurrenceOfId,
    source: f.source,
  };
}

function render(format: ExportFormat, records: ExportRecord[]): string {
  if (format === 'json') return JSON.stringify(records, null, 2) + '\n';
  if (format === 'csv') return renderCsv(records);
  return renderMarkdown(records);
}

const CSV_COLUMNS: Array<keyof ExportRecord> = [
  'id',
  'sessionId',
  'toolSurface',
  'title',
  'description',
  'capturedAt',
  'severity',
  'category',
  'status',
  'recurrenceOfId',
  'source',
  'tags',
];

function renderCsv(records: ExportRecord[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = records.map((r) =>
    CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderMarkdown(records: ExportRecord[]): string {
  if (records.length === 0) return '_no frictions match the filter_\n';
  const parts: string[] = [`# friction-log export (${records.length} records)`, ''];
  for (const r of records) {
    parts.push(`## #${r.id}: ${r.title}`);
    parts.push('');
    parts.push(`- captured: \`${r.capturedAt}\``);
    parts.push(`- status: ${r.status}  source: ${r.source}`);
    if (r.toolSurface) parts.push(`- tool: \`${r.toolSurface}\``);
    if (r.category) parts.push(`- category: ${r.category}`);
    if (r.severity) parts.push(`- severity: ${r.severity}`);
    if (r.recurrenceOfId != null) parts.push(`- recurrence-of: #${r.recurrenceOfId}`);
    if (r.tags.length) parts.push(`- tags: ${r.tags.join(', ')}`);
    if (r.description) {
      parts.push('');
      parts.push(r.description);
    }
    parts.push('');
  }
  return parts.join('\n');
}
