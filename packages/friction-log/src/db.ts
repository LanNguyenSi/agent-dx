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

    for (const m of MIGRATIONS) {
      if (m.version <= currentVersion) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`)
          .run(m.version, new Date().toISOString());
      })();
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

  getSession(id: string): Session | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  insertFriction(input: InsertFrictionInput): Friction {
    const capturedAt = input.capturedAt ?? new Date().toISOString();
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
        recurrenceOfId: input.recurrenceOfId ?? null,
      });
    return this.getFriction(Number(result.lastInsertRowid))!;
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
    const limit = filter.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM frictions ${whereSql} ORDER BY captured_at DESC LIMIT ${limit}`)
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

  close(): void {
    this.db.close();
  }
}
