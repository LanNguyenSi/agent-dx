import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runDigest, formatDigest } from '../src/commands/digest.js';
import { runExport } from '../src/commands/export.js';
import { runLog } from '../src/commands/log.js';
import { runSearch } from '../src/commands/search.js';
import { FrictionDb } from '../src/db.js';

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'friction-log-m3-'));
  dbPath = join(workDir, 'db.sqlite');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('schema v2 migration', () => {
  it('enforces the severity CHECK constraint via the new table', () => {
    const db = new FrictionDb(dbPath);
    try {
      expect(() =>
        db.insertFriction({
          title: 'bad severity',
          source: 'manual',
          // bypass the type system to simulate a caller skipping commander validation
          severity: 'super-critical' as unknown as 'critical',
        })
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('migrates an existing v1 db with a rogue severity to v2 without losing rows', () => {
    // Build a v1-shaped db manually, seed a rogue severity, then open it with
    // FrictionDb so the v2 migration runs.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        project_paths TEXT,
        transcript_path TEXT,
        adapter TEXT NOT NULL
      );
      CREATE TABLE frictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id),
        tool_surface TEXT,
        title TEXT NOT NULL,
        description TEXT,
        captured_at TEXT NOT NULL,
        severity TEXT,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        recurrence_of_id INTEGER REFERENCES frictions(id),
        source TEXT NOT NULL CHECK(source IN ('scan','manual','import'))
      );
      CREATE VIRTUAL TABLE frictions_fts USING fts5(title, description, content='frictions', content_rowid='id');
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, friction_id INTEGER NOT NULL REFERENCES frictions(id), sink_name TEXT NOT NULL, sink_target TEXT, external_ref TEXT, created_at TEXT NOT NULL, pr_url TEXT, resolution_status TEXT);
      CREATE TABLE tags (friction_id INTEGER NOT NULL REFERENCES frictions(id), tag TEXT NOT NULL, PRIMARY KEY(friction_id, tag));
      INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
      INSERT INTO frictions (title, captured_at, severity, source) VALUES ('ok row', '2026-05-01T00:00:00Z', 'high', 'manual');
      INSERT INTO frictions (title, captured_at, severity, source) VALUES ('rogue row', '2026-05-02T00:00:00Z', 'super-critical', 'manual');
      -- Seed incoming FK rows. The v2 migration drops the frictions table;
      -- without an explicit foreign_keys = OFF the DROP would fail with
      -- "FOREIGN KEY constraint failed" because tasks/tags reference it.
      INSERT INTO tasks (friction_id, sink_name, created_at) VALUES (1, 'markdown-file', '2026-05-01T01:00:00Z');
      INSERT INTO tags (friction_id, tag) VALUES (1, 'urgent');
    `);
    raw.close();

    const db = new FrictionDb(dbPath);
    try {
      expect(db.schemaVersion()).toBe(2);
      const rows = db.listFrictions();
      expect(rows).toHaveLength(2);
      const rogue = rows.find((r) => r.title === 'rogue row');
      expect(rogue?.severity).toBeNull();
      // FTS rebuild must have picked up both rows.
      expect(db.searchFrictions('rogue').map((f) => f.id)).toEqual([rogue!.id]);
      // Incoming FK rows must have survived the table swap.
      const ok = rows.find((r) => r.title === 'ok row')!;
      expect(db.listTasksForFriction(ok.id)).toHaveLength(1);
      expect(db.tagsFor(ok.id)).toEqual(['urgent']);
    } finally {
      db.close();
    }
  });

  it('re-enables foreign_keys after migration and rejects orphan task inserts', () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        project_paths TEXT,
        transcript_path TEXT,
        adapter TEXT NOT NULL
      );
      CREATE TABLE frictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id),
        tool_surface TEXT,
        title TEXT NOT NULL,
        description TEXT,
        captured_at TEXT NOT NULL,
        severity TEXT,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        recurrence_of_id INTEGER REFERENCES frictions(id),
        source TEXT NOT NULL CHECK(source IN ('scan','manual','import'))
      );
      CREATE VIRTUAL TABLE frictions_fts USING fts5(title, description, content='frictions', content_rowid='id');
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, friction_id INTEGER NOT NULL REFERENCES frictions(id), sink_name TEXT NOT NULL, sink_target TEXT, external_ref TEXT, created_at TEXT NOT NULL, pr_url TEXT, resolution_status TEXT);
      CREATE TABLE tags (friction_id INTEGER NOT NULL REFERENCES frictions(id), tag TEXT NOT NULL, PRIMARY KEY(friction_id, tag));
      INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
      INSERT INTO frictions (title, captured_at, source) VALUES ('seed', '2026-05-01T00:00:00Z', 'manual');
    `);
    raw.close();
    const db = new FrictionDb(dbPath);
    try {
      expect(() =>
        db.insertTask({ frictionId: 99999, sinkName: 'markdown-file' })
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });
});

describe('recurrence_of_id auto-link', () => {
  it('auto-links a second insert with same tool+title to the first', () => {
    const db = new FrictionDb(dbPath);
    try {
      const first = db.insertFriction({
        title: 'tasks_list overflow',
        toolSurface: 'mcp:agent-tasks/tasks_list',
        source: 'manual',
      });
      const second = db.insertFriction({
        title: 'tasks_list overflow',
        toolSurface: 'mcp:agent-tasks/tasks_list',
        source: 'manual',
      });
      expect(first.recurrenceOfId).toBeNull();
      expect(second.recurrenceOfId).toBe(first.id);
    } finally {
      db.close();
    }
  });

  it('does not link when tool differs or title differs', () => {
    const db = new FrictionDb(dbPath);
    try {
      const a = db.insertFriction({ title: 't', toolSurface: 'x', source: 'manual' });
      const b = db.insertFriction({ title: 't', toolSurface: 'y', source: 'manual' });
      const c = db.insertFriction({ title: 'u', toolSurface: 'x', source: 'manual' });
      expect(b.recurrenceOfId).toBeNull();
      expect(c.recurrenceOfId).toBeNull();
      expect(a.recurrenceOfId).toBeNull();
    } finally {
      db.close();
    }
  });

  it('always links new recurrences to the root, not to intermediate children', () => {
    const db = new FrictionDb(dbPath);
    try {
      const root = db.insertFriction({ title: 'x', toolSurface: 't', source: 'manual' });
      const child1 = db.insertFriction({ title: 'x', toolSurface: 't', source: 'manual' });
      const child2 = db.insertFriction({ title: 'x', toolSurface: 't', source: 'manual' });
      expect(child1.recurrenceOfId).toBe(root.id);
      expect(child2.recurrenceOfId).toBe(root.id);
    } finally {
      db.close();
    }
  });

  it('does not auto-link to a resolved root (only open roots count)', () => {
    const db = new FrictionDb(dbPath);
    try {
      const root = db.insertFriction({ title: 'fixed-once', toolSurface: 't', source: 'manual' });
      db.updateFrictionStatus(root.id, 'resolved');
      const fresh = db.insertFriction({ title: 'fixed-once', toolSurface: 't', source: 'manual' });
      expect(fresh.recurrenceOfId).toBeNull();
    } finally {
      db.close();
    }
  });

  it('honors an explicit --recurrence-of override even when none would auto-match', () => {
    const db = new FrictionDb(dbPath);
    try {
      const root = db.insertFriction({ title: 'root', source: 'manual' });
      const child = db.insertFriction({
        title: 'completely unrelated',
        source: 'manual',
        recurrenceOfId: root.id,
      });
      expect(child.recurrenceOfId).toBe(root.id);
    } finally {
      db.close();
    }
  });
});

describe('log --recurrence-of validation', () => {
  it('rejects --recurrence-of pointing at a nonexistent friction', () => {
    expect(() =>
      runLog({
        title: 'x',
        recurrenceOfId: 9999,
        dbPath,
      })
    ).toThrow(/does not match any friction/);
  });
});

describe('search command', () => {
  function seed(): void {
    const db = new FrictionDb(dbPath);
    try {
      db.insertFriction({
        title: 'tasks_list overflow',
        description: '149kB blob from agent-tasks',
        toolSurface: 'mcp:agent-tasks/tasks_list',
        category: 'output-overflow',
        source: 'manual',
      });
      db.insertFriction({
        title: 'JWT 401 from gh-token',
        description: 'short window, skew kills it',
        toolSurface: 'gh-token.sh',
        category: 'tool-error',
        source: 'manual',
      });
      db.insertFriction({
        title: 'opencode TUI blank',
        description: 'dlopen of ld-linux fails on alpine',
        toolSurface: 'docker/opencode',
        category: 'tool-error',
        source: 'scan',
      });
    } finally {
      db.close();
    }
  }

  it('finds frictions by FTS5 MATCH on title', () => {
    seed();
    const out = runSearch({ query: 'tasks_list', dbPath });
    expect(out.frictions).toHaveLength(1);
    expect(out.frictions[0].title).toContain('tasks_list');
  });

  it('finds frictions by FTS5 MATCH on description', () => {
    seed();
    const out = runSearch({ query: 'dlopen', dbPath });
    expect(out.frictions).toHaveLength(1);
    expect(out.frictions[0].title).toContain('opencode TUI');
  });

  it('combines FTS match with structured filters', () => {
    seed();
    // "overflow OR JWT" matches f1 (title "...overflow") and f2 (title "JWT ...").
    // source=manual is true for both, so both come back; the scan-sourced
    // "opencode TUI blank" never enters the result even though it lexically
    // wouldn't match the query anyway.
    const out = runSearch({ query: 'overflow OR JWT', dbPath, source: 'manual' });
    const titles = out.frictions.map((f) => f.title).sort();
    expect(titles).toEqual(['JWT 401 from gh-token', 'tasks_list overflow']);
  });

  it('rejects an empty query', () => {
    expect(() => runSearch({ query: '   ', dbPath })).toThrow(/empty/);
  });

  it('wraps FTS5 syntax errors in a friendlier message', () => {
    seed();
    // Unbalanced quote in an FTS5 phrase surfaces as a SQLite parser error;
    // the search command should hide the raw SQLite message behind a hint.
    expect(() => runSearch({ query: '"unterminated', dbPath })).toThrow(/invalid FTS5 query/);
  });
});

describe('digest command', () => {
  function seedForDigest(): void {
    const db = new FrictionDb(dbPath);
    try {
      const a = db.insertFriction({
        title: 'a',
        toolSurface: 'tool-x',
        category: 'cat1',
        severity: 'high',
        source: 'manual',
      });
      db.insertFriction({
        title: 'a',
        toolSurface: 'tool-x',
        category: 'cat1',
        severity: 'high',
        source: 'manual',
      });
      db.insertFriction({
        title: 'b',
        toolSurface: 'tool-x',
        category: 'cat2',
        severity: 'medium',
        source: 'scan',
      });
      db.insertFriction({
        title: 'c',
        toolSurface: 'tool-y',
        category: 'cat2',
        severity: 'low',
        source: 'manual',
      });
      // Mark one filed to make open-vs-filed ratio non-trivial.
      db.updateFrictionStatus(a.id, 'filed');
      db.insertTask({
        frictionId: a.id,
        sinkName: 'markdown-file',
        sinkTarget: '/tmp/x.md',
      });
    } finally {
      db.close();
    }
  }

  it('groups by tool, sorted by count desc', () => {
    seedForDigest();
    const out = runDigest({ groupBy: 'tool', dbPath });
    expect(out.rows.map((r) => r.group)).toEqual(['tool-x', 'tool-y']);
    expect(out.rows[0].total).toBe(3);
    expect(out.rows[1].total).toBe(1);
  });

  it('groups by category and surfaces open vs filed counts', () => {
    seedForDigest();
    const out = runDigest({ groupBy: 'category', dbPath });
    const cat1 = out.rows.find((r) => r.group === 'cat1')!;
    expect(cat1.total).toBe(2);
    expect(cat1.filed).toBe(1);
    expect(cat1.open).toBe(1);
    expect(cat1.recurrences).toBe(1);
  });

  it('groups by severity and source', () => {
    seedForDigest();
    const bySev = runDigest({ groupBy: 'severity', dbPath });
    expect(bySev.rows.map((r) => r.group).sort()).toEqual(['high', 'low', 'medium']);
    const bySrc = runDigest({ groupBy: 'source', dbPath });
    expect(bySrc.rows.map((r) => r.group).sort()).toEqual(['manual', 'scan']);
  });

  it('renders a non-empty digest as a table when there are rows', () => {
    seedForDigest();
    const out = runDigest({ groupBy: 'tool', dbPath });
    const rendered = formatDigest(out);
    expect(rendered).toContain('digest by tool');
    expect(rendered).toContain('tool-x');
    expect(rendered).toContain('open%');
  });

  it('reports a no-rows message when nothing matches the window', () => {
    const db = new FrictionDb(dbPath);
    try {
      // Backdate the only friction so a fresh `--last 1h` window excludes it.
      db.insertFriction({
        title: 'ancient',
        toolSurface: 't',
        source: 'manual',
        capturedAt: '2020-01-01T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
    const out = runDigest({ groupBy: 'tool', last: '1h', dbPath });
    expect(formatDigest(out)).toContain('no frictions match');
  });
});

describe('export command', () => {
  function seedForExport(): void {
    const db = new FrictionDb(dbPath);
    try {
      const f = db.insertFriction({
        title: 'has, comma "and" quotes',
        description: 'line one\nline two',
        toolSurface: 'tool',
        category: 'cat',
        severity: 'medium',
        source: 'manual',
      });
      db.addTag(f.id, 'urgent');
      db.addTag(f.id, 'audit');
    } finally {
      db.close();
    }
  }

  it('exports json with all fields and tags', () => {
    seedForExport();
    const out = runExport({ format: 'json', dbPath });
    const parsed = JSON.parse(out.rendered) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('has, comma "and" quotes');
    expect(parsed[0].tags).toEqual(['audit', 'urgent']);
    expect(parsed[0].source).toBe('manual');
  });

  it('exports csv with quoted cells and pipe-joined tags', () => {
    seedForExport();
    const out = runExport({ format: 'csv', dbPath });
    // Avoid splitting on \n: the description cell legitimately contains a
    // newline that the CSV quoting preserves inside a single record.
    expect(out.rendered.startsWith('id,sessionId,toolSurface,title')).toBe(true);
    expect(out.rendered).toContain('"has, comma ""and"" quotes"');
    expect(out.rendered).toContain('"line one\nline two"');
    expect(out.rendered).toContain('audit|urgent');
  });

  it('exports markdown with id-prefixed section headings', () => {
    seedForExport();
    const out = runExport({ format: 'md', dbPath });
    expect(out.rendered).toMatch(/^# friction-log export \(1 records\)/);
    expect(out.rendered).toContain('## #1: has, comma');
  });

  it('writes to --out file when provided and reports record count via stderr-style return', () => {
    seedForExport();
    const outPath = join(workDir, 'frictions.json');
    const out = runExport({ format: 'json', out: outPath, dbPath });
    expect(out.out).toBe(outPath);
    expect(out.count).toBe(1);
    const onDisk = readFileSync(outPath, 'utf8');
    expect(onDisk).toContain('"title": "has, comma');
  });

  it('honors filter combinators and --query FTS', () => {
    const db = new FrictionDb(dbPath);
    try {
      db.insertFriction({ title: 'alpha', toolSurface: 'tool-a', source: 'manual' });
      db.insertFriction({ title: 'bravo', toolSurface: 'tool-b', source: 'scan' });
    } finally {
      db.close();
    }
    const onlyAlpha = runExport({ format: 'json', query: 'alpha', dbPath });
    expect((JSON.parse(onlyAlpha.rendered) as unknown[]).length).toBe(1);
    const onlyManual = runExport({ format: 'json', source: 'manual', dbPath });
    expect((JSON.parse(onlyManual.rendered) as unknown[]).length).toBe(1);
  });
});
