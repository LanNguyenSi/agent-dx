import { FrictionDb, type InsertFrictionInput } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { loadScanner } from '../scanners/index.js';
import type { Friction } from '../types.js';

export interface ScanCommandInput {
  sessionId?: string;
  transcriptPath?: string;
  adapter?: string;
  dbPath?: string;
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

  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
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
