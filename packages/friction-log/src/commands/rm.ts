import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';

export interface RmCommandInput {
  frictionId: number;
  dbPath?: string;
}

export interface RmCommandOutput {
  removed: boolean;
}

export function runRm(input: RmCommandInput): RmCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const friction = db.getFriction(input.frictionId);
    if (!friction) {
      throw new Error(`friction-log: friction id=${input.frictionId} not found`);
    }
    const removed = db.deleteFriction(input.frictionId);
    return { removed };
  } finally {
    db.close();
  }
}
