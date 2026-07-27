import { loadConfig } from '../config.js';
import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { maybeSyncExport } from './sync-export.js';
import type { FrictionStatus } from '../types.js';

export interface UpdateCommandInput {
  frictionId: number;
  status: FrictionStatus;
  dbPath?: string;
  configPath?: string;
}

export interface UpdateCommandOutput {
  id: number;
  status: FrictionStatus;
}

export function runUpdate(input: UpdateCommandInput): UpdateCommandOutput {
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = new FrictionDb(dbPath);
  try {
    const friction = db.getFriction(input.frictionId);
    if (!friction) {
      throw new Error(`friction-log: friction id=${input.frictionId} not found`);
    }
    db.updateFrictionStatus(input.frictionId, input.status);
    const config = loadConfig(input.configPath);
    maybeSyncExport({ dbPath, config });
    return { id: input.frictionId, status: input.status };
  } finally {
    db.close();
  }
}
