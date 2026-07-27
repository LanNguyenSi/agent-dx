import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FrictionDb, type InsertFrictionInput } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { maybeSyncExport } from './sync-export.js';
import type { Severity } from '../types.js';

export type ImportFormat = 'markdown-frontmatter';

export interface ImportCommandInput {
  format: ImportFormat;
  path: string;
  dbPath?: string;
  configPath?: string;
}

export interface ImportCommandOutput {
  scanned: number;
  imported: number;
  skipped: number;
  errors: Array<{ file: string; reason: string }>;
}

const SEVERITY_VALUES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export function runImport(input: ImportCommandInput): ImportCommandOutput {
  if (input.format !== 'markdown-frontmatter') {
    throw new Error(`friction-log: import format "${input.format}" is not supported in M5`);
  }
  const files = walkMarkdown(input.path);
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = new FrictionDb(dbPath);
  let imported = 0;
  let skipped = 0;
  const errors: ImportCommandOutput['errors'] = [];
  try {
    // Build the set of known import-hashes up front so dedup is O(1) per
    // file instead of O(existing) per file.
    const knownHashes = new Set<string>();
    for (const existing of db.listFrictions({ source: 'import', limit: 100_000 })) {
      for (const tag of db.tagsFor(existing.id)) {
        if (tag.startsWith('import-hash:')) knownHashes.add(tag.slice('import-hash:'.length));
      }
    }
    for (const file of files) {
      try {
        const parsed = parseMarkdownFile(file);
        if (!parsed) {
          skipped++;
          continue;
        }
        const tagFingerprint = hashFor(parsed);
        if (knownHashes.has(tagFingerprint)) {
          skipped++;
          continue;
        }
        const insert: InsertFrictionInput = {
          title: parsed.title,
          description: parsed.description,
          toolSurface: parsed.toolSurface,
          category: parsed.category,
          severity: parsed.severity,
          sessionId: parsed.sessionId,
          capturedAt: parsed.capturedAt,
          source: 'import',
        };
        const friction = db.insertFriction(insert);
        db.addTag(friction.id, `imported-from:${relative(input.path, file)}`);
        db.addTag(friction.id, `import-hash:${tagFingerprint}`);
        for (const extra of parsed.extraTags) {
          db.addTag(friction.id, extra);
        }
        knownHashes.add(tagFingerprint);
        imported++;
      } catch (err) {
        errors.push({ file, reason: (err as Error).message });
      }
    }
    // Skip write-through when nothing was actually imported (e.g. a full
    // re-run of an already-imported directory, all deduped).
    if (imported > 0) {
      maybeSyncExport({ dbPath, configPath: input.configPath });
    }
  } finally {
    db.close();
  }
  return { scanned: files.length, imported, skipped, errors };
}

interface ParsedRecord {
  title: string;
  description: string | null;
  toolSurface: string | null;
  category: string | null;
  severity: Severity | null;
  sessionId: string | null;
  capturedAt: string | undefined;
  extraTags: string[];
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  function visit(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
      } else if (st.isFile() && (name.endsWith('.md') || name.endsWith('.markdown'))) {
        out.push(full);
      }
    }
  }
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new Error(`friction-log: import path does not exist: ${root}`);
  }
  if (rootStat.isFile()) {
    out.push(root);
  } else {
    visit(root);
  }
  return out;
}

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function parseMarkdownFile(file: string): ParsedRecord | null {
  const raw = readFileSync(file, 'utf8');
  return parseMarkdownContent(raw);
}

export function parseMarkdownContent(raw: string): ParsedRecord | null {
  const match = FRONTMATTER_PATTERN.exec(raw);
  let frontmatter: Record<string, unknown> = {};
  let body: string;
  if (match) {
    const parsedYaml = parseYaml(match[1]) as unknown;
    if (parsedYaml && typeof parsedYaml === 'object' && !Array.isArray(parsedYaml)) {
      frontmatter = parsedYaml as Record<string, unknown>;
    }
    body = raw.slice(match[0].length);
  } else {
    body = raw;
  }
  const title = pickTitle(frontmatter, body);
  if (!title) return null;
  const description = pickDescription(frontmatter, body);
  const toolSurface = pickString(frontmatter, ['tool_surface', 'toolSurface', 'tool', 'surface']);
  const category = pickString(frontmatter, ['category', 'type']);
  const severity = pickSeverity(frontmatter);
  const sessionId = pickString(frontmatter, ['session_id', 'sessionId', 'session']);
  const capturedAt = pickIsoDate(frontmatter, ['captured_at', 'capturedAt', 'date']);
  const extraTags = collectExtraTags(frontmatter);
  return { title, description, toolSurface, category, severity, sessionId, capturedAt, extraTags };
}

function pickTitle(frontmatter: Record<string, unknown>, body: string): string | null {
  const fmTitle = pickString(frontmatter, ['title']);
  if (fmTitle) return fmTitle;
  const h1 = /^#\s+(.+)$/m.exec(body);
  return h1 ? h1[1].trim() : null;
}

function pickDescription(frontmatter: Record<string, unknown>, body: string): string | null {
  const fmDesc = pickString(frontmatter, ['description', 'summary']);
  if (fmDesc) return fmDesc;
  const stripped = body.replace(/^#\s+.+\n+/m, '').trim();
  return stripped || null;
}

function pickString(frontmatter: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = frontmatter[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickSeverity(frontmatter: Record<string, unknown>): Severity | null {
  const s = pickString(frontmatter, ['severity']);
  if (!s) return null;
  const lower = s.toLowerCase();
  return (SEVERITY_VALUES as readonly string[]).includes(lower) ? (lower as Severity) : null;
}

function pickIsoDate(frontmatter: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = frontmatter[k];
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    } else if (v instanceof Date && !Number.isNaN(v.getTime())) {
      return v.toISOString();
    }
  }
  return undefined;
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  'title',
  'description',
  'summary',
  'tool_surface',
  'toolSurface',
  'tool',
  'surface',
  'category',
  'type',
  'severity',
  'session_id',
  'sessionId',
  'session',
  'captured_at',
  'capturedAt',
  'date',
]);

function collectExtraTags(frontmatter: Record<string, unknown>): string[] {
  const tags: string[] = [];
  // Honor an explicit "tags:" or "labels:" array first.
  for (const k of ['tags', 'labels']) {
    const v = frontmatter[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) tags.push(item.trim());
      }
    }
  }
  // Then expose unknown scalar keys as `key:value` tags so context is not lost.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    if (key === 'tags' || key === 'labels') continue;
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      tags.push(`${key}:${String(value)}`);
    }
  }
  return tags;
}

function hashFor(p: ParsedRecord): string {
  const h = createHash('sha1');
  h.update(p.title);
  h.update(' ');
  h.update(p.description ?? '');
  h.update(' ');
  h.update(p.toolSurface ?? '');
  return h.digest('hex').slice(0, 16);
}

