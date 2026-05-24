import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Friction,
  FrictionSource,
  FrictionStatus,
  Severity,
  Session,
  Task,
} from './types.js';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 2,
    sql: `
      -- Add a CHECK constraint on severity so the programmatic API matches
      -- the CLI's commander-choices validation. SQLite can't ALTER ADD
      -- CONSTRAINT, so we recreate the table. Pre-migration we normalize any
      -- rogue values to NULL so the copy doesn't fail.
      UPDATE frictions
         SET severity = NULL
       WHERE severity IS NOT NULL
         AND severity NOT IN ('low', 'medium', 'high', 'critical');

      CREATE TABLE frictions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id),
        tool_surface TEXT,
        title TEXT NOT NULL,
        description TEXT,
        captured_at TEXT NOT NULL,
        severity TEXT CHECK(severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
        category TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        recurrence_of_id INTEGER REFERENCES frictions(id),
        source TEXT NOT NULL CHECK(source IN ('scan', 'manual', 'import'))
      );

      INSERT INTO frictions_new
        (id, session_id, tool_surface, title, description, captured_at, severity, category, status, recurrence_of_id, source)
      SELECT id, session_id, tool_surface, title, description, captured_at, severity, category, status, recurrence_of_id, source
        FROM frictions;

      DROP TABLE frictions;
      ALTER TABLE frictions_new RENAME TO frictions;

      -- Indexes and FTS triggers were dropped with the old table; recreate them.
      CREATE INDEX idx_frictions_status ON frictions(status);
      CREATE INDEX idx_frictions_tool ON frictions(tool_surface);
      CREATE INDEX idx_frictions_category ON frictions(category);
      CREATE INDEX idx_frictions_captured ON frictions(captured_at);

      -- Rebuild the FTS5 shadow rows; the virtual table itself survives the
      -- DROP because it lives in a separate sqlite_master row, but its
      -- content reference is now stale, so refresh it.
      INSERT INTO frictions_fts(frictions_fts) VALUES ('rebuild');

      CREATE TRIGGER frictions_ai AFTER INSERT ON frictions BEGIN
        INSERT INTO frictions_fts(rowid, title, description)
        VALUES (new.id, new.title, coalesce(new.description, ''));
      END;

      CREATE TRIGGER frictions_ad AFTER DELETE ON frictions BEGIN
        INSERT INTO frictions_fts(frictions_fts, rowid, title, description)
        VALUES ('delete', old.id, old.title, coalesce(old.description, ''));
      END;

      CREATE TRIGGER frictions_au AFTER UPDATE ON frictions BEGIN
        INSERT INTO frictions_fts(frictions_fts, rowid, title, description)
        VALUES ('delete', old.id, old.title, coalesce(old.description, ''));
        INSERT INTO frictions_fts(rowid, title, description)
        VALUES (new.id, new.title, coalesce(new.description, ''));
      END;
    `,
  },
  {
    version: 1,
    sql: `
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

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
        source TEXT NOT NULL CHECK(source IN ('scan', 'manual', 'import'))
      );

      CREATE INDEX idx_frictions_status ON frictions(status);
      CREATE INDEX idx_frictions_tool ON frictions(tool_surface);
      CREATE INDEX idx_frictions_category ON frictions(category);
      CREATE INDEX idx_frictions_captured ON frictions(captured_at);

      CREATE VIRTUAL TABLE frictions_fts USING fts5(
        title,
        description,
        content='frictions',
        content_rowid='id'
      );

      CREATE TRIGGER frictions_ai AFTER INSERT ON frictions BEGIN
        INSERT INTO frictions_fts(rowid, title, description)
        VALUES (new.id, new.title, coalesce(new.description, ''));
      END;

      CREATE TRIGGER frictions_ad AFTER DELETE ON frictions BEGIN
        INSERT INTO frictions_fts(frictions_fts, rowid, title, description)
        VALUES ('delete', old.id, old.title, coalesce(old.description, ''));
      END;

      CREATE TRIGGER frictions_au AFTER UPDATE ON frictions BEGIN
        INSERT INTO frictions_fts(frictions_fts, rowid, title, description)
        VALUES ('delete', old.id, old.title, coalesce(old.description, ''));
        INSERT INTO frictions_fts(rowid, title, description)
        VALUES (new.id, new.title, coalesce(new.description, ''));
      END;

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        friction_id INTEGER NOT NULL REFERENCES frictions(id),
        sink_name TEXT NOT NULL,
        sink_target TEXT,
        external_ref TEXT,
        created_at TEXT NOT NULL,
        pr_url TEXT,
        resolution_status TEXT
      );

      CREATE INDEX idx_tasks_friction ON tasks(friction_id);

      CREATE TABLE tags (
        friction_id INTEGER NOT NULL REFERENCES frictions(id),
        tag TEXT NOT NULL,
        PRIMARY KEY(friction_id, tag)
      );
    `,
  },
];

