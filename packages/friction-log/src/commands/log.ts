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
    const insert: InsertFrictionInput = {
      title: input.title,
      description: input.description ?? null,
      toolSurface: input.tool ?? null,
      category: input.category ?? null,
      severity: input.severity ?? null,
      sessionId: input.sessionId ?? null,
      recurrenceOfId: input.recurrenceOfId ?? null,
      source: 'manual',
    };
    const f = db.insertFriction(insert);
    return { id: f.id, capturedAt: f.capturedAt, recurrenceOfId: f.recurrenceOfId };
  } finally {
    db.close();
  }
}
