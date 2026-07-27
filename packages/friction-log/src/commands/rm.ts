import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { maybeSyncExport } from './sync-export.js';

export interface RmCommandInput {
  frictionId: number;
  dbPath?: string;
  configPath?: string;
}

export interface RmCommandOutput {
  removed: boolean;
}

export function runRm(input: RmCommandInput): RmCommandOutput {
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = new FrictionDb(dbPath);
  try {
    const friction = db.getFriction(input.frictionId);
    if (!friction) {
      throw new Error(`friction-log: friction id=${input.frictionId} not found`);
    }
    const removed = db.deleteFriction(input.frictionId);
    if (removed) {
      maybeSyncExport({ dbPath, configPath: input.configPath });
    }
    return { removed };
  } finally {
    db.close();
  }
}