interface FrictionRow {
  id: number;
  session_id: string | null;
  tool_surface: string | null;
  title: string;
  description: string | null;
  captured_at: string;
  severity: string | null;
  category: string | null;
  status: string;
  recurrence_of_id: number | null;
  source: string;
}

interface TaskRow {
  id: number;
  friction_id: number;
  sink_name: string;
  sink_target: string | null;
  external_ref: string | null;
  created_at: string;
  pr_url: string | null;
  resolution_status: string | null;
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  project_paths: string | null;
  transcript_path: string | null;
  adapter: string;
}

function rowToFriction(r: FrictionRow): Friction {
  return {
    id: r.id,
    sessionId: r.session_id,
    toolSurface: r.tool_surface,
    title: r.title,
    description: r.description,
    capturedAt: r.captured_at,
    severity: (r.severity as Severity | null) ?? null,
    category: r.category,
    status: r.status as FrictionStatus,
    recurrenceOfId: r.recurrence_of_id,
    source: r.source as FrictionSource,
  };
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    frictionId: r.friction_id,
    sinkName: r.sink_name,
    sinkTarget: r.sink_target,
    externalRef: r.external_ref,
    createdAt: r.created_at,
    prUrl: r.pr_url,
    resolutionStatus: r.resolution_status,
  };
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    projectPaths: r.project_paths ? (JSON.parse(r.project_paths) as string[]) : null,
    transcriptPath: r.transcript_path,
    adapter: r.adapter,
  };
}

export interface InsertFrictionInput {
  sessionId?: string | null;
  toolSurface?: string | null;
  title: string;
  description?: string | null;
  capturedAt?: string;
  severity?: Severity | null;
  category?: string | null;
  source: FrictionSource;
  recurrenceOfId?: number | null;
}

export interface ListFrictionsFilter {
  status?: FrictionStatus;
  tool?: string;
  category?: string;
  source?: FrictionSource;
  sinceIso?: string;
  limit?: number;
}

export type DigestGroupBy = 'tool' | 'category' | 'severity' | 'source';

export interface DigestRow {
  group: string;
  total: number;
  open: number;
  filed: number;
  resolved: number;
  wontfix: number;
  recurrences: number;
  avgHoursToTriage: number | null;
}

export interface InsertTaskInput {
  frictionId: number;
  sinkName: string;
  sinkTarget?: string | null;
  externalRef?: string | null;
  prUrl?: string | null;
  resolutionStatus?: string | null;
}

