import { FrictionDb, type InsertFrictionInput } from '../db.js';
import { defaultDbPath } from '../paths.js';
import type { Severity } from '../types.js';

export interface LogCommandInput {
  title: string;
  description?: string;
  tool?: string;
  category?: string;
  severity?: Severity;
  sessionId?: string;
  recurrenceOfId?: number;
  dbPath?: string;
}

export interface LogCommandOutput {
  id: number;
  capturedAt: string;
  recurrenceOfId: number | null;
}

export function runLog(input: LogCommandInput): LogCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    if (input.recurrenceOfId !== undefined) {
      const parent = db.getFriction(input.recurrenceOfId);
      if (!parent) {
        throw new Error(`friction-log: --recurrence-of ${input.recurrenceOfId} does not match any friction`);
      }
    }
    // Normalise empty string to null so a `--session ''` (or a wrapper
    // that always passes the flag with a possibly-empty value) does not
    // sneak past the upsert and then trip the FK on the friction insert.
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId !== ''
        ? input.sessionId
        : null;
    // Sessions row must exist before the friction insert, otherwise the
    // frictions.session_id FK violates and the log path exits 1 with a
    // raw SQLite error. The common case is an agent attributing a
    // mid-session friction to its live runtime session id (e.g.
    // $CLAUDE_CODE_SESSION_ID) which was never imported. Upsert a
    // placeholder so the call just works; a later `friction-log import`
    // or `scan` overwrites it with full metadata via `upsertSession`.
    if (sessionId !== null) {
      db.ensureSession(sessionId);
    }
    const insert: InsertFrictionInput = {
      title: input.title,
      description: input.description ?? null,
      toolSurface: input.tool ?? null,
      category: input.category ?? null,
      severity: input.severity ?? null,
      sessionId,
      recurrenceOfId: input.recurrenceOfId ?? null,
      source: 'manual',
    };
    const f = db.insertFriction(insert);
    return { id: f.id, capturedAt: f.capturedAt, recurrenceOfId: f.recurrenceOfId };
  } finally {
    db.close();
  }
}
