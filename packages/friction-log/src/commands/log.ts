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
  dbPath?: string;
}

export interface LogCommandOutput {
  id: number;
  capturedAt: string;
}

export function runLog(input: LogCommandInput): LogCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const insert: InsertFrictionInput = {
      title: input.title,
      description: input.description ?? null,
      toolSurface: input.tool ?? null,
      category: input.category ?? null,
      severity: input.severity ?? null,
      sessionId: input.sessionId ?? null,
      source: 'manual',
    };
    const f = db.insertFriction(insert);
    return { id: f.id, capturedAt: f.capturedAt };
  } finally {
    db.close();
  }
}