export class FrictionDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const hasVersionTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
      .get();

    const currentVersion = hasVersionTable
      ? ((this.db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as
          | { v: number | null }
          | undefined)?.v ?? 0)
      : 0;

    const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
    for (const m of ordered) {
      if (m.version <= currentVersion) continue;
      // foreign_keys can only be toggled outside a transaction. Some
      // migrations (notably v2's DROP+RENAME on `frictions`) trip incoming
      // FKs from `tasks` and `tags`, so we drop enforcement, run the
      // migration, then re-enable and re-check before moving on.
      this.db.pragma('foreign_keys = OFF');
      try {
        this.db.transaction(() => {
          this.db.exec(m.sql);
          this.db
            .prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`)
            .run(m.version, new Date().toISOString());
        })();
        const violations = this.db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `friction-log: migration v${m.version} left orphan foreign keys: ${JSON.stringify(violations)}`
          );
        }
      } finally {
        this.db.pragma('foreign_keys = ON');
      }
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  }

  upsertSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, started_at, ended_at, project_paths, transcript_path, adapter)
         VALUES (@id, @startedAt, @endedAt, @projectPaths, @transcriptPath, @adapter)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           project_paths = excluded.project_paths,
           transcript_path = excluded.transcript_path,
           adapter = excluded.adapter`
      )
      .run({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        projectPaths: s.projectPaths ? JSON.stringify(s.projectPaths) : null,
        transcriptPath: s.transcriptPath,
        adapter: s.adapter,
      });
  }

  /**
   * Create a minimal sessions row for `id` if none exists yet. Used by
   * the `log` command path so `friction-log log --session <fresh-id>`
   * can attribute a friction to a live runtime session without a prior
   * `friction-log import`. Defaults: started_at = now, adapter =
   * 'manual' (mirrors `frictions.source = 'manual'` for log-path rows).
   * Idempotent: a subsequent `upsertSession` from an `import` or `scan`
   * later overwrites the placeholder with full metadata.
   */
  ensureSession(id: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, started_at, adapter)
         VALUES (?, ?, ?)`
      )
      .run(id, new Date().toISOString(), 'manual');
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  insertFriction(input: InsertFrictionInput): Friction {
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    // recurrence_of_id semantics (M3 cheap rule): explicit value wins, else
    // auto-link to the oldest open root friction with the same tool_surface
    // and title. The chain always points to a root, so callers reading
    // recurrence_of_id see a stable parent.
    const recurrenceOfId =
      input.recurrenceOfId ?? this.findRecurrenceRoot(input.toolSurface ?? null, input.title);
    const result = this.db
      .prepare(
        `INSERT INTO frictions
           (session_id, tool_surface, title, description, captured_at, severity, category, source, recurrence_of_id)
         VALUES (@sessionId, @toolSurface, @title, @description, @capturedAt, @severity, @category, @source, @recurrenceOfId)`
      )
      .run({
        sessionId: input.sessionId ?? null,
        toolSurface: input.toolSurface ?? null,
        title: input.title,
        description: input.description ?? null,
        capturedAt,
        severity: input.severity ?? null,
        category: input.category ?? null,
        source: input.source,
        recurrenceOfId,
      });
    return this.getFriction(Number(result.lastInsertRowid))!;
  }

  findRecurrenceRoot(toolSurface: string | null, title: string): number | null {
    if (!title) return null;
    const row = this.db
      .prepare(
        `SELECT id FROM frictions
         WHERE status = 'open'
           AND recurrence_of_id IS NULL
           AND title = @title
           AND coalesce(tool_surface, '') = coalesce(@toolSurface, '')
         ORDER BY captured_at ASC
         LIMIT 1`
      )
      .get({ title, toolSurface: toolSurface ?? null }) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  getFriction(id: number): Friction | null {
    const row = this.db.prepare(`SELECT * FROM frictions WHERE id = ?`).get(id) as
      | FrictionRow
      | undefined;
    return row ? rowToFriction(row) : null;
  }

  updateFrictionStatus(id: number, status: FrictionStatus): void {
    this.db.prepare(`UPDATE frictions SET status = ? WHERE id = ?`).run(status, id);
  }

  deleteFriction(id: number): boolean {
    const tx = this.db.transaction((fid: number) => {
      this.db.prepare(`DELETE FROM tasks WHERE friction_id = ?`).run(fid);
      this.db.prepare(`DELETE FROM tags WHERE friction_id = ?`).run(fid);
      return this.db.prepare(`DELETE FROM frictions WHERE id = ?`).run(fid).changes > 0;
    });
    return tx(id);
  }

  findFrictionByTriple(sessionId: string | null, toolSurface: string | null, title: string): Friction | null {
    const row = this.db
      .prepare(
        `SELECT * FROM frictions
         WHERE coalesce(session_id, '') = coalesce(@sessionId, '')
           AND coalesce(tool_surface, '') = coalesce(@toolSurface, '')
           AND title = @title
         LIMIT 1`
      )
      .get({ sessionId: sessionId ?? null, toolSurface: toolSurface ?? null, title }) as
      | FrictionRow
      | undefined;
    return row ? rowToFriction(row) : null;
  }

  listFrictionsForSession(sessionId: string): Friction[] {
    const rows = this.db
      .prepare(`SELECT * FROM frictions WHERE session_id = ? ORDER BY captured_at ASC`)
      .all(sessionId) as FrictionRow[];
    return rows.map(rowToFriction);
  }

  getMostRecentSession(): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions ORDER BY coalesce(ended_at, started_at) DESC LIMIT 1`)
      .get() as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listFrictions(filter: ListFrictionsFilter = {}): Friction[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      where.push(`status = @status`);
      params.status = filter.status;
    }
    if (filter.tool) {
      where.push(`tool_surface = @tool`);
      params.tool = filter.tool;
    }
    if (filter.category) {
      where.push(`category = @category`);
      params.category = filter.category;
    }
    if (filter.source) {
      where.push(`source = @source`);
      params.source = filter.source;
    }
    if (filter.sinceIso) {
      where.push(`captured_at >= @sinceIso`);
      params.sinceIso = filter.sinceIso;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rawLimit = filter.limit ?? 100;
    const limit = Math.max(1, Math.min(10_000, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100));
    params.limit = limit;
    const rows = this.db
      .prepare(`SELECT * FROM frictions ${whereSql} ORDER BY captured_at DESC LIMIT @limit`)
      .all(params) as FrictionRow[];
    return rows.map(rowToFriction);
  }

  insertTask(input: InsertTaskInput): Task {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO tasks (friction_id, sink_name, sink_target, external_ref, pr_url, resolution_status, created_at)
         VALUES (@frictionId, @sinkName, @sinkTarget, @externalRef, @prUrl, @resolutionStatus, @createdAt)`
      )
      .run({
        frictionId: input.frictionId,
        sinkName: input.sinkName,
        sinkTarget: input.sinkTarget ?? null,
        externalRef: input.externalRef ?? null,
        prUrl: input.prUrl ?? null,
        resolutionStatus: input.resolutionStatus ?? null,
        createdAt,
      });
    return this.getTask(Number(result.lastInsertRowid))!;
  }

  getTask(id: number): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasksForFriction(frictionId: number): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE friction_id = ? ORDER BY created_at ASC`)
      .all(frictionId) as TaskRow[];
    return rows.map(rowToTask);
  }

  addTag(frictionId: number, tag: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO tags (friction_id, tag) VALUES (?, ?)`).run(frictionId, tag);
  }

  tagsFor(frictionId: number): string[] {
    const rows = this.db
      .prepare(`SELECT tag FROM tags WHERE friction_id = ? ORDER BY tag`)
      .all(frictionId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  searchFrictions(query: string, filter: ListFrictionsFilter = {}): Friction[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const where: string[] = [`frictions_fts MATCH @query`];
    const params: Record<string, unknown> = { query: trimmed };
    if (filter.status) {
      where.push(`f.status = @status`);
      params.status = filter.status;
    }
    if (filter.tool) {
      where.push(`f.tool_surface = @tool`);
      params.tool = filter.tool;
    }
    if (filter.category) {
      where.push(`f.category = @category`);
      params.category = filter.category;
    }
    if (filter.source) {
      where.push(`f.source = @source`);
      params.source = filter.source;
    }
    if (filter.sinceIso) {
      where.push(`f.captured_at >= @sinceIso`);
      params.sinceIso = filter.sinceIso;
    }
    const rawLimit = filter.limit ?? 100;
    const limit = Math.max(1, Math.min(10_000, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100));
    params.limit = limit;
    const sql = `
      SELECT f.* FROM frictions f
      JOIN frictions_fts fts ON fts.rowid = f.id
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT @limit
    `;
    const rows = this.db.prepare(sql).all(params) as FrictionRow[];
    return rows.map(rowToFriction);
  }

  digest(groupBy: DigestGroupBy, sinceIso?: string): DigestRow[] {
    const columnByGroup: Record<DigestGroupBy, string> = {
      tool: 'tool_surface',
      category: 'category',
      severity: 'severity',
      source: 'source',
    };
    const column = columnByGroup[groupBy];
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (sinceIso) {
      where.push(`f.captured_at >= @sinceIso`);
      params.sinceIso = sinceIso;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Subquery picks each friction's earliest task creation, then we compute
    // hours from captured_at to that first sink-file event ("time to triage").
    // Frictions never filed contribute NULL and are excluded from the average.
    const sql = `
      SELECT
        coalesce(f.${column}, '(unset)') AS grp,
        count(*) AS total,
        sum(CASE WHEN f.status = 'open'     THEN 1 ELSE 0 END) AS open_count,
        sum(CASE WHEN f.status = 'filed'    THEN 1 ELSE 0 END) AS filed_count,
        sum(CASE WHEN f.status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
        sum(CASE WHEN f.status = 'wontfix'  THEN 1 ELSE 0 END) AS wontfix_count,
        sum(CASE WHEN f.recurrence_of_id IS NOT NULL THEN 1 ELSE 0 END) AS recurrences,
        avg(
          CASE
            WHEN t.first_created IS NOT NULL
            THEN (julianday(t.first_created) - julianday(f.captured_at)) * 24.0
          END
        ) AS avg_hours_to_triage
      FROM frictions f
      LEFT JOIN (
        SELECT friction_id, min(created_at) AS first_created
        FROM tasks
        GROUP BY friction_id
      ) t ON t.friction_id = f.id
      ${whereSql}
      GROUP BY grp
      ORDER BY total DESC, grp ASC
    `;
    const rows = this.db.prepare(sql).all(params) as Array<{
      grp: string;
      total: number;
      open_count: number;
      filed_count: number;
      resolved_count: number;
      wontfix_count: number;
      recurrences: number;
      avg_hours_to_triage: number | null;
    }>;
    return rows.map((r) => ({
      group: r.grp,
      total: r.total,
      open: r.open_count,
      filed: r.filed_count,
      resolved: r.resolved_count,
      wontfix: r.wontfix_count,
      recurrences: r.recurrences,
      avgHoursToTriage: r.avg_hours_to_triage,
    }));
  }

  close(): void {
    this.db.close();
  }
}
