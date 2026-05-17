import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';
import type { FrictionStatus } from '../types.js';

export interface UpdateCommandInput {
  frictionId: number;
  status: FrictionStatus;
  dbPath?: string;
}

export interface UpdateCommandOutput {
  id: number;
  status: FrictionStatus;
}

export function runUpdate(input: UpdateCommandInput): UpdateCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const friction = db.getFriction(input.frictionId);
    if (!friction) {
      throw new Error(`friction-log: friction id=${input.frictionId} not found`);
    }
    db.updateFrictionStatus(input.frictionId, input.status);
    return { id: input.frictionId, status: input.status };
  } finally {
    db.close();
  }
}
