import { FrictionDb, type InsertFrictionInput } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { loadScanner } from '../scanners/index.js';
import { maybeSyncExport } from './sync-export.js';
import type { Friction } from '../types.js';

export interface ScanCommandInput {
  sessionId?: string;
  transcriptPath?: string;
  adapter?: string;
  dbPath?: string;
  configPath?: string;
}

export interface ScanCommandOutput {
  sessionId: string;
  candidatesFound: number;
  inserted: number;
  skippedDuplicates: number;
  adapter: string;
}

export async function runScan(input: ScanCommandInput): Promise<ScanCommandOutput> {
  const adapterName = input.adapter ?? 'claude-code';
  const scanner = loadScanner(adapterName);
  const result = await scanner.scan({
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
  });

  const dbPath = input.dbPath ?? defaultDbPath();
  const db = new FrictionDb(dbPath);
  try {
    db.upsertSession({
      id: result.session.id,
      startedAt: result.session.startedAt,
      endedAt: result.session.endedAt,
      projectPaths: result.session.projectPaths ?? null,
      transcriptPath: result.session.transcriptPath ?? null,
      adapter: result.session.adapter ?? adapterName,
    });

    let inserted = 0;
    let skipped = 0;
    for (const c of result.frictionCandidates) {
      const existing = db.findFrictionByTriple(result.session.id, c.toolSurface ?? null, c.title);
      if (existing) {
        skipped++;
        continue;
      }
      const insert: InsertFrictionInput = {
        sessionId: result.session.id,
        toolSurface: c.toolSurface ?? null,
        title: c.title,
        description: c.description ?? null,
        severity: c.severity ?? null,
        category: c.category ?? null,
        source: 'scan',
      };
      db.insertFriction(insert);
      inserted++;
    }

    // Skip write-through entirely when nothing was actually inserted (all
    // candidates were duplicates, or there were none): the export payload
    // only carries frictions, so a session-only upsert with zero new
    // frictions can never change its content anyway.
    if (inserted > 0) {
      maybeSyncExport({ dbPath, configPath: input.configPath });
    }

    return {
      sessionId: result.session.id,
      candidatesFound: result.frictionCandidates.length,
      inserted,
      skippedDuplicates: skipped,
      adapter: adapterName,
    };
  } finally {
    db.close();
  }
}

export interface StopHookPayload {
  session_id?: string;
  sessionId?: string;
  transcript_path?: string;
  transcriptPath?: string;
}

export function payloadToScanInput(payload: StopHookPayload, adapter?: string): ScanCommandInput {
  return {
    sessionId: payload.session_id ?? payload.sessionId,
    transcriptPath: payload.transcript_path ?? payload.transcriptPath,
    adapter,
  };
}

export function summarize(output: ScanCommandOutput, sessionId: string): string {
  return (
    `scanned session=${sessionId} adapter=${output.adapter} ` +
    `candidates=${output.candidatesFound} inserted=${output.inserted} skipped=${output.skippedDuplicates}`
  );
}

export { Friction };
